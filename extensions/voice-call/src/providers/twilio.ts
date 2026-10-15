import crypto from "node:crypto";
import { retryAsync } from "openclaw/plugin-sdk/retry-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { WebhookSecurityConfig } from "../config.js";
import { HybridCrAdmission } from "../hybrid/cr-admission.js";
import { HybridPlayQueue, type CallUpdateApi } from "../hybrid/play-queue.js";
import { buildHybridInitialTwiml } from "../hybrid/twiml.js";
import { generateDtmfRedirectTwiml } from "../manager/twiml.js";
import type { MediaStreamHandler } from "../media-stream.js";
import type { TelephonyTtsProvider } from "../telephony-tts.js";
import type {
  GetCallStatusInput,
  GetCallStatusResult,
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  NormalizedEvent,
  PlayTtsInput,
  ProviderWebhookParseResult,
  SendDtmfInput,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
  WebhookParseOptions,
  WebhookVerificationResult,
} from "../types.js";
import { escapeXml, mapVoiceToPolly } from "../voice-mapping.js";
import { verifyTwilioWebhook } from "../webhook-security.js";
import type { VoiceCallProvider } from "./base.js";
import {
  isProviderStatusTerminal,
  mapProviderStatusToEndReason,
  normalizeProviderStatus,
} from "./shared/call-status.js";
import { guardedJsonApiRequest, readProviderCallStatus } from "./shared/guarded-json-api.js";
import { resolveTwilioApiBaseUrl, type TwilioRegion } from "./twilio-region.js";
import { TwilioApiError, twilioApiRequest } from "./twilio/api.js";
import {
  buildHybridPlayNextUrl,
  createTwilioRequestDedupeKey,
  resolveTwilioWebSocketUrl,
} from "./twilio/webhook-routing.js";

export interface TwilioProviderOptions {
  hybridMode?: boolean;
  crPath?: string;
  /** Allow ngrok free tier compatibility mode (loopback only, less secure) */
  allowNgrokFreeTierLoopbackBypass?: boolean;
  /** Override public URL for signature verification */
  publicUrl?: string;
  /** Path for media stream WebSocket (e.g., /voice/stream) */
  streamPath?: string;
  /** Skip webhook signature verification (development only) */
  skipVerification?: boolean;
  /** Webhook security options (forwarded headers/allowlist) */
  webhookSecurity?: WebhookSecurityConfig;
}

const TWILIO_CALL_NOT_IN_PROGRESS_CODE = 21220;
const TWILIO_CALL_UPDATE_RETRY_DELAYS_MS = [250, 750] as const;

type TwilioProviderConfig = {
  accountSid?: string;
  authToken?: string;
  region?: TwilioRegion;
};

export class TwilioProvider implements VoiceCallProvider {
  readonly name = "twilio" as const;

  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly baseUrl: string;
  private readonly callWebhookUrls = new Map<string, string>();
  private readonly options: TwilioProviderOptions;

  /** Current public webhook URL (set when tunnel starts or from config) */
  private currentPublicUrl: string | null = null;

  private ttsProvider: TelephonyTtsProvider | null = null;

  private mediaStreamHandler: MediaStreamHandler | null = null;
  private playbackMarkSequence = 0;
  private hybridQueue: HybridPlayQueue | null = null;
  private isCurrentOwner: () => boolean = () => true;
  readonly hybridCr = new HybridCrAdmission(() => this.isCurrentOwner());
  setLifecycleGuard(guard: () => boolean): void {
    this.isCurrentOwner = guard;
  }

  private readonly callStreamMap = new Map<string, string>();
  /** Per-call tokens for media stream authentication */
  private streamAuthTokens = new Map<string, string>();

  /** Storage for one-use pre-connect TwiML content */
  private readonly twimlStorage = new Map<string, string>();

  /**
   * Release all process-local metadata owned by one Twilio call.
   * Terminal webhooks can be replayed, so this must stay idempotent.
   */
  private releaseCallState(providerCallId: string, callId?: string): void {
    const webhookUrl = this.callWebhookUrls.get(providerCallId);
    let resolvedCallId = callId;
    if (!resolvedCallId && webhookUrl) {
      try {
        resolvedCallId = new URL(webhookUrl).searchParams.get("callId") || undefined;
      } catch {
        // The provider only stores URLs it constructed, but cleanup must still
        // release provider-keyed state if a malformed value is injected.
      }
    }
    if (resolvedCallId) {
      this.twimlStorage.delete(resolvedCallId);
    }
    this.hybridCr.revoke(providerCallId);
    this.hybridQueue?.clear(providerCallId);
    this.callWebhookUrls.delete(providerCallId);
    this.callStreamMap.delete(providerCallId);
    this.streamAuthTokens.delete(providerCallId);
  }

  constructor(config: TwilioProviderConfig, options: TwilioProviderOptions = {}) {
    if (!config.accountSid) {
      throw new Error("Twilio Account SID is required");
    }
    if (!config.authToken) {
      throw new Error("Twilio Auth Token is required");
    }

    this.accountSid = config.accountSid;
    this.authToken = config.authToken;
    this.baseUrl = resolveTwilioApiBaseUrl({
      accountSid: this.accountSid,
      region: config.region,
    });
    this.options = options;

    this.currentPublicUrl = options.publicUrl || null;
  }

  setPublicUrl(url: string): void {
    this.currentPublicUrl = url;
  }

  getPublicUrl(): string | null {
    return this.currentPublicUrl;
  }

  // ── Hybrid mode ─────────────────────────────────────────────────────────

  get isHybridMode(): boolean {
    return this.options.hybridMode === true;
  }

  /** Lazily-constructed hybrid play queue (null when hybrid disabled). */
  getHybridQueue(): HybridPlayQueue | null {
    if (!this.isHybridMode) {
      return null;
    }
    if (!this.hybridQueue) {
      const api: CallUpdateApi = {
        updateCallTwiml: (sid, twiml, isCurrent) => this.updateCallTwiml(sid, twiml, isCurrent),
        getPlayNextUrl: (_sid, cid) => buildHybridPlayNextUrl(this.currentPublicUrl, cid),
        getConversationRelayOptions: (sid) =>
          this.hybridCr.issue(this.currentPublicUrl, this.options.crPath, sid),
      };
      this.hybridQueue = new HybridPlayQueue(api);
    }
    return this.hybridQueue;
  }

  /** Whether a hybrid play queue is active for this call SID. */
  hasActiveHybridQueue(callSid: string): boolean {
    return this.hybridQueue?.has(callSid) ?? false;
  }

  /** Abort hybrid playback (used by webhook on barge-in). */
  abortHybridPlay(callSid: string): Promise<void> {
    return this.hybridQueue?.abort(callSid) ?? Promise.resolve();
  }

  /** Mark hybrid sentences done for a call (no more queued; resume CR after drain). */
  markHybridSentencesDone(callSid: string, endCall = false): void {
    this.hybridQueue?.markDone(callSid, endCall);
  }

  /** Handle the playAction redirect callback. */
  handlePlayNextAction(callSid: string, callId?: string, token?: string, step?: number): string {
    const q = this.getHybridQueue();
    if (!q) {
      return TwilioProvider.PAUSE_TWIML;
    }
    return q.handlePlayNextAction(callSid, callId, token, step);
  }

  /** Update a live call's TwiML via Twilio Calls API. */
  async updateCallTwiml(callSid: string, twiml: string, isCurrent?: () => boolean): Promise<void> {
    await this.updateLiveCallTwiml(
      callSid,
      twiml,
      "hybrid playback",
      () =>
        this.isCurrentOwner() && this.callWebhookUrls.has(callSid) && (!isCurrent || isCurrent()),
    );
  }

  reconnectHybridRelay(url: URL, callSid: string) {
    return this.hybridCr.reconnect(url, callSid, this.currentPublicUrl, this.options.crPath);
  }

  setTTSProvider(provider: TelephonyTtsProvider): void {
    this.ttsProvider = provider;
  }

  setMediaStreamHandler(handler: MediaStreamHandler): void {
    this.mediaStreamHandler = handler;
  }

  registerCallStream(callSid: string, streamSid: string): void {
    this.callStreamMap.set(callSid, streamSid);
  }

  hasRegisteredStream(callSid: string, streamSid?: string): boolean {
    const current = this.callStreamMap.get(callSid);
    return current !== undefined && (streamSid === undefined || current === streamSid);
  }

  unregisterCallStream(callSid: string, streamSid?: string): void {
    const currentStreamSid = this.callStreamMap.get(callSid);
    if (streamSid && currentStreamSid !== streamSid) {
      return;
    }
    this.callStreamMap.delete(callSid);
  }

  isConversationStreamConnectEnabled(): boolean {
    return Boolean(
      this.mediaStreamHandler &&
      resolveTwilioWebSocketUrl(this.currentPublicUrl, this.options.streamPath),
    );
  }

  isValidStreamToken(callSid: string, token?: string): boolean {
    const expected = this.streamAuthTokens.get(callSid);
    if (!expected || !token) {
      return false;
    }
    return safeEqualSecret(expected, token);
  }

  /** Interrupt active playback and queued TTS on barge-in. */
  clearTtsQueue(callSid: string, reason = "unspecified"): void {
    const streamSid = this.callStreamMap.get(callSid);
    if (!streamSid || !this.mediaStreamHandler) {
      return;
    }
    this.mediaStreamHandler.clearTtsQueue(streamSid, reason);
  }

  private async apiRequest<T = unknown>(
    endpoint: string,
    params: Record<string, string | string[]>,
    options?: { allowNotFound?: boolean },
  ): Promise<T> {
    return await twilioApiRequest<T>({
      baseUrl: this.baseUrl,
      accountSid: this.accountSid,
      authToken: this.authToken,
      endpoint,
      body: params,
      allowNotFound: options?.allowNotFound,
    });
  }

  private async updateLiveCallTwiml(
    providerCallId: string,
    twiml: string,
    operation: string,
    isCurrent?: () => boolean,
  ): Promise<void> {
    await retryAsync(
      () => {
        if (isCurrent && !isCurrent()) {
          throw new Error("Hybrid playback superseded or service stopped");
        }
        return this.apiRequest(`/Calls/${providerCallId}.json`, { Twiml: twiml });
      },
      {
        attempts: TWILIO_CALL_UPDATE_RETRY_DELAYS_MS.length + 1,
        minDelayMs: 0,
        shouldRetry: (err) =>
          err instanceof TwilioApiError && err.twilioCode === TWILIO_CALL_NOT_IN_PROGRESS_CODE,
        delayMs: ({ attempt }) => TWILIO_CALL_UPDATE_RETRY_DELAYS_MS[attempt - 1] ?? 0,
        onRetry: ({ delayMs }) => {
          console.warn(
            `[voice-call] Twilio ${operation} update hit call state race (21220); retrying in ${delayMs}ms`,
          );
        },
        sleep: (delayMs) => sleepWithAbort(delayMs),
      },
    );
  }

  verifyWebhook(ctx: WebhookContext): WebhookVerificationResult {
    const result = verifyTwilioWebhook(ctx, this.authToken, {
      publicUrl:
        ctx.method === "GET" && this.isHybridMode
          ? (resolveTwilioWebSocketUrl(this.currentPublicUrl, this.options.crPath ?? "/voice/cr") ??
            undefined)
          : this.currentPublicUrl || undefined,
      allowNgrokFreeTierLoopbackBypass: this.options.allowNgrokFreeTierLoopbackBypass ?? false,
      skipVerification: this.options.skipVerification,
      allowedHosts: this.options.webhookSecurity?.allowedHosts,
      trustForwardingHeaders: this.options.webhookSecurity?.trustForwardingHeaders,
      trustedProxyIPs: this.options.webhookSecurity?.trustedProxyIPs,
      remoteIP: ctx.remoteAddress,
    });

    if (!result.ok) {
      console.warn(`[twilio] Webhook verification failed: ${result.reason}`);
    }

    return {
      ok: result.ok,
      reason: result.reason,
      isReplay: result.isReplay,
      verifiedRequestKey: result.verifiedRequestKey,
      releaseReplay: result.releaseReplay,
    };
  }

  parseWebhookEvent(
    ctx: WebhookContext,
    options?: WebhookParseOptions,
  ): ProviderWebhookParseResult {
    try {
      const params = new URLSearchParams(ctx.rawBody);
      const callIdFromQuery = normalizeOptionalString(ctx.query?.callId);
      const turnTokenFromQuery = normalizeOptionalString(ctx.query?.turnToken);
      const dedupeKey = createTwilioRequestDedupeKey(ctx, options?.verifiedRequestKey);
      const event = this.normalizeEvent(params, {
        callIdOverride: callIdFromQuery,
        dedupeKey,
        turnToken: turnTokenFromQuery,
      });

      if (
        event?.direction === "inbound" &&
        event.type !== "call.ended" &&
        event.providerCallId &&
        this.currentPublicUrl &&
        !this.callWebhookUrls.has(event.providerCallId)
      ) {
        this.callWebhookUrls.set(event.providerCallId, this.currentPublicUrl);
      }

      return {
        events: event ? [event] : [],
        providerResponseBody: this.generateTwimlResponse(ctx),
        providerResponseHeaders: { "Content-Type": "application/xml" },
        statusCode: 200,
      };
    } catch {
      return { events: [], statusCode: 400 };
    }
  }

  private static parseDirection(direction: string | null): "inbound" | "outbound" | undefined {
    if (direction === "inbound") {
      return "inbound";
    }
    if (direction === "outbound-api" || direction === "outbound-dial") {
      return "outbound";
    }
    return undefined;
  }

  private static parseConfidence(value: string | null): number {
    const trimmed = value?.trim();
    if (!trimmed || !/^\d+(?:\.\d+)?$/.test(trimmed)) {
      return 0.9;
    }
    return Number(trimmed);
  }

  private normalizeEvent(
    params: URLSearchParams,
    options?: {
      callIdOverride?: string;
      dedupeKey?: string;
      turnToken?: string;
    },
  ): NormalizedEvent | null {
    const callSid = params.get("CallSid") || "";
    const callIdOverride = options?.callIdOverride;

    const baseEvent = {
      id: crypto.randomUUID(),
      dedupeKey: options?.dedupeKey,
      callId: callIdOverride || callSid,
      providerCallId: callSid,
      timestamp: Date.now(),
      turnToken: options?.turnToken,
      direction: TwilioProvider.parseDirection(params.get("Direction")),
      from: params.get("From") || undefined,
      to: params.get("To") || undefined,
    };

    const speechResult = params.get("SpeechResult");
    if (speechResult?.trim()) {
      return {
        ...baseEvent,
        type: "call.speech",
        transcript: speechResult,
        isFinal: true,
        confidence: TwilioProvider.parseConfidence(params.get("Confidence")),
      };
    }

    const digits = params.get("Digits");
    if (digits) {
      return { ...baseEvent, type: "call.dtmf", digits };
    }

    const callStatus = normalizeProviderStatus(params.get("CallStatus"));
    if (callStatus === "initiated") {
      return { ...baseEvent, type: "call.initiated" };
    }
    if (callStatus === "ringing") {
      return { ...baseEvent, type: "call.ringing" };
    }
    if (callStatus === "in-progress") {
      return { ...baseEvent, type: "call.answered" };
    }

    const endReason = mapProviderStatusToEndReason(callStatus);
    if (endReason) {
      const event = { ...baseEvent, type: "call.ended" as const, reason: endReason };
      this.releaseCallState(callSid, callIdOverride);
      return event;
    }

    return null;
  }

  private static readonly EMPTY_TWIML =
    '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

  private static readonly PAUSE_TWIML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="30"/>
</Response>`;

  private static readonly QUEUE_TWIML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Please hold while we connect you.</Say>
  <Enqueue waitUrl="/voice/hold-music">hold-queue</Enqueue>
</Response>`;

  generateTwimlResponse(ctx: WebhookContext): string {
    const params = new URLSearchParams(ctx.rawBody);
    const isStatusCallback = normalizeOptionalString(ctx.query?.type) === "status";
    const callId = normalizeOptionalString(ctx.query?.callId);
    const callStatus = params.get("CallStatus");
    const direction = params.get("Direction");
    const callSid = params.get("CallSid") || undefined;
    const storedTwiml = callId ? this.twimlStorage.get(callId) : undefined;
    // Preserve eager URL validation even for callbacks that return non-streaming TwiML.
    const streamUrl = callSid
      ? resolveTwilioWebSocketUrl(this.currentPublicUrl, this.options.streamPath)
      : null;

    if (callId && !isStatusCallback && storedTwiml) {
      this.twimlStorage.delete(callId);
      return storedTwiml;
    }
    if (isStatusCallback) {
      return TwilioProvider.EMPTY_TWIML;
    }
    if (direction === "inbound") {
      if (this.callStreamMap.size > 0) {
        return TwilioProvider.QUEUE_TWIML;
      }
    } else if (!(callId && direction?.startsWith("outbound")) && callStatus !== "in-progress") {
      return TwilioProvider.EMPTY_TWIML;
    }

    if (!streamUrl || !callSid) {
      return TwilioProvider.PAUSE_TWIML;
    }
    const url = new URL(streamUrl);
    url.searchParams.set("token", this.getStreamAuthToken(callSid));
    if (this.isHybridMode) {
      const cr = this.hybridCr.issue(this.currentPublicUrl, this.options.crPath, callSid);
      if (cr) {
        return buildHybridInitialTwiml({ streamUrl: url.toString(), cr });
      }
      return TwilioProvider.PAUSE_TWIML;
    }
    return this.getStreamConnectXml(url.toString());
  }

  consumeInitialTwiML(ctx: WebhookContext): string | null {
    const params = new URLSearchParams(ctx.rawBody);
    const isStatusCallback = normalizeOptionalString(ctx.query?.type) === "status";
    const callId = normalizeOptionalString(ctx.query?.callId);
    const callSid = params.get("CallSid") || undefined;
    if (!callId || isStatusCallback) {
      return null;
    }
    const storedTwiml = this.twimlStorage.get(callId);
    if (!storedTwiml) {
      return null;
    }
    this.twimlStorage.delete(callId);
    console.log(
      `[voice-call] Twilio initial TwiML consumed for call ${callId} (kind=pre-connect, callSid=${callSid ?? "unknown"})`,
    );
    return storedTwiml;
  }

  private getStreamAuthToken(callSid: string): string {
    const existing = this.streamAuthTokens.get(callSid);
    if (existing) {
      return existing;
    }
    const token = crypto.randomBytes(16).toString("base64url");
    this.streamAuthTokens.set(callSid, token);
    return token;
  }

  getStreamConnectXml(streamUrl: string): string {
    // Extract token from URL and pass via <Parameter> instead of query string.
    // Twilio strips query params from WebSocket URLs, but delivers <Parameter>
    // values in the "start" message's customParameters field.
    const parsed = new URL(streamUrl);
    const token = parsed.searchParams.get("token");
    parsed.searchParams.delete("token");
    const cleanUrl = parsed.toString();

    const paramXml = token ? `\n      <Parameter name="token" value="${escapeXml(token)}" />` : "";

    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(cleanUrl)}">${paramXml}
    </Stream>
  </Connect>
</Response>`;
  }

  /**
   * Initiate an outbound call via Twilio API.
   * If preConnectTwiml is provided, the first webhook request receives that
   * TwiML before normal dynamic TwiML resumes.
   */
  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    const url = new URL(input.webhookUrl);
    url.searchParams.set("callId", input.callId);

    const statusUrl = new URL(input.webhookUrl);
    statusUrl.searchParams.set("callId", input.callId);
    statusUrl.searchParams.set("type", "status");

    if (!input.inlineTwiml && input.preConnectTwiml) {
      this.twimlStorage.set(input.callId, input.preConnectTwiml);
      console.log(
        `[voice-call] Stored Twilio initial TwiML for call ${input.callId} (kind=pre-connect)`,
      );
    }

    const params: Record<string, string | string[]> = {
      To: input.to,
      From: input.from,
      StatusCallback: statusUrl.toString(),
      StatusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      Timeout: "30",
    };

    if (input.inlineTwiml) {
      params.Twiml = input.inlineTwiml;
      console.log(
        `[voice-call] Sending direct Twilio initial TwiML for call ${input.callId} (kind=notify)`,
      );
    } else {
      params.Url = url.toString();
    }

    const result = await this.apiRequest<TwilioCallResponse>("/Calls.json", params);

    this.callWebhookUrls.set(result.sid, url.toString());

    return {
      providerCallId: result.sid,
      status: result.status === "queued" ? "queued" : "initiated",
    };
  }

  async hangupCall(input: HangupCallInput): Promise<void> {
    await this.apiRequest(
      `/Calls/${input.providerCallId}.json`,
      { Status: "completed" },
      { allowNotFound: true },
    );
    this.releaseCallState(input.providerCallId, input.callId);
  }

  /**
   * Play TTS audio via Twilio.
   *
   * Two modes:
   * 1. Core TTS + Media Streams: when an active stream exists, stream playback is required.
   *    If telephony TTS is unavailable in that state, playback fails rather than mixing paths.
   * 2. TwiML <Say>: fallback only when there is no active stream for the call.
   */
  async playTts(input: PlayTtsInput): Promise<void> {
    if (input.isCurrent && !input.isCurrent()) {
      throw new Error("Automatic reply superseded");
    }
    if (this.isHybridMode && input.audioUrl) {
      const queue = this.getHybridQueue()!;
      const wasEmpty = !queue.has(input.providerCallId);
      queue.enqueue(input.providerCallId, input.audioUrl, input.callId, input.isCurrent);
      queue.markDone(input.providerCallId, input.endCall === true);
      if (wasEmpty) {
        await queue.triggerFirst(input.providerCallId);
      }
      return;
    }
    const streamSid = this.callStreamMap.get(input.providerCallId);
    if (streamSid) {
      if (!this.ttsProvider || !this.mediaStreamHandler) {
        throw new Error(
          "Telephony TTS unavailable while media stream is active; refusing TwiML fallback",
        );
      }

      try {
        await this.playTtsViaStream(input.text, streamSid);
        return;
      } catch (err) {
        console.warn(
          `[voice-call] Telephony TTS failed:`,
          err instanceof Error ? err.message : err,
        );
        throw err instanceof Error ? err : new Error(String(err));
      }
    }

    const webhookUrl = this.requireCallWebhookUrl(input.providerCallId);

    console.warn(
      "[voice-call] Using TwiML <Say> fallback - telephony TTS not configured or media stream not active",
    );

    const pollyVoice = mapVoiceToPolly(input.voice);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${pollyVoice}" language="${input.locale || "en-US"}">${escapeXml(input.text)}</Say>
  <Gather input="speech" speechTimeout="auto" action="${escapeXml(webhookUrl)}" method="POST">
    <Say>.</Say>
  </Gather>
</Response>`;

    await this.updateLiveCallTwiml(input.providerCallId, twiml, "playTts");
  }

  async sendDtmf(input: SendDtmfInput): Promise<void> {
    await this.updateLiveCallTwiml(
      input.providerCallId,
      generateDtmfRedirectTwiml(input.digits, this.requireCallWebhookUrl(input.providerCallId)),
      "sendDtmf",
    );
  }

  /**
   * Play TTS via core TTS and Twilio Media Streams.
   * Generates audio with core TTS, converts to mu-law, and streams via WebSocket.
   * Uses a queue to serialize playback and prevent overlapping audio.
   */
  private async playTtsViaStream(text: string, streamSid: string): Promise<void> {
    if (!this.ttsProvider || !this.mediaStreamHandler) {
      throw new Error("TTS provider and media stream handler required");
    }

    // Stream audio in 20ms chunks (160 bytes at 8kHz mu-law)
    const CHUNK_SIZE = 160;
    const CHUNK_DELAY_MS = 20;
    const SILENCE_CHUNK = Buffer.alloc(CHUNK_SIZE, 0xff);

    const handler = this.mediaStreamHandler;
    const ttsProvider = this.ttsProvider;

    await handler.queueTts(streamSid, async (signal) => {
      const sendKeepAlive = () => {
        handler.sendAudio(streamSid, SILENCE_CHUNK);
      };
      sendKeepAlive();
      const keepAlive = setInterval(() => {
        if (!signal.aborted) {
          sendKeepAlive();
        }
      }, CHUNK_DELAY_MS);

      let muLawAudio: Buffer;
      let synthTimeout: ReturnType<typeof setTimeout> | null = null;
      let removeAbortListener = () => {};
      const synthTimeoutMs = ttsProvider.synthesisTimeoutMs;
      try {
        const synthPromise = ttsProvider.synthesizeForTelephony(text);
        const timeoutPromise = new Promise<Buffer>((_, reject) => {
          synthTimeout = setTimeout(() => {
            reject(new Error(`Telephony TTS synthesis timed out after ${synthTimeoutMs}ms`));
          }, synthTimeoutMs);
        });
        const abortPromise = new Promise<never>((_, reject) => {
          const onAbort = () => {
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error("Telephony TTS synthesis aborted"),
            );
          };
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () => signal.removeEventListener("abort", onAbort);
          if (signal.aborted) {
            onAbort();
          }
        });
        muLawAudio = await Promise.race([synthPromise, timeoutPromise, abortPromise]);
      } finally {
        if (synthTimeout) {
          clearTimeout(synthTimeout);
        }
        clearInterval(keepAlive);
        removeAbortListener();
      }

      if (muLawAudio.length === 0) {
        throw new Error("Telephony TTS produced no audio");
      }

      let chunkAttempts = 0;
      let nextChunkDueAt = Date.now() + CHUNK_DELAY_MS;
      for (let offset = 0; offset < muLawAudio.length; offset += CHUNK_SIZE) {
        if (signal.aborted) {
          break;
        }
        chunkAttempts += 1;
        if (!handler.sendAudio(streamSid, muLawAudio.subarray(offset, offset + CHUNK_SIZE))) {
          handler.clearAudio(streamSid);
          throw new Error(
            `Telephony stream playback failed: audio chunk ${chunkAttempts} not delivered`,
          );
        }

        // Drift-corrected pacing: schedule against an absolute clock to avoid cumulative delay.
        const waitMs = nextChunkDueAt - Date.now();
        if (waitMs > 0) {
          try {
            await sleepWithAbort(Math.ceil(waitMs), signal);
          } catch (error) {
            if (!signal.aborted) {
              throw error;
            }
            break;
          }
        }
        nextChunkDueAt += CHUNK_DELAY_MS;
        if (signal.aborted) {
          break;
        }
      }

      if (signal.aborted) {
        return;
      }
      const markName = `tts-${Date.now()}-${++this.playbackMarkSequence}`;
      await handler.sendMarkAndWait(streamSid, markName, muLawAudio.length / 8, signal);
    });
  }

  async startListening(input: StartListeningInput): Promise<void> {
    const actionUrl = new URL(this.requireCallWebhookUrl(input.providerCallId));
    if (input.turnToken) {
      actionUrl.searchParams.set("turnToken", input.turnToken);
    }

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" speechTimeout="auto" language="${input.language || "en-US"}" action="${escapeXml(actionUrl.toString())}" method="POST">
  </Gather>
</Response>`;

    await this.updateLiveCallTwiml(input.providerCallId, twiml, "startListening");
  }

  private requireCallWebhookUrl(providerCallId: string): string {
    const webhookUrl = this.callWebhookUrls.get(providerCallId);
    if (!webhookUrl) {
      throw new Error("Missing webhook URL for this call (provider state not initialized)");
    }
    return webhookUrl;
  }

  // Twilio's <Gather> automatically stops on speech end.
  async stopListening(_input: StopListeningInput): Promise<void> {}

  async getCallStatus(input: GetCallStatusInput): Promise<GetCallStatusResult> {
    return readProviderCallStatus(
      () =>
        guardedJsonApiRequest<{ status?: string }>({
          url: `${this.baseUrl}/Calls/${input.providerCallId}.json`,
          method: "GET",
          headers: {
            Authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}`,
          },
          allowNotFound: true,
          allowedHostnames: [new URL(this.baseUrl).hostname],
          auditContext: "twilio-get-call-status",
          errorPrefix: "Twilio get call status error",
        }),
      (data) => {
        const status = normalizeProviderStatus(data.status);
        return { status, isTerminal: isProviderStatusTerminal(status) };
      },
    );
  }
}

interface TwilioCallResponse {
  sid: string;
  status: string;
}
