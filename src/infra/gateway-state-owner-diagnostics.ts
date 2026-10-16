import { createHash } from "node:crypto";
import fs from "node:fs";

export type DiagnosticOwner = {
  kind: string;
  // Retained leases keep custody after this stops new admission.
  accepting: boolean;
  heartbeat?: { diagnostic(): unknown };
  lost: { signal: AbortSignal };
  failureDiagnostic?: ReturnType<typeof createGatewayStateOwnerDiagnostic>;
};

/** Freeze evidence before retirement changes accepting or stops the heartbeat. */
export function capture(owner: DiagnosticOwner, reason: unknown) {
  return (owner.failureDiagnostic ??= createGatewayStateOwnerDiagnostic(
    { kind: owner.kind, accepting: owner.accepting, heartbeat: owner.heartbeat?.diagnostic() },
    reason,
  ));
}

export function unavailable(databasePath: string, owner: DiagnosticOwner): Error {
  const cause = capture(owner, owner.lost.signal.reason);
  return new Error(
    `OpenClaw state ownership at ${databasePath} could not be verified; retry after maintenance finishes. ${cause.originalReason?.message ?? "Restart the Gateway."}`,
    { cause },
  );
}

/** Only fingerprints leave this boundary; lock payloads contain custody tokens. */
export function observeGatewayStateOwnerLocks(locks: Record<string, string>) {
  return Object.entries(locks)
    .slice(0, 16)
    .map(([lockPath, expected]) => {
      try {
        const stat = fs.lstatSync(lockPath, { bigint: true });
        const raw =
          stat.isFile() && stat.size <= 1_048_576n ? fs.readFileSync(lockPath, "utf8") : undefined;
        return {
          path: lockPath,
          exists: true,
          dev: String(stat.dev),
          ino: String(stat.ino),
          payloadMatches: raw === expected,
          payloadSha256:
            raw === undefined ? undefined : createHash("sha256").update(raw).digest("hex"),
        };
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
        return { path: lockPath, exists: code === "ENOENT" ? false : undefined, errorCode: code };
      }
    });
}

function createGatewayStateOwnerDiagnostic(
  facts: { kind: string; accepting: boolean; heartbeat?: unknown },
  reason: unknown,
) {
  // Serialize only the controlled Error fields, never arbitrary thrown objects or payloads.
  const originalReason =
    reason instanceof Error
      ? {
          name: reason.name.slice(0, 64),
          message: reason.message
            .slice(0, 2_048)
            .replace(
              /((?:["']?)(?:\w*token|ownerId|secret|authorization)(?:["']?)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi,
              "$1[redacted]",
            )
            .slice(0, 2_048),
          code:
            "code" in reason && (typeof reason.code === "string" || typeof reason.code === "number")
              ? String(reason.code).slice(0, 64)
              : undefined,
        }
      : undefined;
  const diagnostic = new Error(
    `Gateway state ownership diagnostic: ${JSON.stringify({ ...facts, originalReason })}`,
    {
      cause: reason instanceof Error ? reason : undefined,
    },
  );
  diagnostic.name = "GatewayStateOwnerDiagnosticError";
  return Object.assign(diagnostic, { code: "GATEWAY_STATE_OWNER_UNVERIFIED", originalReason });
}
