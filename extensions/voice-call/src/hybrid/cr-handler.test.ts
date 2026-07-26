import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { CallManager } from "../manager.js";
import type { CallRecord } from "../types.js";
import { HybridCrHandler } from "./cr-handler.js";

describe("HybridCrHandler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("speaks the greeting with the provider call ID from the CR setup event", async () => {
    vi.useFakeTimers();
    const call = {
      callId: "internal-call-id",
      providerCallId: "CA-provider-id",
      state: "ringing",
      direction: "inbound",
      metadata: { initialMessage: "Hello" },
    } as CallRecord;
    const processEvent = vi.fn();
    const manager = {
      getCallByProviderCallId: vi.fn(() => call),
      processEvent,
    } as unknown as CallManager;
    const speakInitialMessage = vi.fn(async () => {});
    const handler = new HybridCrHandler({
      manager,
      isHybridPlaying: () => false,
      speakInitialMessage,
    });
    const ws = new EventEmitter() as unknown as WebSocket;

    (
      handler as unknown as {
        handleConnection(socket: WebSocket): void;
      }
    ).handleConnection(ws);
    ws.emit("message", Buffer.from(JSON.stringify({ type: "setup", callSid: "CA-provider-id" })));
    await vi.advanceTimersByTimeAsync(300);

    expect(processEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "call.answered",
        callId: "internal-call-id",
        providerCallId: "CA-provider-id",
      }),
    );
    expect(speakInitialMessage).toHaveBeenCalledWith("CA-provider-id");
  });
});
