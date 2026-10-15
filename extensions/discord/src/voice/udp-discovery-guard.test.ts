import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installUdpDiscoveryGuard } from "./udp-discovery-guard.js";

describe("audio worker UDP discovery guard", () => {
  it("suppresses only the known reconnect rejection and forwards other failures", () => {
    const events = new EventEmitter();
    const fail = vi.fn();
    const warn = vi.fn();
    const dispose = installUdpDiscoveryGuard(fail, warn, events);
    const promise = Promise.resolve();
    events.emit(
      "unhandledRejection",
      new Error("Cannot perform IP discovery - socket closed"),
      promise,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(fail).not.toHaveBeenCalled();
    for (const reason of [
      new Error("prefix Cannot perform IP discovery - socket closed"),
      "Cannot perform IP discovery - socket closed",
      new Error("other failure"),
      undefined,
    ]) {
      events.emit("unhandledRejection", reason, promise);
      expect(fail).toHaveBeenLastCalledWith(reason);
    }
    expect(fail).toHaveBeenCalledTimes(4);
    dispose();
    expect(events.listenerCount("unhandledRejection")).toBe(0);
  });

  it("releases only its own listener when the audio worker stops", () => {
    const events = new EventEmitter();
    const sibling = vi.fn();
    events.on("unhandledRejection", sibling);
    const dispose = installUdpDiscoveryGuard(vi.fn(), vi.fn(), events);
    dispose();
    dispose();
    expect(events.listeners("unhandledRejection")).toEqual([sibling]);
  });
});
