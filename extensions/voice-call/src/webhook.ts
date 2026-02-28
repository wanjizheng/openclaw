import { spawn } from "node:child_process";
import http from "node:http";
import { URL } from "node:url";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "openclaw/plugin-sdk";
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
import { generateGreetingText, maybeGenerateHostedAudioUrl } from "./response-generator.js";
import { TerminalStates, type NormalizedEvent, type WebhookContext } from "./types.js";
import { startStaleCallReaper } from "./webhook/stale-call-reaper.js";

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

const END_CALL_KEYWORDS = [
  "没了",
  "沒有了",
  "没有了",
  "没有问题了",
  "先这样",
  "先這樣",
  "就这样",
  "就這樣",
  "挂了",
  "掛了",
  "挂断",
  "掛斷",
  "结束通话",
  "結束通話",
  "再见",
  "再見",
  "拜拜",
  "掰掰",
  "白白",
  "謝謝",
  "谢谢",
];

function isEndCallIntent(text: string): boolean {
  const lower = text.toLowerCase();
  if (/(^|\b)(bye|goodbye|hang\s*up|end\s*call)(\b|$)/i.test(lower)) {
    return true;
  }

  const compact = lower.replace(/\s+/g, "");
  return END_CALL_KEYWORDS.some((keyword) => compact.includes(keyword));
}

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
  /** Calls already flagged for early end-intent hangup from partial transcript */
  private earlyEndIntentCalls = new Set<string>();
  /** Pre-generated audio URLs for inbound contact greetings, keyed by normalised phone digits */
  private preGeneratedGreetingUrls = new Map<string, string>();

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
      },
      onPartialTranscript: (providerCallId, partial) => {
        console.log(`[voice-call] Partial for ${providerCallId}: ${partial}`);

        // Early end-intent detection from partial transcript
        if (isEndCallIntent(partial)) {
          const call = this.manager.getCallByProviderCallId(providerCallId);
          if (call && !this.earlyEndIntentCalls.has(call.callId)) {
            this.earlyEndIntentCalls.add(call.callId);
            console.log(
              `[voice-call] Early end-intent from partial for ${call.callId}: "${partial}"`,
            );
            void this.trySpeakFallback(call.callId, "好的，拜拜。", true).catch((err) => {
              console.warn(`[voice-call] Failed early end-intent hangup:`, err);
            });
          }
        }
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
        setTimeout(() => {
          this.manager.speakInitialMessage(callId).catch((err) => {
            console.warn(`[voice-call] Failed to speak initial message:`, err);
          });
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

      // Handle WebSocket upgrades for media streams
      if (this.mediaStreamHandler) {
        this.server.on("upgrade", (request, socket, head) => {
          const path = this.getUpgradePathname(request);
          if (path === streamPath) {
            console.log("[voice-call] WebSocket upgrade for media stream");
            this.mediaStreamHandler?.handleUpgrade(request, socket, head);
          } else {
            socket.destroy();
          }
        });
      }

      this.server.on("error", reject);

      this.server.listen(port, bind, () => {
        const url = `http://${bind}:${port}${webhookPath}`;
        console.log(`[voice-call] Webhook server listening on ${url}`);
        if (this.mediaStreamHandler) {
          console.log(`[voice-call] Media stream WebSocket on ws://${bind}:${port}${streamPath}`);
        }
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

    // Process each event
    if (verification.isReplay) {
      console.warn("[voice-call] Replay detected; skipping event side effects");
    } else {
      for (const event of result.events) {
        try {
          this.manager.processEvent(event);
          if (event.type === "call.ended") {
            this.pendingAutoResponses.delete(event.callId);
            this.inFlightAutoResponses.delete(event.callId);
            this.earlyEndIntentCalls.delete(event.callId);
            // Audio file cleanup is handled by the onCallEnded hook.
          }
        } catch (err) {
          console.error(`[voice-call] Error processing event ${event.type}:`, err);
        }
      }
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
   * Supports tool calling for richer voice interactions.
   */
  private async handleInboundResponse(callId: string, userMessage: string): Promise<void> {
    console.log(`[voice-call] Auto-responding to inbound call ${callId}: "${userMessage}"`);

    // Get call context for conversation history
    const call = this.manager.getCall(callId);
    if (!call) {
      console.warn(`[voice-call] Call ${callId} not found for auto-response`);
      return;
    }

    if (!this.coreConfig) {
      console.warn("[voice-call] Core config missing; skipping auto-response");
      return;
    }

    if (isEndCallIntent(userMessage)) {
      console.log(`[voice-call] End-call intent detected for ${callId}; hanging up immediately`);
      await this.trySpeakFallback(callId, "好的，拜拜。", true);
      return;
    }

    // Skip LLM if early end-intent already triggered from partial transcript
    if (this.earlyEndIntentCalls.has(callId)) {
      console.log(`[voice-call] Skipping LLM for ${callId}: early end-intent already triggered`);
      return;
    }

    try {
      const { generateVoiceResponse } = await import("./response-generator.js");

      const genStart = Date.now();
      const result = await generateVoiceResponse({
        voiceConfig: this.config,
        coreConfig: this.coreConfig,
        callId,
        from: call.from,
        callerName:
          typeof call.metadata?.callerName === "string" ? call.metadata.callerName : undefined,
        transcript: call.transcript,
        userMessage,
      });
      const genMs = Date.now() - genStart;

      if (result.error) {
        console.error(`[voice-call] Response generation error (${genMs}ms): ${result.error}`);
        console.log(`[voice-call] Fallback response for ${callId}: llm_error`);
        await this.trySpeakFallback(callId, "抱歉，我刚刚没来得及回答。请你再说一遍。");
        return;
      }

      if (!result.text) {
        console.log(`[voice-call] Fallback response for ${callId} (${genMs}ms): empty_output`);
        await this.trySpeakFallback(callId, "抱歉，这个问题我暂时没法回答。你可以再换个问法。");
        return;
      }

      console.log(`[voice-call] AI response (${genMs}ms): "${result.text}"`);
      if (result.audioUrl) {
        console.log(`[voice-call] Hosted audio ready: ${result.audioUrl}`);
      }

      const speakStart = Date.now();
      const speakResult = await this.manager.speak(callId, result.text, {
        audioUrl: result.audioUrl,
      });
      const speakMs = Date.now() - speakStart;
      if (!speakResult.success) {
        console.warn(
          `[voice-call] Failed to speak AI response for ${callId} (${speakMs}ms): ${speakResult.error}`,
        );
      } else {
        console.log(
          `[voice-call] Speak completed for ${callId} in ${speakMs}ms (total: ${genMs + speakMs}ms)`,
        );
      }
    } catch (err) {
      console.error(`[voice-call] Auto-response error:`, err);
      console.log(`[voice-call] Fallback response for ${callId}: exception`);
      await this.trySpeakFallback(callId, "抱歉，我这边刚刚出了点问题。请再说一遍。");
    }
  }

  private async trySpeakFallback(
    callId: string,
    text: string,
    endAfterSpeak = false,
  ): Promise<void> {
    const result = await this.manager.speak(callId, text);
    if (!result.success) {
      console.warn(`[voice-call] Failed to speak fallback for ${callId}: ${result.error}`);
      return;
    }

    if (endAfterSpeak) {
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
