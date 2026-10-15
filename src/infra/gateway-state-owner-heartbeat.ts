import fs from "node:fs";
import { runInNewContext } from "node:vm";
import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { runInDetachedAsyncContext } from "../shared/async-work-scope.js";
import { GATEWAY_OWNER_HEARTBEAT_MS } from "./gateway-lock-payload.js";
import { observeGatewayStateOwnerLocks } from "./gateway-state-owner-diagnostics.js";
import type { GatewayStateOwnerHeartbeatData } from "./gateway-state-owner-heartbeat.runtime.js";
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
  heldLocks: Iterable<{ lockPath: string; verifyStillHeld(): boolean }>,
  onLost: (error: Error) => void,
) {
  const locks: Record<string, string> = {};
  for (const lock of heldLocks) {
    locks[lock.lockPath] = fs.readFileSync(lock.lockPath, "utf8");
    if (!lock.verifyStillHeld()) {
      throw new Error("OpenClaw state ownership is no longer current");
    }
  }
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
    });
    const inspect = () => {
      // Drain diagnostics synchronously when native work resumes before port callbacks.
      let message;
      while ((message = receiveMessageOnPort(port1))) {
        failure = message.message;
      }
      // Sample after loading the beat so concurrent renewal cannot appear to be in the future.
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
        onLost(
          new Error(
            `Gateway state ownership is no longer current at ${Object.keys(locks)[0]}: ${failure ?? (age < 0 ? "heartbeat clock moved backwards" : "utimes heartbeat renewal did not complete within 60 seconds")}; restart the Gateway.`,
          ),
        );
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
