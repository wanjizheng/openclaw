// Voice Call plugin module implements lifecycle behavior.
import type { CallRecord, EndReason } from "../types.js";
import type { CallManagerContext } from "./context.js";
import { transitionState } from "./state.js";
import { persistCallRecord } from "./store.js";
import { clearMaxDurationTimer, rejectTranscriptWaiter } from "./timers.js";

// Shared call finalization path for manager and webhook lifecycle exits.

type CallLifecycleContext = Pick<
  CallManagerContext,
  "activeCalls" | "providerCallIdMap" | "storePath"
> &
  Partial<
    Pick<
      CallManagerContext,
      "transcriptWaiters" | "maxDurationTimers" | "firedEndIds" | "onCallEnded"
    >
  >;

/** Remove a provider-call mapping only when it still points at this call. */
function removeProviderCallMapping(
  providerCallIdMap: Map<string, string>,
  call: Pick<CallRecord, "callId" | "providerCallId">,
): void {
  if (!call.providerCallId) {
    return;
  }
  const mappedCallId = providerCallIdMap.get(call.providerCallId);
  if (mappedCallId === call.callId) {
    providerCallIdMap.delete(call.providerCallId);
  }
}

/** Persist terminal state, clean timers/waiters, and remove active call indexes. */
export function finalizeCall(params: {
  ctx: CallLifecycleContext;
  call: CallRecord;
  endReason: EndReason;
  endedAt?: number;
  transcriptRejectReason?: string;
}): void {
  const { ctx, call, endReason } = params;

  call.endedAt = params.endedAt ?? Date.now();
  call.endReason = endReason;
  transitionState(call, endReason);
  persistCallRecord(ctx.storePath, call);

  if (ctx.maxDurationTimers) {
    clearMaxDurationTimer({ maxDurationTimers: ctx.maxDurationTimers }, call.callId);
  }
  if (ctx.transcriptWaiters) {
    rejectTranscriptWaiter(
      { transcriptWaiters: ctx.transcriptWaiters },
      call.callId,
      params.transcriptRejectReason ?? `Call ended: ${endReason}`,
    );
  }

  ctx.activeCalls.delete(call.callId);
  removeProviderCallMapping(ctx.providerCallIdMap, call);

  // Fire end-of-call hook exactly once per callId, even if finalizeCall is
  // invoked from multiple end paths (e.g. provider webhook + stream disconnect).
  if (ctx.onCallEnded) {
    const fired = ctx.firedEndIds;
    if (!fired || !fired.has(call.callId)) {
      fired?.add(call.callId);
      try {
        ctx.onCallEnded(call);
      } catch {
        // Hook errors must never break call cleanup.
      }
    }
  }
}
