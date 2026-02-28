import { TerminalStates, type CallId, type CallRecord } from "../types.js";
import type { CallManagerContext } from "./context.js";
import { persistCallRecord } from "./store.js";

type TimerContext = Pick<
  CallManagerContext,
  "activeCalls" | "maxDurationTimers" | "config" | "storePath" | "transcriptWaiters"
>;
type MaxDurationTimerContext = Pick<
  TimerContext,
  "activeCalls" | "maxDurationTimers" | "config" | "storePath"
>;
type TranscriptWaiterContext = Pick<TimerContext, "transcriptWaiters">;
type CallEndWaiterContext = Pick<CallManagerContext, "callEndWaiters" | "onCallEnded">;

export function clearMaxDurationTimer(
  ctx: Pick<MaxDurationTimerContext, "maxDurationTimers">,
  callId: CallId,
): void {
  const timer = ctx.maxDurationTimers.get(callId);
  if (timer) {
    clearTimeout(timer);
    ctx.maxDurationTimers.delete(callId);
  }
}

export function startMaxDurationTimer(params: {
  ctx: MaxDurationTimerContext;
  callId: CallId;
  onTimeout: (callId: CallId) => Promise<void>;
}): void {
  clearMaxDurationTimer(params.ctx, params.callId);

  const maxDurationMs = params.ctx.config.maxDurationSeconds * 1000;
  console.log(
    `[voice-call] Starting max duration timer (${params.ctx.config.maxDurationSeconds}s) for call ${params.callId}`,
  );

  const timer = setTimeout(async () => {
    params.ctx.maxDurationTimers.delete(params.callId);
    const call = params.ctx.activeCalls.get(params.callId);
    if (call && !TerminalStates.has(call.state)) {
      console.log(
        `[voice-call] Max duration reached (${params.ctx.config.maxDurationSeconds}s), ending call ${params.callId}`,
      );
      call.endReason = "timeout";
      persistCallRecord(params.ctx.storePath, call);
      await params.onTimeout(params.callId);
    }
  }, maxDurationMs);

  params.ctx.maxDurationTimers.set(params.callId, timer);
}

export function clearTranscriptWaiter(ctx: TranscriptWaiterContext, callId: CallId): void {
  const waiter = ctx.transcriptWaiters.get(callId);
  if (!waiter) {
    return;
  }
  clearTimeout(waiter.timeout);
  ctx.transcriptWaiters.delete(callId);
}

export function rejectTranscriptWaiter(
  ctx: TranscriptWaiterContext,
  callId: CallId,
  reason: string,
): void {
  const waiter = ctx.transcriptWaiters.get(callId);
  if (!waiter) {
    return;
  }
  clearTranscriptWaiter(ctx, callId);
  waiter.reject(new Error(reason));
}

export function resolveTranscriptWaiter(
  ctx: TranscriptWaiterContext,
  callId: CallId,
  transcript: string,
  turnToken?: string,
): boolean {
  const waiter = ctx.transcriptWaiters.get(callId);
  if (!waiter) {
    return false;
  }
  if (waiter.turnToken && waiter.turnToken !== turnToken) {
    return false;
  }
  clearTranscriptWaiter(ctx, callId);
  waiter.resolve(transcript);
  return true;
}

export function waitForFinalTranscript(
  ctx: TimerContext,
  callId: CallId,
  turnToken?: string,
): Promise<string> {
  if (ctx.transcriptWaiters.has(callId)) {
    return Promise.reject(new Error("Already waiting for transcript"));
  }

  const timeoutMs = ctx.config.transcriptTimeoutMs;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ctx.transcriptWaiters.delete(callId);
      reject(new Error(`Timed out waiting for transcript after ${timeoutMs}ms`));
    }, timeoutMs);

    ctx.transcriptWaiters.set(callId, { resolve, reject, timeout, turnToken });
  });
}

/**
 * Resolve a call-end waiter with the final call record.
 * Safe to call even if no waiter exists for the given callId.
 */
const firedCallEndIds = new Set<string>();

export function resolveCallEndWaiter(
  ctx: CallEndWaiterContext,
  callId: CallId,
  call: CallRecord,
): void {
  const snapshot = { ...call, transcript: [...call.transcript] };
  const waiter = ctx.callEndWaiters.get(callId);
  if (waiter) {
    ctx.callEndWaiters.delete(callId);
    waiter.resolve(snapshot);
  }
  // Fire the global hook exactly once per call end, regardless of waiter presence.
  if (!firedCallEndIds.has(callId)) {
    firedCallEndIds.add(callId);
    // Prevent unbounded growth — clean up after a short delay.
    setTimeout(() => firedCallEndIds.delete(callId), 60_000);
    ctx.onCallEnded?.(snapshot);
  }
}
