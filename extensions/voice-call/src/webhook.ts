import { spawn } from "node:child_process";
import http from "node:http";
import { URL } from "node:url";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "openclaw/plugin-sdk";
import { WebSocket, WebSocketServer } from "ws";
import { normalizePhoneNumber } from "./allowlist.js";
import type { VoiceCallConfig } from "./config.js";
import { loadContactsFileAsync } from "./contact-file.js";
import type { CoreConfig } from "./core-bridge.js";
import type { CallManager } from "./manager.js";
import type { MediaStreamConfig } from "./media-stream.js";
import { MediaStreamHandler } from "./media-stream.js";
import type { VoiceCallProvider } from "./providers/base.js";
import { OpenAIRealtimeSTTProvider } from "./providers/stt-openai-realtime.js";
import type { TwilioProvider } from "./providers/twilio.js";
import {
  generateGreetingText,
  localPathToPublicUrl,
  maybeGenerateHostedAudioUrl,
} from "./response-generator.js";
import { generateStreamingVoiceResponse } from "./streaming-response.js";
import { TerminalStates, type NormalizedEvent, type WebhookContext } from "./types.js";
import { startStaleCallReaper } from "./webhook/stale-call-reaper.js";

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

/**
 * HTTP server for receiving voice call webhooks from providers.
 * Supports WebSocket upgrades for media streams when streaming is enabled.
 */
export class VoiceCallWebhookServer {
  private server: http.Server | null = null;
  private config: VoiceCallConfig;
  private manager: CallManager;
  private provider: VoiceCallProvider;
  private coreConfig: CoreConfig | null;
  private stopStaleCallReaper: (() => void) | null = null;

  /** Media stream handler for bidirectional audio (when streaming enabled) */
  private mediaStreamHandler: MediaStreamHandler | null = null;
  private inFlightAutoResponses = new Set<string>();
  private pendingAutoResponses = new Map<string, string>();
  /** Provider call IDs currently playing initial greeting — transcripts are discarded to avoid echo */
  private greetingCalls = new Set<string>();
  /** Pre-generated audio URLs for inbound contact greetings, keyed by normalised phone digits */
  private preGeneratedGreetingUrls = new Map<string, string>();
  /** Pre-generated farewell audio URL ("好的，拜拜。") so end-call can play instantly */
  private cachedFarewellAudioUrl: string | undefined;
  /** Gather mode: polling timers for detecting inbound call hangup */
  private gatherCallPollers = new Map<string, ReturnType<typeof setInterval>>();
  /** ConversationRelay: WebSocket server for CR connections */
  private crWss: WebSocketServer | null = null;
  /** ConversationRelay: active WebSocket connections keyed by providerCallId (callSid) */
  private crConnections = new Map<string, WebSocket>();
  /** ConversationRelay: abort controllers for in-flight LLM runs, keyed by callId */
  private crAbortControllers = new Map<string, AbortController>();
  /** Pre-generated greeting texts (for ConversationRelay welcomeGreeting), keyed by normalised phone */
  private preGeneratedGreetingTexts = new Map<string, string>();

  constructor(
    config: VoiceCallConfig,
    manager: CallManager,
    provider: VoiceCallProvider,
    coreConfig?: CoreConfig,
  ) {
    this.config = config;
    this.manager = manager;
    this.provider = provider;
    this.coreConfig = coreConfig ?? null;

    // Initialize media stream handler if streaming is enabled
    if (config.streaming?.enabled) {
      this.initializeMediaStreaming();
    }
  }

  /**
   * Get the media stream handler (for wiring to provider).
   */
  getMediaStreamHandler(): MediaStreamHandler | null {
    return this.mediaStreamHandler;
  }

  /**
   * WORKFLOW_AUTO: Pre-generate inbound greeting audio per contact so inbound
   * calls can play it instantly via WebSocket streaming.  Reads VOICE_CONTACTS.md
   * from the workspace directory; falls back to the global `inboundGreeting` if
   * no contacts file is present.  Fire-and-forget — failures are non-fatal.
   */
  preGenerateInboundGreeting(): void {
    if (!this.coreConfig) {
      return;
    }
    void (async () => {
      try {
        const contacts = await loadContactsFileAsync();

        // If no contacts file, fall back to the global greeting
        if (contacts.length === 0) {
          const globalGreeting = this.config.inboundGreeting;
          if (!globalGreeting) return;
          // Store text for ConversationRelay welcomeGreeting
          this.preGeneratedGreetingTexts.set("__global__", globalGreeting);
          const url = await maybeGenerateHostedAudioUrl({
            text: globalGreeting,
            coreConfig: this.coreConfig!,
            voiceConfig: this.config,
          });
          if (url) {
            this.preGeneratedGreetingUrls.set("__global__", url);
            console.log(`[voice-call] Pre-generated global inbound greeting audio: ${url}`);
          }
          return;
        }

        const start = Date.now();
        let count = 0;
        for (const contact of contacts) {
          const template = contact.greeting ?? this.config.inboundGreeting;
          // Static fallback: substitute {name} in template
          const staticText = template
            ? contact.name
              ? template.replace(/\{name\}/g, contact.name)
              : template.replace(/\s*\{name\}\s*/g, " ").trim()
            : undefined;
          try {
            // Ask LLM to generate the greeting using VOICE_SYSTEM_PROMPT as style guide
            const llmText = await generateGreetingText({
              voiceConfig: this.config,
              coreConfig: this.coreConfig!,
              from: contact.phone,
              callerName: contact.name,
              greetingHint: template,
              callerInfo: contact.info,
            });
            const finalText = llmText ?? staticText;
            if (!finalText) continue;
            // Store greeting text for ConversationRelay welcomeGreeting
            {
              const key = normalizePhoneNumber(contact.phone);
              if (key) {
                this.preGeneratedGreetingTexts.set(key, finalText);
              }
            }
            const url = await maybeGenerateHostedAudioUrl({
              text: finalText,
              coreConfig: this.coreConfig!,
              voiceConfig: this.config,
            });
            if (url) {
              const key = normalizePhoneNumber(contact.phone);
              if (key) {
                this.preGeneratedGreetingUrls.set(key, url);
                count++;
              }
            }
          } catch (err) {
            console.warn(
              `[voice-call] Failed to pre-generate greeting for ${contact.name}:`,
              err instanceof Error ? err.message : String(err),
            );
          }
        }
        // Also pre-generate the farewell audio so end-call plays instantly
        try {
          const farewellUrl = await maybeGenerateHostedAudioUrl({
            text: "好的，拜拜。",
            coreConfig: this.coreConfig!,
            voiceConfig: this.config,
          });
          if (farewellUrl) {
            this.cachedFarewellAudioUrl = farewellUrl;
            console.log(`[voice-call] Pre-generated farewell audio: ${farewellUrl}`);
          }
        } catch (err) {
          console.warn(`[voice-call] Failed to pre-generate farewell audio:`, err);
        }

        const ms = Date.now() - start;
        console.log(`[voice-call] Pre-generated ${count} contact greeting(s) in ${ms}ms`);
      } catch (err) {
        console.warn(
          `[voice-call] Failed to pre-generate inbound greetings:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    })();
  }

  /**
   * Initialize media streaming with OpenAI Realtime STT.
   */
  private initializeMediaStreaming(): void {
    const apiKey = this.config.streaming?.openaiApiKey || process.env.OPENAI_API_KEY;

    if (!apiKey) {
      console.warn("[voice-call] Streaming enabled but no OpenAI API key found");
      return;
    }

    const sttProvider = new OpenAIRealtimeSTTProvider({
      apiKey,
      model: this.config.streaming?.sttModel,
      silenceDurationMs: this.config.streaming?.silenceDurationMs,
      vadThreshold: this.config.streaming?.vadThreshold,
    });

    const streamConfig: MediaStreamConfig = {
      sttProvider,
      preStartTimeoutMs: this.config.streaming?.preStartTimeoutMs,
      maxPendingConnections: this.config.streaming?.maxPendingConnections,
      maxPendingConnectionsPerIp: this.config.streaming?.maxPendingConnectionsPerIp,
      maxConnections: this.config.streaming?.maxConnections,
      shouldAcceptStream: ({ callId, token }) => {
        const call = this.manager.getCallByProviderCallId(callId);
        if (!call) {
          return false;
        }
        if (this.provider.name === "twilio") {
          const twilio = this.provider as TwilioProvider;
          if (!twilio.isValidStreamToken(callId, token)) {
            console.warn(`[voice-call] Rejecting media stream: invalid token for ${callId}`);
            return false;
          }
        }
        return true;
      },
      onTranscript: (providerCallId, transcript) => {
        console.log(`[voice-call] Transcript for ${providerCallId}: ${transcript}`);

        // Clear TTS queue on barge-in (user started speaking, interrupt current playback)
        if (this.provider.name === "twilio") {
          (this.provider as TwilioProvider).clearTtsQueue(providerCallId);
        }

        // Discard transcripts during initial greeting playback — they are
        // echo of the bot's own voice picked up by Twilio before AEC warms up.
        if (this.greetingCalls.has(providerCallId)) {
          console.log(
            `[voice-call] Discarding echo transcript during greeting for ${providerCallId}: "${transcript}"`,
          );
          return;
        }

        // Look up our internal call ID from the provider call ID
        const call = this.manager.getCallByProviderCallId(providerCallId);
        if (!call) {
          console.warn(`[voice-call] No active call found for provider ID: ${providerCallId}`);
          return;
        }

        // Create a speech event and process it through the manager
        const event: NormalizedEvent = {
          id: `stream-transcript-${Date.now()}`,
          type: "call.speech",
          callId: call.callId,
          providerCallId,
          timestamp: Date.now(),
          transcript,
          isFinal: true,
        };
        this.manager.processEvent(event);

        // Auto-respond in conversation mode (inbound always, outbound if mode is conversation)
        const callMode = call.metadata?.mode as string | undefined;
        const shouldRespond = call.direction === "inbound" || callMode === "conversation";
        if (shouldRespond) {
          this.enqueueInboundResponse(call.callId, transcript);
        }
      },
      onSpeechStart: (providerCallId) => {
        if (this.provider.name === "twilio") {
          (this.provider as TwilioProvider).clearTtsQueue(providerCallId);
        }
        // If user barges in during greeting, stop discarding transcripts
        // so the follow-up real transcript is processed normally.
        if (this.greetingCalls.has(providerCallId)) {
          console.log(
            `[voice-call] Barge-in during greeting for ${providerCallId}, resuming transcript processing`,
          );
          this.greetingCalls.delete(providerCallId);
        }
      },
      onPartialTranscript: (providerCallId, partial) => {
        console.log(`[voice-call] Partial for ${providerCallId}: ${partial}`);
      },
      onConnect: (callId, streamSid) => {
        console.log(`[voice-call] Media stream connected: ${callId} -> ${streamSid}`);
        // Register stream with provider for TTS routing
        if (this.provider.name === "twilio") {
          (this.provider as TwilioProvider).registerCallStream(callId, streamSid);
        }

        // WORKFLOW_AUTO: For inbound calls, handle state transitions and
        // inject pre-generated greeting audio for instant playback.
        const call = this.manager.getCallByProviderCallId(callId);
        if (call && call.direction === "inbound") {
          // Twilio doesn't reliably send status-callback "in-progress" for
          // inbound calls, so synthesize a call.answered event when the
          // media stream connects (definitive proof the call is active).
          if (call.state === "ringing") {
            const answeredEvent: NormalizedEvent = {
              id: `stream-answered-${Date.now()}`,
              type: "call.answered" as const,
              callId: call.callId,
              providerCallId: callId,
              timestamp: Date.now(),
            };
            this.manager.processEvent(answeredEvent);
          }

          // Inject pre-generated greeting audio so speakInitialMessage can
          // stream it instantly instead of waiting for real-time TTS.
          const callerKey = normalizePhoneNumber(call.from);
          const greetingUrl =
            this.preGeneratedGreetingUrls.get(callerKey) ??
            this.preGeneratedGreetingUrls.get("__global__");
          if (greetingUrl && call.metadata) {
            call.metadata.initialMessageAudioUrl = greetingUrl;
          }
        }

        // Speak initial message if one was provided when call was initiated
        // Use setTimeout to allow stream setup to complete
        this.greetingCalls.add(callId);
        setTimeout(async () => {
          try {
            await this.manager.speakInitialMessage(callId);
          } catch (err) {
            console.warn(`[voice-call] Failed to speak initial message:`, err);
          } finally {
            // Keep discarding echo transcripts for a short buffer after greeting
            // finishes, then resume normal transcript processing.
            setTimeout(() => {
              if (this.greetingCalls.has(callId)) {
                this.greetingCalls.delete(callId);
                console.log(
                  `[voice-call] Greeting done, resuming transcript processing for ${callId}`,
                );
              }
            }, 1000);
          }
        }, 500);
      },
      onDisconnect: (callId) => {
        console.log(`[voice-call] Media stream disconnected: ${callId}`);
        if (this.provider.name === "twilio") {
          // Twilio stream disconnects can happen during mid-call TwiML updates
          // (e.g., Play/Redirect). Do not auto-end outbound calls on disconnect.
          (this.provider as TwilioProvider).unregisterCallStream(callId);

          // WORKFLOW_AUTO: For inbound calls, stream disconnect means the caller
          // hung up. Twilio doesn't reliably deliver a completion webhook for
          // inbound calls, so we end the call after a short grace period.
          const disconnectedCall = this.manager.getCallByProviderCallId(callId);
          if (disconnectedCall && disconnectedCall.direction === "inbound") {
            setTimeout(() => {
              const current = this.manager.getCall(disconnectedCall.callId);
              if (current && !TerminalStates.has(current.state)) {
                console.log(
                  `[voice-call] Auto-ending inbound call ${disconnectedCall.callId} after stream disconnect`,
                );
                void this.manager.endCall(disconnectedCall.callId).catch((err) => {
                  console.warn(
                    `[voice-call] Failed to auto-end inbound call ${disconnectedCall.callId}:`,
                    err,
                  );
                });
              }
            }, 2000);
          }
          return;
        }

        // For non-Twilio providers, keep the previous safety behavior.
        const disconnectedCall = this.manager.getCallByProviderCallId(callId);
        if (disconnectedCall) {
          console.log(
            `[voice-call] Auto-ending call ${disconnectedCall.callId} on stream disconnect`,
          );
          void this.manager.endCall(disconnectedCall.callId).catch((err) => {
            console.warn(`[voice-call] Failed to auto-end call ${disconnectedCall.callId}:`, err);
          });
        }
      },
    };

    this.mediaStreamHandler = new MediaStreamHandler(streamConfig);
    console.log("[voice-call] Media streaming initialized");
  }

  /**
   * Start the webhook server.
   */
  async start(): Promise<string> {
    const { port, bind, path: webhookPath } = this.config.serve;
    const streamPath = this.config.streaming?.streamPath || "/voice/stream";

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res, webhookPath).catch((err) => {
          console.error("[voice-call] Webhook error:", err);
          res.statusCode = 500;
          res.end("Internal Server Error");
        });
      });

      // Handle WebSocket upgrades for media streams and ConversationRelay
      this.server.on("upgrade", (request, socket, head) => {
        const path = this.getUpgradePathname(request);
        if (path === streamPath && this.mediaStreamHandler) {
          console.log("[voice-call] WebSocket upgrade for media stream");
          this.mediaStreamHandler?.handleUpgrade(request, socket, head);
        } else if (path === "/voice/cr") {
          console.log("[voice-call] WebSocket upgrade for ConversationRelay");
          this.handleConversationRelayUpgrade(request, socket, head);
        } else {
          socket.destroy();
        }
      });

      this.server.on("error", reject);

      this.server.listen(port, bind, () => {
        const url = `http://${bind}:${port}${webhookPath}`;
        console.log(`[voice-call] Webhook server listening on ${url}`);
        if (this.mediaStreamHandler) {
          console.log(`[voice-call] Media stream WebSocket on ws://${bind}:${port}${streamPath}`);
        }
        console.log(`[voice-call] ConversationRelay WebSocket on ws://${bind}:${port}/voice/cr`);
        resolve(url);

        // Start the stale call reaper if configured
        this.stopStaleCallReaper = startStaleCallReaper({
          manager: this.manager,
          staleCallReaperSeconds: this.config.staleCallReaperSeconds,
        });
      });
    });
  }

  /**
   * Stop the webhook server.
   */
  async stop(): Promise<void> {
    if (this.stopStaleCallReaper) {
      this.stopStaleCallReaper();
      this.stopStaleCallReaper = null;
    }
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private getUpgradePathname(request: http.IncomingMessage): string | null {
    try {
      const host = request.headers.host || "localhost";
      return new URL(request.url || "/", `http://${host}`).pathname;
    } catch {
      return null;
    }
  }

  /**
   * Handle incoming HTTP request.
   */
  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    webhookPath: string,
  ): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    console.log(`[voice-call][webhook] ${req.method} ${req.url}`);

    // Check path
    if (!url.pathname.startsWith(webhookPath)) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }

    // Only accept POST
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end("Method Not Allowed");
      return;
    }

    // Read body
    let body = "";
    try {
      body = await this.readBody(req, MAX_WEBHOOK_BODY_BYTES);
    } catch (err) {
      if (isRequestBodyLimitError(err, "PAYLOAD_TOO_LARGE")) {
        res.statusCode = 413;
        res.end("Payload Too Large");
        return;
      }
      if (isRequestBodyLimitError(err, "REQUEST_BODY_TIMEOUT")) {
        res.statusCode = 408;
        res.end(requestBodyErrorToText("REQUEST_BODY_TIMEOUT"));
        return;
      }
      throw err;
    }

    // Build webhook context
    const ctx: WebhookContext = {
      headers: req.headers as Record<string, string | string[] | undefined>,
      rawBody: body,
      url: `http://${req.headers.host}${req.url}`,
      method: "POST",
      query: Object.fromEntries(url.searchParams),
      remoteAddress: req.socket.remoteAddress ?? undefined,
    };

    // Verify signature
    const verification = this.provider.verifyWebhook(ctx);
    if (!verification.ok) {
      console.warn(`[voice-call] Webhook verification failed: ${verification.reason}`);
      res.statusCode = 401;
      res.end("Unauthorized");
      return;
    }
    if (!verification.verifiedRequestKey) {
      console.warn("[voice-call] Webhook verification succeeded without request identity key");
      res.statusCode = 401;
      res.end("Unauthorized");
      return;
    }

    // Parse events
    const result = this.provider.parseWebhookEvent(ctx, {
      verifiedRequestKey: verification.verifiedRequestKey,
    });

    // Gather action callbacks carry identical bodies (same CallSid, CallStatus,
    // etc.) on every cycle, producing the same Twilio HMAC signature and thus
    // the same replay key.  They are NOT replays — each one is a new Gather
    // timeout/speech event — so we must exempt them from the replay filter.
    const isGatherActionCallback = url.searchParams.get("gatherAction") === "1";
    const treatAsReplay = verification.isReplay && !isGatherActionCallback;

    // Process each event
    if (treatAsReplay) {
      console.warn("[voice-call] Replay detected; skipping event side effects");
    } else {
      for (const event of result.events) {
        try {
          this.manager.processEvent(event);
          if (event.type === "call.ended") {
            this.pendingAutoResponses.delete(event.callId);
            this.inFlightAutoResponses.delete(event.callId);
            if (this.provider.name === "twilio" && event.providerCallId) {
              (this.provider as TwilioProvider).clearGatherQueue(event.providerCallId);
            }
            // Audio file cleanup is handled by the onCallEnded hook.
          }

          // Gather mode: process SpeechResult from <Gather> action webhook.
          // In stream mode, speech is handled by the onTranscript media-stream
          // callback instead, so this branch does not fire.
          if (
            event.type === "call.speech" &&
            (event as NormalizedEvent & { transcript?: string }).transcript &&
            this.provider.name === "twilio" &&
            (this.provider as TwilioProvider).isGatherMode
          ) {
            const call = this.manager.getCall(event.callId);
            if (call) {
              const callMode = call.metadata?.mode as string | undefined;
              const shouldRespond = call.direction === "inbound" || callMode === "conversation";
              if (shouldRespond) {
                const transcript = (event as NormalizedEvent & { transcript?: string }).transcript!;
                console.log(
                  `[voice-call][gather] SpeechResult for ${event.callId}: "${transcript}"`,
                );
                this.enqueueInboundResponse(event.callId, transcript);
              }
            }
          }
        } catch (err) {
          console.error(`[voice-call] Error processing event ${event.type}:`, err);
        }
      }
    }

    // ── ConversationRelay: embed welcomeGreeting in initial TwiML ────────
    if (
      this.provider.name === "twilio" &&
      (this.provider as TwilioProvider).isConversationRelayMode
    ) {
      for (const event of result.events) {
        if (event.type === "call.ringing") {
          const call = this.manager.getCall(event.callId);
          if (call && call.direction === "inbound") {
            const callerKey = normalizePhoneNumber(call.from);
            let greetingText =
              this.preGeneratedGreetingTexts.get(callerKey) ??
              this.preGeneratedGreetingTexts.get("__global__") ??
              this.config.inboundGreeting;
            // Strip emotion markers like [excited], [happy] etc. that ElevenLabs may not handle
            if (greetingText) {
              greetingText = greetingText.replace(/\[[\w-]+\]\s*/g, "").trim();
            }
            const twilio = this.provider as TwilioProvider;
            result.providerResponseBody = twilio.buildConversationRelayTwiml({
              welcomeGreeting: greetingText || undefined,
            });
            console.log(
              `[voice-call][cr] Embedded welcomeGreeting in initial TwiML for ${call.callId}: "${greetingText?.slice(0, 60)}"`,
            );
          }
        }
      }
    }

    // ── Gather mode: embed greeting in initial TwiML ──────────────────────
    // Instead of sending a bare <Gather> and doing a Call Update later,
    // inject the pre-generated greeting audio directly into the initial TwiML
    // response.  This guarantees Twilio plays it (no timing-dependent Call
    // Update needed).
    if (this.provider.name === "twilio" && (this.provider as TwilioProvider).isGatherMode) {
      for (const event of result.events) {
        if (event.type === "call.ringing") {
          const call = this.manager.getCall(event.callId);
          if (call && call.direction === "inbound" && event.providerCallId) {
            const callerKey = normalizePhoneNumber(call.from);
            const greetingLocalPath =
              this.preGeneratedGreetingUrls.get(callerKey) ??
              this.preGeneratedGreetingUrls.get("__global__");
            if (greetingLocalPath) {
              const publicUrl = localPathToPublicUrl(greetingLocalPath, this.config);
              if (publicUrl) {
                const twilio = this.provider as TwilioProvider;
                result.providerResponseBody = twilio.buildGatherPlayTwiml(
                  publicUrl,
                  event.providerCallId,
                  call.callId,
                  { speechTimeout: 3, timeout: 5 },
                );
                console.log(
                  `[voice-call][gather] Embedded greeting in initial TwiML for ${call.callId}: ${publicUrl}`,
                );
              }
            }
          }
        }
      }
    }

    // Log TwiML response for debugging
    if (result.providerResponseBody && result.providerResponseBody.includes("<")) {
      console.log(
        `[voice-call][webhook] TwiML response: ${result.providerResponseBody.replace(/\n/g, " ").substring(0, 300)}`,
      );
    }

    // Send response
    res.statusCode = result.statusCode || 200;

    if (result.providerResponseHeaders) {
      for (const [key, value] of Object.entries(result.providerResponseHeaders)) {
        res.setHeader(key, value);
      }
    }

    res.end(result.providerResponseBody || "OK");

    // Post-response: in Gather mode, synthesize call.answered and start poller.
    if (this.provider.name === "twilio" && (this.provider as TwilioProvider).isGatherMode) {
      for (const event of result.events) {
        if (event.type === "call.ringing") {
          const call = this.manager.getCall(event.callId);
          if (call && call.direction === "inbound") {
            // Synthesize call.answered — our <Gather> TwiML implicitly answers
            const answeredEvent: NormalizedEvent = {
              id: `gather-answered-${Date.now()}`,
              type: "call.answered" as const,
              callId: call.callId,
              providerCallId: event.providerCallId,
              timestamp: Date.now(),
            };
            this.manager.processEvent(answeredEvent);
            console.log(
              `[voice-call][gather] Synthesized call.answered for inbound ${call.callId}`,
            );

            // Start polling for call completion
            if (event.providerCallId) {
              this.startGatherCallPoller(call.callId, event.providerCallId);
            }
          }
        }
      }
    }
  }

  /**
   * Read request body as string with timeout protection.
   */
  private readBody(
    req: http.IncomingMessage,
    maxBytes: number,
    timeoutMs = 30_000,
  ): Promise<string> {
    return readRequestBodyWithLimit(req, { maxBytes, timeoutMs });
  }

  /**
   * Gather mode: play the pre-generated inbound greeting via Call Update.
   * Called after the initial <Gather> TwiML has been sent so Twilio has
   * answered the call and is in the listening state.
   */
  private async playGatherGreeting(
    callId: string,
    providerCallId: string,
    from: string,
  ): Promise<void> {
    // Short delay for Twilio to process our initial <Gather> TwiML
    await new Promise((resolve) => setTimeout(resolve, 800));

    const callerKey = normalizePhoneNumber(from);
    const greetingLocalPath =
      this.preGeneratedGreetingUrls.get(callerKey) ??
      this.preGeneratedGreetingUrls.get("__global__");
    if (!greetingLocalPath) {
      console.log(`[voice-call][gather] No pre-generated greeting for ${from}, skipping`);
      return;
    }

    const publicUrl = localPathToPublicUrl(greetingLocalPath, this.config);
    if (!publicUrl) {
      console.warn(`[voice-call][gather] Failed to convert greeting path to public URL`);
      return;
    }

    console.log(`[voice-call][gather] Playing greeting for ${callId}: ${publicUrl}`);

    // Queue and play via Gather mode (Call Update with <Gather><Play>...</Play></Gather>)
    const speakResult = await this.manager.speak(callId, "greeting", {
      audioUrl: publicUrl,
    });
    if (!speakResult.success) {
      console.warn(
        `[voice-call][gather] Failed to speak greeting for ${callId}: ${speakResult.error}`,
      );
      return;
    }

    // Mark sentence generation as done so the action URL chain returns
    // <Gather> for listening after the greeting finishes.
    (this.provider as TwilioProvider).markGatherSentencesDone(providerCallId, false);
  }

  /**
   * Gather mode: poll Twilio API every few seconds to detect when an inbound
   * call has ended.  Twilio doesn't send status callbacks for inbound calls
   * (no <Stream> disconnect either), so we must poll.
   */
  private startGatherCallPoller(callId: string, providerCallId: string): void {
    // Don't double-start
    if (this.gatherCallPollers.has(callId)) return;

    const POLL_INTERVAL_MS = 5000;
    const twilio = this.provider as TwilioProvider;

    const timer = setInterval(async () => {
      try {
        const call = this.manager.getCall(callId);
        if (!call || TerminalStates.has(call.state)) {
          // Already ended — stop polling
          this.stopGatherCallPoller(callId);
          return;
        }

        // Query Twilio for the call's current status
        const status = await twilio.getCallStatus(providerCallId);
        if (!status) return;

        if (
          status === "completed" ||
          status === "failed" ||
          status === "busy" ||
          status === "canceled" ||
          status === "no-answer"
        ) {
          console.log(
            `[voice-call][gather] Poller detected call ${callId} ended (status=${status})`,
          );
          this.stopGatherCallPoller(callId);

          // Synthesize call.ended event
          const endedEvent: NormalizedEvent = {
            id: `gather-ended-${Date.now()}`,
            type: "call.ended" as const,
            callId,
            providerCallId,
            timestamp: Date.now(),
            reason:
              status === "completed"
                ? "hangup-user"
                : status === "canceled"
                  ? "hangup-bot"
                  : (status as "failed" | "no-answer" | "busy"),
          };
          this.manager.processEvent(endedEvent);
          this.pendingAutoResponses.delete(callId);
          this.inFlightAutoResponses.delete(callId);
          twilio.clearGatherQueue(providerCallId);
        }
      } catch (err) {
        console.warn(
          `[voice-call][gather] Poller error for ${callId}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }, POLL_INTERVAL_MS);

    this.gatherCallPollers.set(callId, timer);
    console.log(
      `[voice-call][gather] Started call poller for ${callId} (every ${POLL_INTERVAL_MS}ms)`,
    );
  }

  private stopGatherCallPoller(callId: string): void {
    const timer = this.gatherCallPollers.get(callId);
    if (timer) {
      clearInterval(timer);
      this.gatherCallPollers.delete(callId);
    }
  }

  // ── ConversationRelay WebSocket handling ─────────────────────────────────

  /**
   * Handle WebSocket upgrade for ConversationRelay connections.
   */
  private handleConversationRelayUpgrade(
    request: http.IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ): void {
    if (!this.crWss) {
      this.crWss = new WebSocketServer({ noServer: true });
    }
    this.crWss.handleUpgrade(request, socket, head, (ws) => {
      this.handleConversationRelayConnection(ws);
    });
  }

  /**
   * Handle a new ConversationRelay WebSocket connection from Twilio.
   *
   * Protocol:
   * - Twilio sends: { type: "setup", callSid, streamSid, from, to, ... }
   * - Twilio sends: { type: "prompt", voicePrompt: "user said this" }
   * - Twilio sends: { type: "interrupt" }
   * - We send: { type: "text", token: "response text", last: true/false }
   */
  private handleConversationRelayConnection(ws: WebSocket): void {
    let callSid: string | null = null;
    let callId: string | null = null;

    console.log("[voice-call][cr] New ConversationRelay WebSocket connection");

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        console.log(`[voice-call][cr] Received: ${JSON.stringify(msg).slice(0, 300)}`);

        switch (msg.type) {
          case "setup":
            callSid = msg.callSid ?? null;
            if (!callSid) {
              console.warn("[voice-call][cr] setup message missing callSid");
              break;
            }

            // Register this WebSocket connection
            this.crConnections.set(callSid, ws);

            // Look up existing call record (created by the initial webhook POST)
            const call = this.manager.getCallByProviderCallId(callSid);
            if (call) {
              callId = call.callId;
              console.log(`[voice-call][cr] Linked CR session to call ${callId} (${callSid})`);

              // Synthesize call.answered if still ringing
              if (call.state === "ringing") {
                const answeredEvent: NormalizedEvent = {
                  id: `cr-answered-${Date.now()}`,
                  type: "call.answered" as const,
                  callId: call.callId,
                  providerCallId: callSid,
                  timestamp: Date.now(),
                };
                this.manager.processEvent(answeredEvent);
                console.log(`[voice-call][cr] Synthesized call.answered for ${callId}`);
              }
            } else {
              console.warn(`[voice-call][cr] No call record found for callSid ${callSid}`);
            }
            break;

          case "prompt": {
            const voicePrompt: string = msg.voicePrompt ?? "";
            if (!voicePrompt.trim()) break;
            if (!callId || !callSid) {
              console.warn("[voice-call][cr] prompt received before setup");
              break;
            }

            console.log(`[voice-call][cr] User said: "${voicePrompt}" (call ${callId})`);

            // Create speech event for the transcript
            const speechEvent: NormalizedEvent = {
              id: `cr-speech-${Date.now()}`,
              type: "call.speech",
              callId,
              providerCallId: callSid,
              timestamp: Date.now(),
              transcript: voicePrompt,
              isFinal: true,
            };
            this.manager.processEvent(speechEvent);

            // Queue LLM response
            this.enqueueInboundResponse(callId, voicePrompt);
            break;
          }

          case "interrupt": {
            console.log(`[voice-call][cr] Interrupt received for call ${callId}`);
            if (callId) {
              // Abort current LLM generation
              const controller = this.crAbortControllers.get(callId);
              if (controller) {
                controller.abort();
                this.crAbortControllers.delete(callId);
                console.log(`[voice-call][cr] Aborted LLM generation for ${callId}`);
              }
            }
            break;
          }

          case "dtmf": {
            console.log(`[voice-call][cr] DTMF digit: ${msg.digit} for call ${callId}`);
            // TODO: handle DTMF if needed
            break;
          }

          default:
            console.log(`[voice-call][cr] Unknown message type: ${msg.type}`);
        }
      } catch (err) {
        console.error("[voice-call][cr] Message parse error:", err);
      }
    });

    ws.on("close", (code, reason) => {
      console.log(`[voice-call][cr] WebSocket closed (code=${code}, reason=${reason?.toString()})`);
      if (callSid) {
        this.crConnections.delete(callSid);
      }
      if (callId) {
        this.crAbortControllers.delete(callId);
        // Synthesize call.ended
        const call = this.manager.getCall(callId);
        if (call && !TerminalStates.has(call.state)) {
          console.log(`[voice-call][cr] Synthesizing call.ended for ${callId}`);
          const endedEvent: NormalizedEvent = {
            id: `cr-ended-${Date.now()}`,
            type: "call.ended" as const,
            callId,
            providerCallId: callSid ?? "",
            timestamp: Date.now(),
            reason: "hangup-user",
          };
          this.manager.processEvent(endedEvent);
          this.pendingAutoResponses.delete(callId);
          this.inFlightAutoResponses.delete(callId);
        }
      }
    });

    ws.on("error", (err) => {
      console.error(`[voice-call][cr] WebSocket error:`, err);
    });
  }

  /**
   * Send a text message to Twilio ConversationRelay for TTS playback.
   */
  private crSendText(ws: WebSocket, token: string, last = false): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    const msg = last
      ? JSON.stringify({ type: "text", token, last: true })
      : JSON.stringify({ type: "text", token });
    ws.send(msg);
  }

  /**
   * Serialize auto-responses per call to avoid overlapping LLM runs.
   */
  private enqueueInboundResponse(callId: string, userMessage: string): void {
    const normalized = userMessage.trim();
    if (!normalized) {
      return;
    }

    this.pendingAutoResponses.set(callId, normalized);
    if (this.inFlightAutoResponses.has(callId)) {
      return;
    }

    this.inFlightAutoResponses.add(callId);
    void this.drainInboundResponseQueue(callId).finally(() => {
      this.inFlightAutoResponses.delete(callId);
      if (this.pendingAutoResponses.has(callId)) {
        this.enqueueInboundResponse(callId, this.pendingAutoResponses.get(callId) || "");
      }
    });
  }

  private async drainInboundResponseQueue(callId: string): Promise<void> {
    while (true) {
      const nextMessage = this.pendingAutoResponses.get(callId);
      if (!nextMessage) {
        return;
      }
      this.pendingAutoResponses.delete(callId);

      try {
        await this.handleInboundResponse(callId, nextMessage);
      } catch (err) {
        console.warn(`[voice-call] Failed to auto-respond:`, err);
      }
    }
  }

  /**
   * Handle auto-response for inbound calls using the agent system.
   *
   * Uses streaming LLM + incremental TTS: sentence-level chunks are sent to
   * TTS as they arrive from the LLM, so the first audio plays while the model
   * is still generating.  TAG detection ([END_CALL]) is handled by a buffering
   * layer that retains a small tail to avoid speaking control markers.
   *
   * Falls back to non-streaming generateVoiceResponse when streaming setup fails.
   */
  private async handleInboundResponse(callId: string, userMessage: string): Promise<void> {
    console.log(`[voice-call] Auto-responding to inbound call ${callId}: "${userMessage}"`);

    const call = this.manager.getCall(callId);
    if (!call) {
      console.warn(`[voice-call] Call ${callId} not found for auto-response`);
      return;
    }

    if (!this.coreConfig) {
      console.warn("[voice-call] Core config missing; skipping auto-response");
      return;
    }

    const otherPartyPhone = call.direction === "inbound" ? call.from : call.to;
    const voiceParams = {
      voiceConfig: this.config,
      coreConfig: this.coreConfig,
      callId,
      from: otherPartyPhone,
      callerName:
        typeof call.metadata?.callerName === "string" ? call.metadata.callerName : undefined,
      direction: call.direction as "inbound" | "outbound",
      transcript: call.transcript,
      userMessage,
      callReason:
        call.direction === "outbound" && typeof call.metadata?.initialMessage === "string"
          ? call.metadata.initialMessage.trim() || undefined
          : undefined,
    };

    try {
      const genStart = Date.now();
      let firstChunkSpoken = false;
      const spokenTexts: string[] = [];

      // Detect ConversationRelay mode: if we have an active CR WebSocket for this call
      const crWs = call.providerCallId ? this.crConnections.get(call.providerCallId) : undefined;
      const isCR = crWs && crWs.readyState === WebSocket.OPEN;

      // In Gather mode, determine if we need to convert local audio paths to public URLs
      const isGather =
        !isCR && this.provider.name === "twilio" && (this.provider as TwilioProvider).isGatherMode;
      const providerCallId = call?.providerCallId;

      if (isCR) {
        // ── ConversationRelay pipeline: stream text, no TTS ──────────────
        console.log(`[voice-call][cr] Starting text-only LLM response for ${callId}`);

        const result = await generateStreamingVoiceResponse(
          voiceParams,
          async (chunk) => {
            // Send each sentence as a text message (Twilio will TTS it)
            this.crSendText(crWs, chunk.text, false);
            spokenTexts.push(chunk.text);
            if (!firstChunkSpoken) {
              firstChunkSpoken = true;
              console.log(
                `[voice-call][cr] First text chunk sent for ${callId} (TTFA=${Date.now() - genStart}ms)`,
              );
            }
          },
          { skipTts: true },
        );

        const totalMs = Date.now() - genStart;

        if (result.error && !result.text) {
          console.error(
            `[voice-call][cr] Streaming response error (${totalMs}ms): ${result.error}`,
          );
          if (!firstChunkSpoken) {
            this.crSendText(crWs, "抱歉，我刚刚没来得及回答。请你再说一遍。", true);
          }
          return;
        }

        if (!result.text && !firstChunkSpoken) {
          this.crSendText(crWs, "抱歉，这个问题我暂时没法回答。你可以再换个问法。", true);
          return;
        }

        // Signal end of bot turn so Twilio resumes listening
        this.crSendText(crWs, "", true);

        console.log(
          `[voice-call][cr] Response complete for ${callId}: ${result.chunksStreamed} chunks, ` +
            `total=${totalMs}ms${result.endCall ? " [END_CALL]" : ""}`,
        );

        if (result.endCall) {
          console.log(
            `[voice-call][cr] LLM signaled [END_CALL] for ${callId}, hanging up in 4s...`,
          );
          await new Promise((resolve) => setTimeout(resolve, 4000));
          const endResult = await this.manager.endCall(callId);
          if (!endResult.success) {
            console.warn(`[voice-call][cr] Failed to end call ${callId}: ${endResult.error}`);
          }
        }
      } else {
        // ── Original pipeline: Gather mode or Media Streams ──────────────
        const result = await generateStreamingVoiceResponse(voiceParams, async (chunk) => {
          // In Gather mode: convert local audio path → public URL for <Play>
          let audioUrl = chunk.audioUrl;
          if (isGather && audioUrl) {
            const publicUrl = localPathToPublicUrl(audioUrl, this.config);
            if (publicUrl) {
              audioUrl = publicUrl;
            } else {
              console.warn(
                `[voice-call][gather] Failed to convert audio path to public URL: ${audioUrl}`,
              );
            }
          }

          // Each chunk arrives with text + audioUrl — speak them sequentially
          const speakResult = await this.manager.speak(callId, chunk.text, {
            audioUrl,
          });
          if (speakResult.success) {
            spokenTexts.push(chunk.text);
            if (!firstChunkSpoken) {
              firstChunkSpoken = true;
              console.log(
                `[voice-call] First streaming chunk spoken for ${callId} (TTFA=${Date.now() - genStart}ms)`,
              );
            }
          } else {
            console.warn(
              `[voice-call] Failed to speak streaming chunk #${chunk.index} for ${callId}: ${speakResult.error}`,
            );
          }
        });

        const totalMs = Date.now() - genStart;

        if (result.error && !result.text) {
          console.error(`[voice-call] Streaming response error (${totalMs}ms): ${result.error}`);
          if (!firstChunkSpoken) {
            await this.trySpeakFallback(callId, "抱歉，我刚刚没来得及回答。请你再说一遍。");
          }
          return;
        }

        if (!result.text && !firstChunkSpoken) {
          console.log(`[voice-call] Fallback response for ${callId} (${totalMs}ms): empty_output`);
          await this.trySpeakFallback(callId, "抱歉，这个问题我暂时没法回答。你可以再换个问法。");
          return;
        }

        console.log(
          `[voice-call] Streaming response complete for ${callId}: ${result.chunksStreamed} chunks, ` +
            `TTFA=${result.timeToFirstAudioMs}ms, total=${totalMs}ms` +
            `${result.endCall ? " [END_CALL]" : ""}`,
        );

        // In Gather mode, signal the sentence queue that generation is done.
        // If endCall is true, handleGatherAction will issue <Hangup> after draining.
        if (isGather && providerCallId) {
          (this.provider as TwilioProvider).markGatherSentencesDone(providerCallId, result.endCall);
        }

        // Note: each manager.speak() call already adds a transcript entry via addTranscriptEntry,
        // so we don't need to add another one here.

        if (result.endCall && !isGather) {
          // In stream mode, wait then hang up. In Gather mode, the action URL chain handles this.
          console.log(`[voice-call] LLM signaled [END_CALL] for ${callId}, hanging up in 4s...`);
          await new Promise((resolve) => setTimeout(resolve, 4000));
          const endResult = await this.manager.endCall(callId);
          if (!endResult.success) {
            console.warn(`[voice-call] Failed to end call ${callId}: ${endResult.error}`);
          }
        }
      }
    } catch (err) {
      console.error(`[voice-call] Auto-response error:`, err);
      await this.trySpeakFallback(callId, "抱歉，我这边刚刚出了点问题。请再说一遍。");
    }
  }

  private async trySpeakFallback(
    callId: string,
    text: string,
    endAfterSpeak = false,
  ): Promise<void> {
    // Use pre-cached farewell audio for instant playback, or generate SAG audio
    let audioUrl: string | undefined;
    if (text === "好的，拜拜。" && this.cachedFarewellAudioUrl) {
      audioUrl = this.cachedFarewellAudioUrl;
      console.log(`[voice-call] Using pre-cached farewell audio for ${callId}`);
    } else if (this.coreConfig) {
      try {
        audioUrl = await maybeGenerateHostedAudioUrl({
          text,
          coreConfig: this.coreConfig,
          voiceConfig: this.config,
          callId,
        });
        if (audioUrl) {
          console.log(`[voice-call] Fallback SAG audio ready for ${callId}: ${audioUrl}`);
        }
      } catch (err) {
        console.warn(`[voice-call] Fallback SAG generation failed, using Twilio TTS:`, err);
      }
    }

    // In Gather mode, convert local audio path to public URL
    const isGather =
      this.provider.name === "twilio" && (this.provider as TwilioProvider).isGatherMode;
    if (isGather && audioUrl) {
      const publicUrl = localPathToPublicUrl(audioUrl, this.config);
      if (publicUrl) {
        audioUrl = publicUrl;
      }
    }

    const result = await this.manager.speak(callId, text, {
      audioUrl,
    });
    if (!result.success) {
      console.warn(`[voice-call] Failed to speak fallback for ${callId}: ${result.error}`);
      return;
    }

    if (endAfterSpeak) {
      // Delay to let Twilio finish playing the buffered farewell audio
      await new Promise((resolve) => setTimeout(resolve, 4000));
      const endResult = await this.manager.endCall(callId);
      if (!endResult.success) {
        console.warn(
          `[voice-call] Failed to end call ${callId} after fallback: ${endResult.error}`,
        );
      }
    }
  }
}

/**
 * Resolve the current machine's Tailscale DNS name.
 */
export type TailscaleSelfInfo = {
  dnsName: string | null;
  nodeId: string | null;
};

/**
 * Run a tailscale command with timeout, collecting stdout.
 */
function runTailscaleCommand(
  args: string[],
  timeoutMs = 2500,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const proc = spawn("tailscale", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    proc.stdout.on("data", (data) => {
      stdout += data;
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({ code: -1, stdout: "" });
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout });
    });
  });
}

export async function getTailscaleSelfInfo(): Promise<TailscaleSelfInfo | null> {
  const { code, stdout } = await runTailscaleCommand(["status", "--json"]);
  if (code !== 0) {
    return null;
  }

  try {
    const status = JSON.parse(stdout);
    return {
      dnsName: status.Self?.DNSName?.replace(/\.$/, "") || null,
      nodeId: status.Self?.ID || null,
    };
  } catch {
    return null;
  }
}

export async function getTailscaleDnsName(): Promise<string | null> {
  const info = await getTailscaleSelfInfo();
  return info?.dnsName ?? null;
}

export async function setupTailscaleExposureRoute(opts: {
  mode: "serve" | "funnel";
  path: string;
  localUrl: string;
}): Promise<string | null> {
  const dnsName = await getTailscaleDnsName();
  if (!dnsName) {
    console.warn("[voice-call] Could not get Tailscale DNS name");
    return null;
  }

  const { code } = await runTailscaleCommand([
    opts.mode,
    "--bg",
    "--yes",
    "--set-path",
    opts.path,
    opts.localUrl,
  ]);

  if (code === 0) {
    const publicUrl = `https://${dnsName}${opts.path}`;
    console.log(`[voice-call] Tailscale ${opts.mode} active: ${publicUrl}`);
    return publicUrl;
  }

  console.warn(`[voice-call] Tailscale ${opts.mode} failed`);
  return null;
}

export async function cleanupTailscaleExposureRoute(opts: {
  mode: "serve" | "funnel";
  path: string;
}): Promise<void> {
  await runTailscaleCommand([opts.mode, "off", opts.path]);
}

/**
 * Setup Tailscale serve/funnel for the webhook server.
 * This is a helper that shells out to `tailscale serve` or `tailscale funnel`.
 */
export async function setupTailscaleExposure(config: VoiceCallConfig): Promise<string | null> {
  if (config.tailscale.mode === "off") {
    return null;
  }

  const mode = config.tailscale.mode === "funnel" ? "funnel" : "serve";
  // Include the path suffix so tailscale forwards to the correct endpoint
  // (tailscale strips the mount path prefix when proxying)
  const localUrl = `http://127.0.0.1:${config.serve.port}${config.serve.path}`;
  return setupTailscaleExposureRoute({
    mode,
    path: config.tailscale.path,
    localUrl,
  });
}

/**
 * Cleanup Tailscale serve/funnel.
 */
export async function cleanupTailscaleExposure(config: VoiceCallConfig): Promise<void> {
  if (config.tailscale.mode === "off") {
    return;
  }

  const mode = config.tailscale.mode === "funnel" ? "funnel" : "serve";
  await cleanupTailscaleExposureRoute({ mode, path: config.tailscale.path });
}
