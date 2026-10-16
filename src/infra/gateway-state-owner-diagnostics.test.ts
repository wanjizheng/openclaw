import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  capture,
  createGatewayStateOwnerDiagnostic,
  unavailable,
  type DiagnosticOwner,
  observeGatewayStateOwnerLocks,
} from "./gateway-state-owner-diagnostics.js";

describe("Gateway ownership failure diagnostics", () => {
  it("keeps the terminal custody loss visible while freezing bounded diagnostics in its cause", () => {
    const reason = new Error(
      "synthetic.lock: no longer current; lock removed/replaced; restart the Gateway.",
    );
    const lost = new AbortController();
    const owner: DiagnosticOwner = { kind: "process", accepting: true, lost };
    const diagnostic = capture(owner, reason);
    owner.accepting = false;
    lost.abort(reason);
    const error = unavailable("synthetic.sqlite", owner);
    expect(error.message).toMatch(/lock removed\/replaced; restart the Gateway\.$/);
    expect(error.message).not.toContain("Gateway state ownership diagnostic:");
    expect(error.cause).toBe(diagnostic);
    expect(diagnostic.cause).toBe(reason);
    expect(
      JSON.parse(diagnostic.message.slice("Gateway state ownership diagnostic: ".length)),
    ).toMatchObject({ accepting: true, originalReason: { message: reason.message } });
    expect(unavailable("synthetic.sqlite", owner).cause).toBe(diagnostic);
  });

  it("transports bounded original Error fields and redacts token assignments", () => {
    const reason = Object.assign(
      new Error('synthetic EIO: token="private-custody" ' + "x".repeat(3_000)),
      { code: "EIO" },
    );
    const diagnostic = createGatewayStateOwnerDiagnostic(
      { kind: "schema", accepting: true },
      reason,
    );
    const facts = JSON.parse(
      diagnostic.message.slice("Gateway state ownership diagnostic: ".length),
    );
    expect(facts.originalReason).toMatchObject({
      name: "Error",
      code: "EIO",
      message: expect.stringContaining("synthetic EIO"),
    });
    expect(facts.originalReason.message.length).toBeLessThanOrEqual(2_048);
    expect(diagnostic.message).not.toContain("private-custody");
    expect(diagnostic.cause).toBe(reason);
    const lost = new AbortController();
    lost.abort(reason);
    const visible = unavailable("synthetic.sqlite", {
      kind: "schema",
      accepting: false,
      lost,
      failureDiagnostic: diagnostic,
    });
    expect(visible.message).not.toContain("private-custody");
    expect(visible.message.length).toBeLessThan(2_300);
    expect(visible.cause).toBe(diagnostic);
  });
  it("identifies missing or replaced lock bytes without exposing custody tokens", async () => {
    await withTempDir("openclaw-owner-diagnostics-", async (root) => {
      const lockPath = path.join(root, "owner.lock");
      const expected = '{"token":"synthetic-original-custody"}';
      const replacement = '{"token":"synthetic-replacement-custody"}';
      fs.writeFileSync(lockPath, expected);
      const held = observeGatewayStateOwnerLocks({ [lockPath]: expected });
      expect(held[0]).toMatchObject({ exists: true, payloadMatches: true });
      fs.writeFileSync(lockPath, replacement);
      const changed = observeGatewayStateOwnerLocks({ [lockPath]: expected });
      expect(changed[0]).toMatchObject({ exists: true, payloadMatches: false });
      expect(changed[0]?.payloadSha256).not.toBe(held[0]?.payloadSha256);
      fs.unlinkSync(lockPath);
      const missing = observeGatewayStateOwnerLocks({ [lockPath]: expected });
      expect(missing[0]).toMatchObject({ exists: false, errorCode: "ENOENT" });
      const reason = new Error("owner lock was replaced");
      const diagnostic = createGatewayStateOwnerDiagnostic(
        { kind: "schema", accepting: true, heartbeat: { locks: changed } },
        reason,
      );
      expect(diagnostic.cause).toBe(reason);
      expect(diagnostic.message).not.toContain("synthetic-original-custody");
      expect(diagnostic.message).not.toContain("synthetic-replacement-custody");
    });
  });
});
