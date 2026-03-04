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
  deleteCallAudioFiles,
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
  /** Per-call abort controllers for the currently in-flight handleInboundResponse LLM run */
  private inFlightAbortControllers = new Map<string, AbortController>();
  /** Provider call IDs currently playing initial greeting — transcripts are discarded to avoid echo */
  // Maps providerCallId -> timestamp when greeting audio playback started.
  // Used to distinguish AEC-warmup echo (first ~2s) from real user barge-in.
  private greetingPlayStart = new Map<string, number>();
  /** When a speech-start is suppressed during AEC warmup, flag it so the resulting transcript is also discarded */
  private aecSuppressedSpeech = new Set<string>();
  /** Dynamically generated greeting audio URLs per call (Hybrid mode), keyed by callId for cleanup */
  private dynamicGreetingUrls = new Map<string, string>();
  /** ConversationRelay: WebSocket server for CR connections */
  private crWss: WebSocketServer | null = null;
  /** ConversationRelay: active WebSocket connections keyed by providerCallId (callSid) */
  private crConnections = new Map<string, WebSocket>();
  /** ConversationRelay: abort controllers for in-flight LLM runs, keyed by callId */
  private crAbortControllers = new Map<string, AbortController>();
  /** Active LLM response sessionIds, keyed by callId (for interruption) */
  private activeResponseSessionIds = new Map<string, string>();

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

        // In hybrid mode, ignore the transcript that triggered an interrupt
        if (this.provider.name === "twilio") {
          const twilioProvider = this.provider as TwilioProvider;
          if (
            twilioProvider.isHybridMode &&
            twilioProvider.consumeHybridInterruptFlag(providerCallId)
          ) {
            console.log(
              `[voice-call][hybrid] Ignoring interrupt-trigger transcript for ${providerCallId}: "${transcript}"`,
            );
            return;
          }
        }

        // Clear TTS queue on barge-in (user started speaking, interrupt current playback)
        if (this.provider.name === "twilio") {
          (this.provider as TwilioProvider).clearTtsQueue(providerCallId);
        }

        // Discard transcripts during initial greeting playback — they are
        // echo of the bot's own voice picked up by Twilio before AEC warms up.
        // Also discard if the speech-start that produced this transcript was suppressed.
        const greetingStart = this.greetingPlayStart.get(providerCallId);
        if (greetingStart) {
          const elapsed = Date.now() - greetingStart;
          if (elapsed < 5000) {
            // Also consume the suppressed-speech flag so it doesn't linger
            // and accidentally kill the NEXT (real) transcript.
            this.aecSuppressedSpeech.delete(providerCallId);
            console.log(
              `[voice-call] Discarding echo transcript during AEC warmup for ${providerCallId} (${elapsed}ms): "${transcript}"`,
            );
            return;
          }
        }
        // If the speech-start that led to this transcript was suppressed during AEC,
        // discard the transcript too (STT processing delay means transcript arrives later)
        if (this.aecSuppressedSpeech.has(providerCallId)) {
          this.aecSuppressedSpeech.delete(providerCallId);
          console.log(
            `[voice-call] Discarding echo transcript (suppressed speech-start) for ${providerCallId}: "${transcript}"`,
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
        // During AEC warmup (~first 2s of greeting playback), ignore speech-start.
        // The phone's AEC hasn't adapted yet, so the STT stream picks up the
        // bot's own greeting audio as echo. After warmup, allow normal barge-in
        // just like any other hybrid+CR turn.
        const greetingStart = this.greetingPlayStart.get(providerCallId);
        if (greetingStart) {
          const elapsed = Date.now() - greetingStart;
          if (elapsed < 5000) {
            console.log(
              `[voice-call] Ignoring speech-start during AEC warmup for ${providerCallId} (${elapsed}ms since greeting start)`,
            );
            this.aecSuppressedSpeech.add(providerCallId);
            return;
          }
          // AEC warmed up, allow barge-in. Clean up the greeting marker.
          this.greetingPlayStart.delete(providerCallId);
          console.log(
            `[voice-call] Greeting barge-in allowed for ${providerCallId} (${elapsed}ms since greeting start)`,
          );
        }

        if (this.provider.name === "twilio") {
          const twilioProvider = this.provider as TwilioProvider;

          // In hybrid mode, if user speaks during PLAYING state, abort playback immediately
          if (twilioProvider.isHybridMode) {
            if (twilioProvider.hasActiveHybridQueue(providerCallId)) {
              console.log(
                `[voice-call][hybrid] User interrupted during playback for ${providerCallId}`,
              );
              twilioProvider.abortHybridPlay(providerCallId);
              // Fall through to also abort LLM generation below
            }
          }

          twilioProvider.clearTtsQueue(providerCallId);
        }

        // Abort any in-flight LLM streaming for this call
        const call = this.manager.getCallByProviderCallId(providerCallId);
        if (call) {
          // 1) Abort via crAbortControllers (if used)
          const controller = this.crAbortControllers.get(call.callId);
          if (controller) {
            controller.abort();
            this.crAbortControllers.delete(call.callId);
            console.log(
              `[voice-call] Aborted LLM generation for ${call.callId} via AbortController`,
            );
          }
          // 2) Abort via abortEmbeddedPiRun (session-level abort)
          const sessionId = this.activeResponseSessionIds.get(call.callId);
          if (sessionId) {
            void (async () => {
              try {
                const { loadCoreAgentDeps } = await import("./core-bridge.js");
                const deps = await loadCoreAgentDeps();
                const aborted = deps.abortEmbeddedPiRun(sessionId);
                if (aborted) {
                  console.log(
                    `[voice-call] Aborted LLM streaming for ${call.callId} (sessionId=${sessionId})`,
                  );
                }
              } catch (err) {
                console.warn(`[voice-call] Failed to abort LLM streaming:`, err);
              }
            })();
          }
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

        // ── Hybrid mode: fork stream is STT-only ────────────────────────
        const isHybrid =
          this.provider.name === "twilio" && (this.provider as TwilioProvider).isHybridMode;

        if (isHybrid) {
          // In hybrid mode, the <Start><Stream> fork only provides STT.
          // (registerCallStream was already called above)

          // ── INBOUND: Synthesize answered, greeting will be spoken via CR after setup ────
          if (call && call.direction === "inbound") {
            // Synthesize call.answered — the call is now active
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

            // Record greeting playback start for AEC warmup tracking
            this.greetingPlayStart.set(callId, Date.now());
            setTimeout(() => {
              if (this.greetingPlayStart.has(callId)) {
                this.greetingPlayStart.delete(callId);
                console.log(`[voice-call][hybrid] Greeting AEC guard expired for ${callId}`);
              }
            }, 8000);
          } else if (call && call.direction === "outbound") {
            // ── OUTBOUND: TTS warmup already done during webhook handler.
            // Just synthesize call.answered and set up AEC warmup tracking.
            this.greetingPlayStart.set(callId, Date.now());
            if (call.state === "ringing") {
              console.log(`[voice-call][hybrid-outbound] Stream connected for ${call.callId}`);
              const answeredEvent: NormalizedEvent = {
                id: `stream-answered-${Date.now()}`,
                type: "call.answered" as const,
                callId: call.callId,
                providerCallId: callId,
                timestamp: Date.now(),
              };
              this.manager.processEvent(answeredEvent);
            }
            // AEC warmup guard auto-expires
            setTimeout(() => {
              if (this.greetingPlayStart.has(callId)) {
                this.greetingPlayStart.delete(callId);
                console.log(
                  `[voice-call][hybrid] Outbound greeting AEC guard expired for ${callId}`,
                );
              }
            }, 8000);
          }
          return;
        }
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

    // Gather/Play action callbacks carry identical bodies (same CallSid, CallStatus,
    // etc.) on every cycle, producing the same Twilio HMAC signature and thus
    // the same replay key.  They are NOT replays — each one is a new
    // timeout/speech event — so we must exempt them from the replay filter.
    const isGatherActionCallback = url.searchParams.get("gatherAction") === "1";
    const isPlayActionCallback = url.searchParams.get("playAction") === "1";
    const treatAsReplay = verification.isReplay && !isGatherActionCallback && !isPlayActionCallback;

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
              (this.provider as TwilioProvider).clearHybridQueue(event.providerCallId);
            }
            // Clean up dynamically generated greeting audio (Hybrid mode)
            const greetingUrl = this.dynamicGreetingUrls.get(event.callId);
            this.dynamicGreetingUrls.delete(event.callId);
            if (greetingUrl) {
              void deleteCallAudioFiles(event.callId, [greetingUrl]);
            }
            // Audio file cleanup is handled by the onCallEnded hook.
          }
        } catch (err) {
          console.error(`[voice-call] Error processing event ${event.type}:`, err);
        }
      }
    }

    // ── Hybrid mode: build initial TwiML ───────────────────────────────────
    // For INBOUND calls we delay the webhook response while generating greeting
    // text + TTS audio (the caller hears ringing during this time, ~5-6s). Then
    // we return a single TwiML: <Start><Stream> + <Play greeting.mp3> + <Connect CR>.
    // TwiML executes sequentially: Stream forks (background), greeting plays
    // (blocking), then CR connects. No conflicting Call Updates needed.
    if (this.provider.name === "twilio" && (this.provider as TwilioProvider).isHybridMode) {
      for (const event of result.events) {
        if (event.type === "call.ringing" && event.providerCallId) {
          const call = this.manager.getCall(event.callId);
          if (!call) continue;

          const twilio = this.provider as TwilioProvider;
          let greetingText: string | undefined;

          if (call.direction === "inbound") {
            // Generate greeting text + audio using our own TTS pipeline (ElevenLabs/SAG).
            // This generation IS the TTS warmup. The audio will be played through the
            // normal hybrid playback mechanism (CR → speakInitialMessage → playTts → hybrid queue)
            // after CR connects.
            try {
              const greetPipelineStart = Date.now();
              const callerKey = normalizePhoneNumber(call.from);
              const contacts = await loadContactsFileAsync();
              const contact = contacts.find((c) => normalizePhoneNumber(c.phone) === callerKey);
              const contactLookupMs = Date.now() - greetPipelineStart;

              const template = contact?.greeting ?? this.config.inboundGreeting;
              const llmStart = Date.now();
              const generatedText = await generateGreetingText({
                voiceConfig: this.config,
                coreConfig: this.coreConfig!,
                from: call.from,
                callerName: contact?.name,
                greetingHint: template,
                callerInfo: contact?.info,
              });
              const llmMs = Date.now() - llmStart;

              greetingText = generatedText || template || "您好";

              // Strip emotion markers
              if (greetingText) {
                greetingText = greetingText.replace(/\[[\w-]+\]\s*/g, "").trim();
              }

              // Generate TTS audio file (this IS the warmup)
              const ttsStart = Date.now();
              const audioLocalPath = await maybeGenerateHostedAudioUrl({
                text: greetingText,
                coreConfig: this.coreConfig!,
                voiceConfig: this.config,
                callId: call.callId,
              });
              const ttsMs = Date.now() - ttsStart;
              const totalMs = Date.now() - greetPipelineStart;
              console.log(
                `[voice-call][pipeline-metrics] GREETING call=${call.callId} ` +
                  `contactLookup=${contactLookupMs}ms llmGenerate=${llmMs}ms ttsGenerate=${ttsMs}ms ` +
                  `total=${totalMs}ms textLen=${greetingText?.length ?? 0} ` +
                  `usedLLM=${!!generatedText} usedTemplate=${!generatedText}`,
              );

              // Store in metadata so speakInitialMessage can use the pre-generated audio
              if (call.metadata) {
                call.metadata.initialMessage = greetingText;
                if (audioLocalPath) {
                  this.dynamicGreetingUrls.set(call.callId, audioLocalPath);
                  const publicUrl = localPathToPublicUrl(audioLocalPath, this.config);
                  if (publicUrl) {
                    call.metadata.initialMessageAudioUrl = publicUrl;
                  }
                }
              }

              console.log(
                `[voice-call][hybrid] Inbound warmup done for ${call.callId}: text="${greetingText?.slice(0, 60)}", audioUrl=${audioLocalPath ? "yes" : "no"}`,
              );
            } catch (err) {
              console.warn(
                `[voice-call][hybrid] Inbound warmup failed, proceeding without greeting:`,
                err,
              );
            }
          } else {
            // Outbound: LLM greeting + TTS audio were pre-generated BEFORE dialing
            // (in the initiate_call tool handler) so audio is ready immediately.
            // Just read from metadata — no generation needed here.
            greetingText =
              typeof call.metadata?.initialMessage === "string"
                ? call.metadata.initialMessage.replace(/\[[\w-]+\]\s*/g, "").trim()
                : undefined;

            console.log(
              `[voice-call][hybrid] Outbound using pre-generated greeting for ${call.callId}: text="${greetingText?.slice(0, 60) || "none"}", audioUrl=${call.metadata?.initialMessageAudioUrl ? "yes" : "no"}`,
            );
          }

          // Both inbound and outbound: no welcomeGreeting — greeting is played via
          // hybrid queue after CR connects (same mechanism as conversation responses).
          result.providerResponseBody = twilio.buildHybridInitialTwiml({
            callSid: event.providerCallId,
          });
          console.log(
            `[voice-call][hybrid] Initial TwiML for ${call.callId} (dir: ${call.direction}, greeting: "${greetingText?.slice(0, 60) || "none"}")`,
          );
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

              // In hybrid mode, speak the pre-generated greeting via the normal
              // hybrid playback mechanism (same as conversation responses).
              // speakInitialMessage reads call.metadata.initialMessage + initialMessageAudioUrl
              // and calls speak() -> playTts() -> hybrid queue -> Call Update <Play> -> resume CR.
              // Works for BOTH inbound and outbound — both pre-generate during webhook.
              if (typeof call.metadata?.initialMessage === "string" && callSid) {
                this.greetingPlayStart.set(callSid, Date.now());
                const sid = callSid; // capture for closure (non-null)
                setTimeout(async () => {
                  try {
                    await this.manager.speakInitialMessage(sid);
                    // Mark hybrid queue done so handlePlayNextAction resumes CR
                    // after the greeting finishes playing, instead of entering a
                    // Pause/Redirect polling loop.
                    if (
                      this.provider.name === "twilio" &&
                      (this.provider as TwilioProvider).isHybridMode
                    ) {
                      (this.provider as TwilioProvider).markHybridSentencesDone(sid, false);
                    }
                    console.log(
                      `[voice-call][cr] Greeting playback initiated for ${callId} (${call.direction})`,
                    );
                  } catch (err) {
                    console.warn(`[voice-call][cr] Failed to speak greeting:`, err);
                  } finally {
                    setTimeout(() => {
                      if (this.greetingPlayStart.has(sid)) {
                        this.greetingPlayStart.delete(sid);
                        console.log(`[voice-call][cr] Greeting AEC guard expired for ${sid}`);
                      }
                    }, 5000);
                  }
                }, 300);
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

            // In hybrid mode, STT comes from the fork Media Stream (OpenAI).
            // CR's Deepgram transcript is ignored — CR is event-channel only.
            const isHybridPrompt =
              this.provider.name === "twilio" && (this.provider as TwilioProvider).isHybridMode;
            if (isHybridPrompt) {
              console.log(
                `[voice-call][cr][hybrid] Ignoring CR prompt (using fork STT): "${voicePrompt.slice(0, 60)}" (call ${callId})`,
              );
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

        // In hybrid mode, CR disconnects during <Play> injection are expected.
        // Don't synthesize call.ended if a hybrid play queue is active.
        const isHybridClose =
          this.provider.name === "twilio" &&
          (this.provider as TwilioProvider).isHybridMode &&
          callSid &&
          (this.provider as TwilioProvider).hasActiveHybridQueue(callSid);
        if (isHybridClose) {
          console.log(
            `[voice-call][cr][hybrid] Expected CR disconnect during play for ${callId}, not ending call`,
          );
          return;
        }

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
   * Serialize auto-responses per call to avoid overlapping LLM runs.
   */
  private enqueueInboundResponse(callId: string, userMessage: string): void {
    const normalized = userMessage.trim();
    if (!normalized) {
      return;
    }

    const enqueueTs = Date.now();
    this.pendingAutoResponses.set(callId, normalized);
    if (this.inFlightAutoResponses.has(callId)) {
      // A response is already in-flight. Abort it so the new message is
      // processed immediately instead of waiting 30+ seconds.
      const ac = this.inFlightAbortControllers.get(callId);
      if (ac) {
        console.log(
          `[voice-call] New user message while LLM in-flight for ${callId} — aborting stale response`,
        );
        ac.abort();
      }
      // Also abort the underlying LLM engine run
      const sessionId = this.activeResponseSessionIds.get(callId);
      if (sessionId) {
        void (async () => {
          try {
            const { loadCoreAgentDeps } = await import("./core-bridge.js");
            const deps = await loadCoreAgentDeps();
            deps.abortEmbeddedPiRun(sessionId);
          } catch {
            /* best effort */
          }
        })();
      }
      // Abort hybrid playback of stale response
      if (this.provider.name === "twilio") {
        const call = this.manager.getCall(callId);
        const providerCallId = call?.providerCallId;
        if (providerCallId) {
          const twilioProvider = this.provider as TwilioProvider;
          if (twilioProvider.isHybridMode && twilioProvider.hasActiveHybridQueue(providerCallId)) {
            twilioProvider.abortHybridPlay(providerCallId);
          }
          twilioProvider.clearTtsQueue(providerCallId);
        }
      }
      return;
    }

    this.inFlightAutoResponses.add(callId);
    void this.drainInboundResponseQueue(callId, enqueueTs).finally(() => {
      this.inFlightAutoResponses.delete(callId);
      this.inFlightAbortControllers.delete(callId);
      if (this.pendingAutoResponses.has(callId)) {
        this.enqueueInboundResponse(callId, this.pendingAutoResponses.get(callId) || "");
      }
    });
  }

  private async drainInboundResponseQueue(callId: string, enqueueTs?: number): Promise<void> {
    while (true) {
      const nextMessage = this.pendingAutoResponses.get(callId);
      if (!nextMessage) {
        return;
      }
      this.pendingAutoResponses.delete(callId);

      // Create an AbortController so enqueueInboundResponse can cancel us
      // if a newer message arrives from the user.
      const ac = new AbortController();
      this.inFlightAbortControllers.set(callId, ac);

      const queueWaitMs = enqueueTs ? Date.now() - enqueueTs : 0;
      if (queueWaitMs > 50) {
        console.log(
          `[voice-call][pipeline-metrics] QUEUE_WAIT call=${callId} waited=${queueWaitMs}ms`,
        );
      }

      try {
        await this.handleInboundResponse(callId, nextMessage, ac.signal);
      } catch (err) {
        if (ac.signal.aborted) {
          console.log(
            `[voice-call] Stale LLM response aborted for ${callId}, processing newer message`,
          );
        } else {
          console.warn(`[voice-call] Failed to auto-respond:`, err);
        }
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
  private async handleInboundResponse(
    callId: string,
    userMessage: string,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const responseStart = Date.now();
    const call = this.manager.getCall(callId);
    if (!call) {
      console.warn(`[voice-call] Call ${callId} not found for auto-response`);
      return;
    }
    console.log(
      `[voice-call] Auto-responding to ${call.direction} call ${callId}: "${userMessage}"`,
    );

    // Track sessionId for this call (will be set inside generateStreamingVoiceResponse)
    // but we need to import it to access the sessionId after generation starts.
    // For now, we'll rely on the fact that sessionKey = `voice:${callId}` and
    // sessionId is derived from session store lookup.

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
        call.direction === "outbound" &&
        typeof (call.metadata?.callReason ?? call.metadata?.initialMessage) === "string"
          ? String(call.metadata?.callReason ?? call.metadata?.initialMessage).trim() || undefined
          : undefined,
    };

    if (voiceParams.callReason) {
      console.log(`[voice-call] callReason for ${callId}: "${voiceParams.callReason}"`);
    }

    try {
      const genStart = Date.now();
      let firstChunkSpoken = false;
      const spokenTexts: string[] = [];

      // Hybrid mode: convert local audio paths to public URLs for <Play>
      const isHybrid =
        this.provider.name === "twilio" && (this.provider as TwilioProvider).isHybridMode;
      const providerCallId = call?.providerCallId;

      {
        // ── Hybrid / Audio pipeline ──────────────────────────────────────
        // Extract sessionId from voiceParams to track active response
        const sessionKey = `voice:${callId}`;
        try {
          const { loadCoreAgentDeps } = await import("./core-bridge.js");
          const deps = await loadCoreAgentDeps();
          const storePath = deps.resolveStorePath(this.coreConfig?.session?.store, {
            agentId: "main",
          });
          const sessionStore = deps.loadSessionStore(storePath);
          const sessionEntry = sessionStore[sessionKey] as
            | { sessionId: string; updatedAt: number }
            | undefined;
          if (sessionEntry?.sessionId) {
            this.activeResponseSessionIds.set(callId, sessionEntry.sessionId);
          }
        } catch {
          // Non-fatal — session tracking is best-effort for interruption
        }

        // Check for abort before starting the expensive LLM call
        if (abortSignal?.aborted) {
          console.log(`[voice-call] Skipping stale LLM call for ${callId} (aborted before start)`);
          return;
        }

        const setupMs = Date.now() - responseStart;
        console.log(
          `[voice-call][pipeline-metrics] RESPONSE_SETUP call=${callId} setup=${setupMs}ms (session+config resolution)`,
        );

        const result = await generateStreamingVoiceResponse(voiceParams, async (chunk) => {
          // If aborted mid-stream, stop speaking further chunks
          if (abortSignal?.aborted) return;
          // In Hybrid mode: convert local audio path → public URL for <Play>
          let audioUrl = chunk.audioUrl;
          if (isHybrid && audioUrl) {
            const publicUrl = localPathToPublicUrl(audioUrl, this.config);
            if (publicUrl) {
              audioUrl = publicUrl;
            } else {
              console.warn(`[voice-call] Failed to convert audio path to public URL: ${audioUrl}`);
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
        const e2eMs = Date.now() - responseStart;
        console.log(
          `[voice-call][pipeline-metrics] RESPONSE call=${callId} ` +
            `setup=${setupMs}ms llm=${result.totalStreamMs}ms ttfa=${result.timeToFirstAudioMs}ms ` +
            `chunks=${result.chunksStreamed} total=${totalMs}ms e2e=${e2eMs}ms ` +
            `model=${this.config.responseModel || "default"} textLen=${result.text?.length ?? 0}`,
        );

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

        // Clean up session tracking after response completes
        this.activeResponseSessionIds.delete(callId);

        // If LLM signaled end-call, stop processing any pending responses
        // LLM owns the conversation flow completely — don't add any system-generated messages
        if (result.endCall) {
          this.pendingAutoResponses.delete(callId);
          console.log(
            `[voice-call] End-call signaled for ${callId}; cleared pending responses to prevent extra messages`,
          );
        }

        // In Hybrid mode, signal the play queue that generation is done.
        // handlePlayNextAction will resume CR or <Hangup> after the last sentence.
        if (isHybrid && providerCallId) {
          (this.provider as TwilioProvider).markHybridSentencesDone(providerCallId, result.endCall);
        }

        // Note: each manager.speak() call already adds a transcript entry via addTranscriptEntry,
        // so we don't need to add another one here.
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
    let audioUrl: string | undefined;
    if (this.coreConfig) {
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

    // In Hybrid mode, convert local audio path to public URL
    const isHybridFallback =
      this.provider.name === "twilio" && (this.provider as TwilioProvider).isHybridMode;
    if (isHybridFallback && audioUrl) {
      const publicUrl = localPathToPublicUrl(audioUrl, this.config);
      if (publicUrl) {
        audioUrl = publicUrl;
      }
    }

    const call = this.manager.getCall(callId);
    const providerCallId = call?.providerCallId;

    const result = await this.manager.speak(callId, text, {
      audioUrl,
    });
    if (!result.success) {
      console.warn(`[voice-call] Failed to speak fallback for ${callId}: ${result.error}`);
      return;
    }

    // Mark hybrid queue done so handlePlayNextAction resumes CR after playback
    if (isHybridFallback && providerCallId) {
      (this.provider as TwilioProvider).markHybridSentencesDone(providerCallId, endAfterSpeak);
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
