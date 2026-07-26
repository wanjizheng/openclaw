// Discord tests cover the @discordjs/voice UDP discovery rejection filter.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { judgeUdpDiscoveryRejection } from "./udp-discovery-guard.js";

describe("judgeUdpDiscoveryRejection", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("suppresses the benign UDP discovery race message", () => {
    const err = new Error("Cannot perform IP discovery - socket closed");
    expect(judgeUdpDiscoveryRejection(err)).toBe("suppress");
  });

  it("does not suppress a different Error message", () => {
    const err = new Error("Cannot perform IP discovery - some other cause");
    expect(judgeUdpDiscoveryRejection(err)).toBe("exit");
  });

  it("does not suppress a string with the same substring but a different error", () => {
    // Defensive: only exact message match should suppress.
    const err = new Error("prefix: Cannot perform IP discovery - socket closed suffix");
    expect(judgeUdpDiscoveryRejection(err)).toBe("exit");
  });

  it("exits on unrelated Error rejections", () => {
    expect(judgeUdpDiscoveryRejection(new Error("something else broke"))).toBe("exit");
  });

  it("exits on non-Error rejections", () => {
    expect(judgeUdpDiscoveryRejection("string rejection")).toBe("exit");
    expect(judgeUdpDiscoveryRejection(undefined)).toBe("exit");
    expect(judgeUdpDiscoveryRejection({ code: "ECONNRESET" })).toBe("exit");
  });
});
