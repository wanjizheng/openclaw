import { describe, expect, it } from "vitest";
import { CallRecordSchema } from "../types.js";
import { HybridCrAdmission } from "./cr-admission.js";

function fixture() {
  let time = 0;
  let current = true;
  const calls = new Map(
    ["A", "B"].map((id) => [
      id,
      CallRecordSchema.parse({
        callId: `call-${id}`,
        providerCallId: id,
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
  const owner = new HybridCrAdmission(
    () => current,
    () => time,
  );
  owner.bind((sid) => calls.get(sid));
  const issue = (sid = "A") => {
    const options = owner.issue("https://example.test/voice", "/voice/cr", sid);
    if (!options?.actionUrl) {
      throw new Error("Expected exact-call options");
    }
    return { ws: new URL(options.wsUrl), action: new URL(options.actionUrl) };
  };
  const claim = (url: URL) => {
    const admission = owner.claim(url);
    if (!admission) {
      throw new Error("Expected unspent admission");
    }
    return admission;
  };
  return {
    owner,
    issue,
    claim,
    calls,
    expire: () => {
      time = 5 * 60_000;
    },
    retire: () => {
      current = false;
    },
  };
}

describe("provider-owned CR admission", () => {
  it("uses unpredictable one-use call-scoped grants and rotates fresh reconnect URLs", () => {
    const { owner, issue, claim } = fixture();
    const first = issue();
    expect(first.ws.searchParams.get("crToken")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.ws.searchParams.get("callId")).toBe("call-A");
    const admitted = claim(first.ws);
    expect(owner.claim(first.ws)).toBeUndefined();
    expect(owner.promote(admitted, "A")).toBe(true);
    const resumed = owner.reconnect(first.action, "A", "https://example.test/voice", "/voice/cr");
    expect(resumed).not.toBeNull();
    expect(resumed?.wsUrl).not.toBe(first.ws.toString());
    expect(owner.reconnect(first.action, "A", "https://example.test/voice")).toBeNull();
    expect(owner.claim(first.ws)).toBeUndefined();
    expect(owner.isActive(admitted)).toBe(true);
    const next = claim(new URL(resumed!.wsUrl));
    expect(owner.promote(next, "A")).toBe(true);
    expect(owner.isActive(admitted)).toBe(false);
  });

  it("rotation and failed setup leave the previous live connection current", () => {
    const { owner, issue, claim } = fixture();
    const first = claim(issue().ws);
    expect(owner.promote(first, "A")).toBe(true);
    const second = claim(issue().ws);
    expect(owner.isActive(first)).toBe(true);
    expect(owner.promote(second, "B")).toBe(false);
    expect(owner.isActive(first)).toBe(true);
    const third = claim(issue().ws);
    expect(owner.promote(second, "A")).toBe(false);
    expect(owner.promote(third, "A")).toBe(true);
    expect(owner.isActive(first)).toBe(false);
  });

  it("cannot use another call's token, identity or action SID", () => {
    const { owner, issue, claim } = fixture();
    const first = issue();
    const active = claim(first.ws);
    expect(owner.promote(active, "A")).toBe(true);
    const pending = issue();
    for (const [key, value] of [
      ["crCallSid", "B"],
      ["callId", "call-B"],
      ["crToken", "unpredictable"],
    ]) {
      const forged = new URL(pending.ws);
      forged.searchParams.set(key!, value!);
      expect(owner.claim(forged)).toBeUndefined();
      expect(owner.isActive(active)).toBe(true);
    }
    expect(owner.reconnect(pending.action, "B", "https://example.test/voice")).toBeNull();
    expect(owner.claim(pending.ws)).toBeDefined();
  });

  it.each(["expire", "retire", "terminal", "revoke", "rebind"] as const)(
    "rejects %s admission",
    (boundary) => {
      const { owner, issue, calls, expire, retire } = fixture();
      const issued = issue();
      if (boundary === "expire") {
        expire();
      }
      if (boundary === "retire") {
        retire();
      }
      if (boundary === "terminal") {
        calls.get("A")!.state = "hangup-bot";
      }
      if (boundary === "revoke") {
        owner.revoke("A");
      }
      if (boundary === "rebind") {
        owner.bind((sid) => calls.get(sid));
      }
      expect(owner.claim(issued.ws)).toBeUndefined();
      expect(owner.reconnect(issued.action, "A", "https://example.test/voice")).toBeNull();
    },
  );

  it("expires uncompleted setup without expiring an already promoted long call", () => {
    const { owner, issue, claim, expire } = fixture();
    const active = claim(issue().ws);
    expect(owner.promote(active, "A")).toBe(true);
    const pending = claim(issue().ws);
    expire();
    expect(owner.promote(pending, "A")).toBe(false);
    expect(owner.isActive(active)).toBe(true);
  });
});
