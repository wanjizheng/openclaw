import fs from "node:fs";
import { runInNewContext } from "node:vm";
import { MessageChannel } from "node:worker_threads";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { runInDetachedAsyncContext } from "../shared/async-work-scope.js";
import { GATEWAY_OWNER_HEARTBEAT_MS } from "./gateway-lock-payload.js";
import { observeGatewayStateOwnerLocks } from "./gateway-state-owner-diagnostics.js";
import {
  type GatewayStateOwnerHeartbeatData,
  renewGatewayStateOwnerLock,
} from "./gateway-state-owner-heartbeat.runtime.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { captureRuntimeWorkerSource } from "./runtime-worker-generation.js";
import {
  resolveRuntimeWorkerThreadExecArgv,
  resolveRuntimeWorkerUrl,
} from "./runtime-worker-url.js";
import { createCpuTrackedWorker } from "./worker-cpu.js";

// Native workers and lock mtimes use wall epoch. A separate realm keeps this
// clock independent of business Date replacements, even when imported inside one.
// The expression is constant and receives no application objects or code.
const nativeDateNow: unknown = runInNewContext("Date.now");
const ambientDateIsFakeAtImport = "isFake" in Date && Date.isFake === true;
const ambientDateNameAtImport = Date.name;
function now(): number {
  if (typeof nativeDateNow !== "function") {
    throw new Error("Native custody epoch clock is unavailable");
  }
  const epoch: unknown = Reflect.apply(nativeDateNow, undefined, []);
  if (typeof epoch !== "number" || !Number.isFinite(epoch)) {
    throw new Error("Native custody epoch clock returned an invalid timestamp");
  }
  return epoch;
}

/** Process and schema owners share one renewal worker and one failure deadline. */
export function startGatewayStateOwnerHeartbeat(
  heldLocks: ReadonlySet<{ lockPath: string; verifyStillHeld(): boolean }>,
  onLost: (error: Error) => void,
) {
  const locks: Record<string, string> = {};
  for (const lock of heldLocks) {
    locks[lock.lockPath] = fs.readFileSync(lock.lockPath, "utf8");
    if (!lock.verifyStillHeld()) {
      throw new Error("OpenClaw state ownership is no longer current");
    }
  }
  const rootPath = Object.keys(locks)[0];
  if (!rootPath) {
    throw new Error("Gateway state ownership requires a held lock");
  }
  const rootIdentity = fs.statSync(rootPath, { bigint: true });
  const { moduleUrl: url, runtimeGeneration } = captureRuntimeWorkerSource(
    resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.gatewayStateOwnerHeartbeat),
  );
  return runInDetachedAsyncContext(() => {
    const lastBeat = new BigInt64Array(new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT));
    // Match the lock's mtime clock; Bun workers have independent hrtime origins.
    Atomics.store(lastBeat, 0, BigInt(now()));
    const { port1, port2 } = new MessageChannel();
    const worker = createCpuTrackedWorker(url, {
      workerData: {
        clock: "epoch",
        locks,
        intervalMs: GATEWAY_OWNER_HEARTBEAT_MS,
        failureMs: 60_000,
        lastBeat: lastBeat.buffer,
        events: port2,
      } satisfies GatewayStateOwnerHeartbeatData,
      transferList: [port2],
      execArgv: resolveRuntimeWorkerThreadExecArgv(url),
    });
    worker.unref();
    // Parent expiration checks verify physical custody directly.
    port1.on("message", () => undefined);
    port1.unref();
    let failure: string | null = null;
    let observation:
      | {
          clock: "epoch";
          clockSource: "isolated-realm-Date.now";
          ambientDateIsFakeAtImport: boolean;
          ambientDateNameAtImport: string;
          globalNow: number;
          now: number;
          performanceNow: number;
          lastBeat: string;
          ageMs: number;
          remainingMs: number;
          workerThreadId: number;
          failure: string | null;
        }
      | undefined;
    worker.on("error", (error) => {
      failure = coerceErrorMessage(error);
      onLost(new Error(`${failure}; restart Gateway.`));
    });
    const inspect = () => {
      const renewedAt = Atomics.load(lastBeat, 0);
      const sampledAt = now();
      const age = sampledAt - Number(renewedAt);
      const remaining = age < 0 ? 0 : 60_000 - age;
      observation = {
        clock: "epoch",
        clockSource: "isolated-realm-Date.now",
        ambientDateIsFakeAtImport,
        ambientDateNameAtImport,
        globalNow: Date.now(),
        now: sampledAt,
        performanceNow: performance.now(),
        lastBeat: String(renewedAt),
        ageMs: age,
        remainingMs: remaining,
        workerThreadId: worker.threadId,
        failure,
      };
      if (remaining <= 0) {
        try {
          const renewalStartedAt = now();
          const stamp = new Date(renewalStartedAt);
          for (const lock of heldLocks) {
            if (!lock.verifyStillHeld()) {
              if (lock.lockPath !== rootPath) {
                continue;
              }
              throw new Error("owner lock was removed or replaced");
            }
            const fd = fs.openSync(lock.lockPath, "r+");
            try {
              const held = fs.fstatSync(fd, { bigint: true });
              if (
                lock.lockPath === rootPath &&
                (held.dev !== rootIdentity.dev || held.ino !== rootIdentity.ino)
              ) {
                throw new Error("owner lock was removed or replaced");
              }
              const raw = fs.readFileSync(fd, "utf8");
              if (
                !lock.verifyStillHeld() ||
                !renewGatewayStateOwnerLock(fd, lock.lockPath, raw, stamp)
              ) {
                throw new Error("owner lock was removed or replaced");
              }
            } finally {
              fs.closeSync(fd);
            }
          }
          Atomics.store(lastBeat, 0, BigInt(renewalStartedAt));
          return 60_000;
        } catch (error) {
          failure = coerceErrorMessage(error);
          if (observation) {
            observation.failure = failure;
          }
          onLost(
            new Error(
              `Gateway state ownership is no longer current at ${rootPath}: ${coerceErrorMessage(error)}; restart the Gateway.`,
            ),
          );
        }
      }
      return remaining;
    };
    let timer: ReturnType<typeof setTimeout>;
    const watch = () => {
      const remaining = inspect();
      if (remaining > 0) {
        timer = setTimeout(watch, remaining);
        timer.unref();
      }
    };
    watch();
    let termination: Promise<number> | undefined;
    const stop = () => {
      if (termination) {
        return;
      }
      clearTimeout(timer);
      port1.close();
      worker.postMessage("stop", []);
      termination ??= worker.terminate();
    };
    runtimeGeneration?.retain(worker, async () => async () => {
      stop();
      await termination;
    });
    return {
      worker,
      paths: new Set(Object.keys(locks)),
      inspect,
      diagnostic: () => ({
        observation,
        locks: observeGatewayStateOwnerLocks(locks),
        lockCount: Object.keys(locks).length,
      }),
      stop,
    };
  });
}
