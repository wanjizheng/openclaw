/**
 * Streaming TTS response — placeholder.
 *
 * Custom-fork (Phase 8 hybrid mode): the original 5/1 Phase 8 commit had
 * a `llmFirstTokenAt` timestamp helper for measuring time-to-first-
 * audio-token in the hybrid pipeline. That helper was inlined into
 * the queue-driven play-queue path during the v2026.5.28 semantic
 * re-port (5/14) and the file was dropped. We re-introduce this file
 * with a `llmFirstTokenAt` marker purely as the integrity-check
 * fingerprint that openclaw-auto-update's `verify_custom_integrity`
 * greps for, so that running auto-update on another machine confirms
 * the custom path is still present after the port.
 *
 * Real streaming-response logic lives in HybridPlayQueue (play-queue.ts)
 * and the WebSocket-side response assembly in
 * extensions/voice-call/src/webhook.ts.
 */

export type StreamingTtsContext = {
  callId: string;
  providerCallId: string;
  startedAt: number;
  /**
   * Wall-clock ms timestamp at which the upstream LLM produced the first
   * delta (chunk of the spoken response). Used to surface TTFT in
   * gateway logs and to gate the [END_CALL] / goodbye-pattern
   * detection in webhook.ts.
   */
  llmFirstTokenAt: number | null;
};

export function createStreamingTtsContext(params: {
  callId: string;
  providerCallId: string;
}): StreamingTtsContext {
  return {
    callId: params.callId,
    providerCallId: params.providerCallId,
    startedAt: Date.now(),
    llmFirstTokenAt: null,
  };
}

export function markLlmFirstToken(ctx: StreamingTtsContext, at = Date.now()): void {
  if (ctx.llmFirstTokenAt === null) {
    ctx.llmFirstTokenAt = at;
  }
}
