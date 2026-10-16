import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceCallConfigSchema } from "../config.js";
import type { VoiceCallProvider } from "../providers/base.js";
import type { CallRecord, PlayTtsInput } from "../types.js";
import type { CallManagerContext } from "./context.js";
import { initiateCall, speak, speakInitialMessage } from "./outbound.js";

const mocks = vi.hoisted(() => ({
  generateHybridAudioUrl: vi.fn(),
  persistCallRecord: vi.fn(async () => {}),
}));
vi.mock("../hybrid/audio-pipeline.js", () => ({
  generateHybridAudioUrl: mocks.generateHybridAudioUrl,
}));
vi.mock("./store.js", () => ({ persistCallRecord: mocks.persistCallRecord }));

const contexts: CallManagerContext[] = [];
function fixture() {
  const dial = vi.fn<VoiceCallProvider["initiateCall"]>(async () => ({
    providerCallId: "CA-hybrid",
    status: "initiated",
  }));
  const playback = vi.fn(async (_input: PlayTtsInput) => {});
  const provider: VoiceCallProvider = {
    name: "twilio",
    verifyWebhook: () => ({ ok: true }),
    parseWebhookEvent: () => ({ events: [] }),
    initiateCall: dial,
    playTts: playback,
    hangupCall: async () => {},
    startListening: async () => {},
    stopListening: async () => {},
    getCallStatus: async () => ({ status: "in-progress", isTerminal: false }),
  };
  const ctx: CallManagerContext = {
    activeCalls: new Map(),
    providerCallIdMap: new Map(),
    processedEventIds: new Set(),
    rejectedProviderCallIds: new Map(),
    provider,
    config: VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "twilio",
      agentId: "sales",
      fromNumber: "+15550000000",
      outbound: { defaultMode: "conversation" },
      streaming: { enabled: true, hybridMode: true },
    }),
    storePath: "/synthetic/call-state",
    webhookUrl: "https://example.test/voice",
    mutationQueue: new KeyedAsyncQueue(),
    pendingCallAdmissions: new Set(),
    trackCallWork: () => {},
    isStopping: () => false,
    activeTurnCalls: new Set(),
    endCallOperations: new Map(),
    transcriptWaiters: new Map(),
    maxDurationTimers: new Map(),
    notifyHangupTimers: new Map(),
    initialMessageInFlight: new Set(),
  };
  contexts.push(ctx);
  return { ctx, dial, playback };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.generateHybridAudioUrl.mockReset();
});
afterEach(() => {
  for (const ctx of contexts.splice(0)) {
    for (const timer of [...ctx.maxDurationTimers.values(), ...ctx.notifyHangupTimers.values()]) {
      clearTimeout(timer);
    }
  }
});

describe("hybrid greeting and playback admission", () => {
  it("synthesizes before dialing, reserves admission, and reuses the greeting URL on answer", async () => {
    const { ctx, dial, playback } = fixture();
    const audio = createDeferred<string | undefined>();
    const entered = createDeferred<void>();
    mocks.generateHybridAudioUrl.mockImplementation(() => {
      entered.resolve();
      return audio.promise;
    });
    const pending = initiateCall(ctx, "+15550000001", undefined, { message: "Hello" });
    await entered.promise;
    expect(dial).not.toHaveBeenCalled();
    expect(ctx.pendingCallAdmissions.size).toBe(1);
    audio.resolve("https://example.test/audio/greeting.mp3");
    const result = await pending;
    expect(result.success).toBe(true);
    expect(ctx.pendingCallAdmissions.size).toBe(0);
    expect(ctx.activeCalls.get(result.callId)?.metadata?.initialMessageAudioUrl).toContain(
      "greeting.mp3",
    );
    await speakInitialMessage(ctx, "CA-hybrid");
    expect(mocks.generateHybridAudioUrl).toHaveBeenCalledTimes(1);
    expect(playback).toHaveBeenCalledWith(
      expect.objectContaining({
        audioUrl: "https://example.test/audio/greeting.mp3",
        text: "Hello",
      }),
    );
    expect(ctx.activeCalls.get(result.callId)?.metadata?.initialMessageAudioUrl).toBeUndefined();
  });

  it.each(["missing", "error"])(
    "falls back to on-answer synthesis when pregeneration fails (%s)",
    async (failure) => {
      const { ctx, dial, playback } = fixture();
      if (failure === "error") {
        mocks.generateHybridAudioUrl.mockRejectedValueOnce(
          new Error("synthetic synthesis failure"),
        );
      } else {
        mocks.generateHybridAudioUrl.mockResolvedValueOnce(undefined);
      }
      mocks.generateHybridAudioUrl.mockResolvedValueOnce("https://example.test/audio/fallback.mp3");
      const result = await initiateCall(ctx, "+15550000001", undefined, { message: "Hello" });
      expect(result.success).toBe(true);
      expect(dial).toHaveBeenCalledTimes(1);
      await speakInitialMessage(ctx, "CA-hybrid");
      expect(mocks.generateHybridAudioUrl).toHaveBeenCalledTimes(2);
      expect(playback).toHaveBeenCalledWith(
        expect.objectContaining({ audioUrl: "https://example.test/audio/fallback.mp3" }),
      );
    },
  );

  it("does not play synthesized audio after barge-in supersedes its response", async () => {
    const { ctx, playback } = fixture();
    const call: CallRecord = {
      callId: "call-1",
      agentId: "sales",
      providerCallId: "CA-hybrid",
      provider: "twilio",
      direction: "outbound",
      state: "listening",
      from: "+15550000000",
      to: "+15550000001",
      startedAt: Date.now(),
      transcript: [],
      processedEventIds: [],
    };
    ctx.activeCalls.set(call.callId, call);
    const audio = createDeferred<string | undefined>();
    const entered = createDeferred<void>();
    mocks.generateHybridAudioUrl.mockImplementation(() => {
      entered.resolve();
      return audio.promise;
    });
    let current = true;
    const pending = speak(ctx, call.callId, "Superseded reply", { isCurrent: () => current });
    await entered.promise;
    current = false;
    audio.resolve("https://example.test/audio/stale.mp3");
    expect(await pending).toMatchObject({ success: false });
    expect(playback).not.toHaveBeenCalled();
    expect(call.state).toBe("listening");
    expect(call.transcript).toHaveLength(0);
  });
});
