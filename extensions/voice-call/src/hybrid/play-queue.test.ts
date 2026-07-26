import { describe, expect, it, vi } from "vitest";
import { HybridPlayQueue } from "./play-queue.js";

function createQueue(updateCallTwiml = vi.fn(async () => {})) {
  const queue = new HybridPlayQueue({
    updateCallTwiml,
    getPlayNextUrl: () => "https://example.test/voice?playAction=1",
    getConversationRelayOptions: () => ({ wsUrl: "wss://example.test/voice/cr" }),
  });
  return { queue, updateCallTwiml };
}

describe("HybridPlayQueue", () => {
  it("plays the first queued URL through a Twilio call update", async () => {
    const { queue, updateCallTwiml } = createQueue();
    queue.enqueue("CA123", "https://example.test/audio/hello.mp3", "call-1");

    await queue.triggerFirst("CA123");

    expect(updateCallTwiml).toHaveBeenCalledWith(
      "CA123",
      expect.stringContaining("<Play>https://example.test/audio/hello.mp3</Play>"),
    );
    expect(queue.has("CA123")).toBe(true);
  });

  it("releases the queue and reports a failed first call update", async () => {
    const updateError = new Error("call is no longer in progress");
    const { queue } = createQueue(
      vi.fn(async () => {
        throw updateError;
      }),
    );
    queue.enqueue("CA123", "https://example.test/audio/hello.mp3", "call-1");

    await expect(queue.triggerFirst("CA123")).rejects.toBe(updateError);

    expect(queue.has("CA123")).toBe(false);
  });
});
