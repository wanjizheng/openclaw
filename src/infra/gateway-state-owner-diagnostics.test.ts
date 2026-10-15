import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  createGatewayStateOwnerDiagnostic,
  observeGatewayStateOwnerLocks,
} from "./gateway-state-owner-diagnostics.js";

describe("Gateway ownership failure diagnostics", () => {
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
