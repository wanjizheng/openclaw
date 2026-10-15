import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { CallRecordSchema } from "../types.js";
import { HybridCrAdmission } from "./cr-admission.js";
import { HybridPlayQueue } from "./play-queue.js";

function createQueue(updateCallTwiml = vi.fn(async (_sid: string, _twiml: string) => {})) {
  const queue = new HybridPlayQueue({
    updateCallTwiml,
    getPlayNextUrl: () => "https://example.test/voice?playAction=1",
    getConversationRelayOptions: () => ({ wsUrl: "wss://example.test/voice/cr" }),
  });
  return { queue, updateCallTwiml };
}

describe("HybridPlayQueue", () => {
  it("issues call-scoped fresh relay options only when resuming or interrupting", async () => {
    const getConversationRelayOptions = vi.fn((sid: string) => ({
      wsUrl: `wss://example.test/cr?call=${sid}&token=fresh`,
      actionUrl: `https://example.test/voice?call=${sid}&action=fresh`,
    }));
    const updateCallTwiml = vi.fn(async () => {});
    const queue = new HybridPlayQueue({
      updateCallTwiml,
      getPlayNextUrl: () => "https://example.test/voice?playAction=1",
      getConversationRelayOptions,
    });
    queue.enqueue("CA1", "https://example.test/one.mp3", "call-1");
    queue.markDone("CA1");
    await queue.triggerFirst("CA1");
    expect(getConversationRelayOptions).not.toHaveBeenCalled();
    expect(queue.handlePlayNextAction("CA1")).toContain(
      'action="https://example.test/voice?call=CA1&amp;action=fresh"',
    );
    expect(getConversationRelayOptions).toHaveBeenCalledWith("CA1");
    queue.enqueue("CA2", "https://example.test/two.mp3", "call-2");
    await queue.abort("CA2");
    expect(getConversationRelayOptions).toHaveBeenLastCalledWith("CA2");
    expect(updateCallTwiml).toHaveBeenLastCalledWith(
      "CA2",
      expect.stringContaining("call=CA2&amp;token=fresh"),
      expect.any(Function),
    );
  });
  it("plays the first queued URL through a Twilio call update", async () => {
    const { queue, updateCallTwiml } = createQueue();
    queue.enqueue("CA123", "https://example.test/audio/hello.mp3", "call-1");

    await queue.triggerFirst("CA123");

    expect(updateCallTwiml).toHaveBeenCalledWith(
      "CA123",
      expect.stringContaining("<Play>https://example.test/audio/hello.mp3</Play>"),
      expect.any(Function),
    );
    expect(queue.has("CA123")).toBe(true);
  });

  it("releases the queue and reports a failed first call update", async () => {
    const updateError = new Error("call is no longer in progress");
    const { queue } = createQueue(
      vi.fn(async (_sid: string, _twiml: string) => {
        throw updateError;
      }),
    );
    queue.enqueue("CA123", "https://example.test/audio/hello.mp3", "call-1");

    await expect(queue.triggerFirst("CA123")).rejects.toBe(updateError);

    expect(queue.has("CA123")).toBe(false);
  });
});

describe("hybrid completion and callback identity", () => {
  it("hangs up only when the final audio redirect arrives", async () => {
    const { queue, updateCallTwiml } = createQueue();
    queue.enqueue("CA1", "https://example.test/audio/bye.mp3", "call-1");
    queue.markDone("CA1", true);
    await queue.triggerFirst("CA1");
    expect(updateCallTwiml.mock.calls[0]?.[1]).not.toContain("<Hangup");
    expect(queue.handlePlayNextAction("CA1", "call-1")).toContain("<Hangup/>");
  });

  it("a callback from an interrupted turn cannot drain a newer turn", async () => {
    const { queue, updateCallTwiml } = createQueue();
    queue.enqueue("CA1", "https://example.test/audio/old.mp3", "call-1");
    await queue.triggerFirst("CA1");
    const first = updateCallTwiml.mock.calls[0]![1];
    const token = /playToken=([^&<]+)/.exec(first)![1];
    await queue.abort("CA1");
    queue.enqueue("CA1", "https://example.test/audio/new.mp3", "call-1");
    const stale = queue.handlePlayNextAction("CA1", "call-1", token, 1);
    expect(stale).not.toContain("new.mp3");
    await queue.triggerFirst("CA1");
    expect(updateCallTwiml.mock.calls.at(-1)?.[1]).toContain("new.mp3");
  });
});

it("issues a fresh callback identity for pending audio so replay cannot pin a pause", async () => {
  const { queue, updateCallTwiml } = createQueue();
  queue.enqueue("CA1", "https://example.test/audio/first.mp3", "call-1");
  await queue.triggerFirst("CA1");
  const token = /playToken=([^&<]+)/.exec(updateCallTwiml.mock.calls[0]![1])![1];
  const pending = queue.handlePlayNextAction("CA1", "call-1", token, 1);
  expect(pending).toContain("playStep=2");
  queue.markDone("CA1", true);
  expect(queue.handlePlayNextAction("CA1", "call-1", token, 2)).toContain("<Hangup/>");
});

it("a rejected old Call Update cannot erase a newer turn's queue", async () => {
  const oldUpdate = createDeferred<void>();
  const failure = new Error("superseded old update");
  const update = vi
    .fn(async (_sid: string, _twiml: string) => {})
    .mockImplementationOnce(() => oldUpdate.promise);
  const { queue } = createQueue(update);
  queue.enqueue("CA1", "https://example.test/audio/old.mp3", "call-1");
  const oldPlayback = queue.triggerFirst("CA1");
  const rejection = expect(oldPlayback).rejects.toBe(failure);
  await queue.abort("CA1");
  queue.enqueue("CA1", "https://example.test/audio/new.mp3", "call-1");
  oldUpdate.reject(failure);
  await rejection;
  expect(queue.has("CA1")).toBe(true);
  await queue.triggerFirst("CA1");
  expect(update.mock.calls.at(-1)?.[1]).toContain("new.mp3");
});

function createAdmissionQueue() {
  const calls = new Map(
    ["CA1", "CA2"].map((sid) => [
      sid,
      CallRecordSchema.parse({
        callId: `call-${sid}`,
        providerCallId: sid,
        provider: "twilio",
        direction: "outbound",
        state: "listening",
        from: "+15550000001",
        to: "+15550000002",
        startedAt: 1,
        transcript: [],
        processedEventIds: [],
      }),
    ]),
  );
  const admission = new HybridCrAdmission(
    () => true,
    () => 0,
  );
  admission.bind((sid) => calls.get(sid));
  const getConversationRelayOptions = vi.fn((sid: string) =>
    admission.issue("https://example.test/voice", "/voice/cr", sid),
  );
  const updateCallTwiml = vi.fn(
    async (_sid: string, _twiml: string, _isCurrent?: () => boolean) => {},
  );
  const queue = new HybridPlayQueue({
    updateCallTwiml,
    getPlayNextUrl: () => "https://example.test/voice?playAction=1",
    getConversationRelayOptions,
  });
  const callback = (twiml: string) => {
    const token = /playToken=([^&<]+)/.exec(twiml)?.[1];
    const step = /playStep=(\d+)/.exec(twiml)?.[1];
    if (!token || !step) {
      throw new Error("Expected current playback callback identity");
    }
    return { token, step: Number(step) };
  };
  return { queue, admission, updateCallTwiml, getConversationRelayOptions, callback };
}

describe("obsolete redirects cannot rotate current relay admission", () => {
  it.each([false, true])(
    "retains the barge-in grant while its update is pending (new playback: %s)",
    async (newPlayback) => {
      const { queue, admission, updateCallTwiml, getConversationRelayOptions, callback } =
        createAdmissionQueue();
      const initial = getConversationRelayOptions("CA1")!;
      const first = admission.claim(new URL(initial.wsUrl))!;
      expect(admission.promote(first, "CA1")).toBe(true);
      queue.enqueue("CA1", "https://example.test/old.mp3", "call-CA1");
      await queue.triggerFirst("CA1");
      const old = callback(updateCallTwiml.mock.calls[0]![1]);
      const releaseAbort = createDeferred<void>();
      updateCallTwiml.mockImplementationOnce(() => releaseAbort.promise);
      const abort = queue.abort("CA1");
      const resumed = getConversationRelayOptions.mock.results.at(-1)!.value!;
      expect(resumed.wsUrl).not.toBe(initial.wsUrl);
      if (newPlayback) {
        queue.enqueue("CA1", "https://example.test/new.mp3", "call-CA1");
      }
      try {
        const obsolete = queue.handlePlayNextAction("CA1", "call-CA1", old.token, old.step);
        const wrongCall = new URL(resumed.wsUrl);
        wrongCall.searchParams.set("crCallSid", "CA2");
        expect(admission.claim(wrongCall)).toBeUndefined();
        expect(admission.isActive(first)).toBe(true);
        const claimed = admission.claim(new URL(resumed.wsUrl));
        expect(claimed).toBeDefined();
        // Revoked HTTP redirects are acknowledged, but their discarded bodies mint no grant.
        expect(obsolete).not.toMatch(/<(?:Connect|ConversationRelay|Play|Redirect|Hangup)\b/);
        expect(getConversationRelayOptions).toHaveBeenCalledTimes(2);
        expect(admission.claim(new URL(resumed.wsUrl))).toBeUndefined();
        expect(admission.promote(claimed!, "CA2")).toBe(false);
        expect(admission.promote(claimed!, "CA1")).toBe(true);
        expect(queue.has("CA1")).toBe(newPlayback);
        // A pending abort update must not supersede a newly queued response.
        expect(updateCallTwiml.mock.calls[1]![2]?.()).toBe(!newPlayback);
        if (newPlayback) {
          await queue.triggerFirst("CA1");
          expect(updateCallTwiml.mock.calls.at(-1)![1]).toContain("new.mp3");
        }
      } finally {
        releaseAbort.resolve();
        await abort;
      }
    },
  );

  it("keeps valid playback progression and final resume while rejecting stale identities", async () => {
    const { queue, admission, updateCallTwiml, getConversationRelayOptions, callback } =
      createAdmissionQueue();
    queue.enqueue("CA1", "https://example.test/first.mp3", "call-CA1");
    queue.enqueue("CA1", "https://example.test/second.mp3", "call-CA1");
    queue.markDone("CA1");
    await queue.triggerFirst("CA1");
    const first = callback(updateCallTwiml.mock.calls[0]![1]);
    for (const [callId, token, step] of [
      ["call-CA2", first.token, first.step],
      ["call-CA1", "obsolete-token", first.step],
      ["call-CA1", first.token, first.step + 1],
    ] as const) {
      expect(queue.handlePlayNextAction("CA1", callId, token, step)).not.toMatch(
        /<(?:Connect|ConversationRelay|Play|Redirect|Hangup)\b/,
      );
    }
    expect(getConversationRelayOptions).not.toHaveBeenCalled();
    const next = queue.handlePlayNextAction("CA1", "call-CA1", first.token, first.step);
    expect(next).toContain("second.mp3");
    const second = callback(next);
    expect(queue.handlePlayNextAction("CA1", "call-CA1", first.token, first.step)).not.toMatch(
      /<(?:Connect|ConversationRelay|Play|Redirect|Hangup)\b/,
    );
    expect(getConversationRelayOptions).not.toHaveBeenCalled();
    const resume = queue.handlePlayNextAction("CA1", "call-CA1", second.token, second.step);
    expect(resume).toContain("<ConversationRelay");
    const resumed = getConversationRelayOptions.mock.results[0]!.value!;
    expect(queue.has("CA1")).toBe(false);
    expect(queue.handlePlayNextAction("CA1", "call-CA1", second.token, second.step)).not.toMatch(
      /<(?:Connect|ConversationRelay|Play|Redirect|Hangup)\b/,
    );
    expect(getConversationRelayOptions).toHaveBeenCalledOnce();
    expect(admission.claim(new URL(resumed.wsUrl))).toBeDefined();
  });
});
