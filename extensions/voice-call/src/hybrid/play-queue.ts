/**
 * Hybrid mode TTS play queue.
 *
 * Each call has a queue of pre-generated public audio URLs.  The first sentence
 * is injected via Twilio Call Update with `<Play>{url}</Play><Redirect>...`.
 * Twilio plays the audio, then POSTs to the redirect URL; the webhook responds
 * with TwiML for the next sentence (or `<Connect><CR>` to resume relay).
 *
 * Barge-in: when the STT VAD signals `speech_started`, we increment the
 * queue's generation counter (invalidating any in-flight redirects) and
 * issue a Call Update to switch back to ConversationRelay.
 */

import {
  buildPauseThenRedirectTwiml,
  buildPlayThenRedirectTwiml,
  buildResumeRelayTwiml,
  HYBRID_HANGUP_TWIML,
  type ConversationRelayOptions,
} from "./twiml.js";

export type HybridPlayQueueEntry = {
  urls: string[];
  drained: number;
  done: boolean;
  endCall: boolean;
  callId?: string;
  /** Bumped on barge-in to invalidate in-flight redirects. */
  generation: number;
};

export type CallUpdateApi = {
  /** POST `<Twiml>` to `/Calls/{sid}.json`. */
  updateCallTwiml(callSid: string, twiml: string): Promise<void>;
  /** Build the public redirect URL for the next-sentence callback. */
  getPlayNextUrl(callSid: string, callId?: string): string | null;
  /** Resolve current ConversationRelay options (wsUrl + voice/etc). */
  getConversationRelayOptions(): ConversationRelayOptions | null;
};

export class HybridPlayQueue {
  private readonly queues = new Map<string, HybridPlayQueueEntry>();
  private readonly interrupted = new Set<string>();

  constructor(private readonly api: CallUpdateApi) {}

  /** Whether a queue exists for this call (even if empty/aborted). */
  has(callSid: string): boolean {
    return this.queues.has(callSid);
  }

  /** Queue a sentence's public audio URL. */
  enqueue(callSid: string, publicUrl: string, callId?: string): void {
    let q = this.queues.get(callSid);
    if (!q) {
      q = { urls: [], drained: 0, done: false, endCall: false, callId, generation: 0 };
      this.queues.set(callSid, q);
    }
    q.urls.push(publicUrl);
    console.log(
      `[voice-call][hybrid] Queued sentence #${q.urls.length - 1} for ${callSid}: ${publicUrl}`,
    );
  }

  /** Mark all sentences queued — no more will follow for this turn. */
  markDone(callSid: string, endCall = false): void {
    const q = this.queues.get(callSid);
    if (q) {
      q.done = true;
      q.endCall = endCall;
    }
  }

  /** Clear the queue + interrupt flag for a call. */
  clear(callSid: string): void {
    this.queues.delete(callSid);
    this.interrupted.delete(callSid);
  }

  /**
   * Check if this callSid just interrupted hybrid playback.  Single-use:
   * automatically clears the flag after checking.
   */
  consumeInterruptFlag(callSid: string): boolean {
    if (this.interrupted.has(callSid)) {
      this.interrupted.delete(callSid);
      return true;
    }
    return false;
  }

  /**
   * Trigger the first queued sentence via Call Update.  Twilio replaces the
   * active TwiML (`<Connect><CR>`) with `<Play><Redirect>`.  The CR socket
   * gets disconnected — expected in hybrid mode.
   */
  async triggerFirst(callSid: string): Promise<void> {
    const q = this.queues.get(callSid);
    if (!q || q.drained >= q.urls.length) {
      return;
    }
    const url = q.urls[q.drained];

    const redirectUrl = this.api.getPlayNextUrl(callSid, q.callId);
    if (!redirectUrl) {
      this.clear(callSid);
      throw new Error(`No hybrid play-next URL available for ${callSid}`);
    }

    const twiml = buildPlayThenRedirectTwiml(url, redirectUrl);
    console.log(`[voice-call][hybrid] Playing first sentence via Call Update for ${callSid}`);
    try {
      await this.api.updateCallTwiml(callSid, twiml);
      q.drained++;
    } catch (err) {
      this.clear(callSid);
      console.error(
        `[voice-call][hybrid] Call Update for first play failed for ${callSid}:`,
        err instanceof Error ? err.message : err,
      );
      throw err;
    }
  }

  /**
   * Abort hybrid playback immediately when user interrupts.  Clears the queue
   * and switches back to ConversationRelay mode via Call Update.
   */
  async abort(callSid: string): Promise<void> {
    const q = this.queues.get(callSid);
    if (!q) {
      return;
    }

    console.log(
      `[voice-call][hybrid] User interrupted playback for ${callSid}, aborting play queue`,
    );

    this.interrupted.add(callSid);
    q.generation++;
    q.urls = [];
    q.drained = 0;

    const cr = this.api.getConversationRelayOptions();
    if (!cr) {
      console.warn(`[voice-call][hybrid] No CR options available to abort ${callSid}`);
      return;
    }

    try {
      await this.api.updateCallTwiml(callSid, buildResumeRelayTwiml(cr));
      console.log(
        `[voice-call][hybrid] Switched from PLAYING to RELAY for ${callSid} due to interrupt`,
      );
    } catch (err) {
      console.error(
        `[voice-call][hybrid] Failed to abort play for ${callSid}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Handle the playAction redirect callback.  Returns TwiML for the next
   * sentence, resumes ConversationRelay when done, or hangs up if endCall.
   */
  handlePlayNextAction(callSid: string, callId?: string): string {
    const q = this.queues.get(callSid);
    const cr = this.api.getConversationRelayOptions();

    console.log(
      `[voice-call][hybrid] handlePlayNextAction callSid=${callSid} ` +
        `queueLen=${q?.urls.length ?? "none"} drained=${q?.drained ?? "N/A"} done=${q?.done ?? "N/A"} generation=${q?.generation ?? "N/A"}`,
    );

    // Stale redirect after barge-in → resume CR
    if (q && this.interrupted.has(callSid)) {
      console.log(
        `[voice-call][hybrid] Ignoring stale Redirect for interrupted call ${callSid}, resuming CR`,
      );
      this.clear(callSid);
      return cr ? buildResumeRelayTwiml(cr) : HYBRID_HANGUP_TWIML;
    }

    // More sentences queued → play next
    if (q && q.drained < q.urls.length) {
      const url = q.urls[q.drained];
      q.drained++;
      const redirectUrl = this.api.getPlayNextUrl(callSid, callId ?? q.callId);
      if (!redirectUrl) {
        return cr ? buildResumeRelayTwiml(cr) : HYBRID_HANGUP_TWIML;
      }
      return buildPlayThenRedirectTwiml(url, redirectUrl);
    }

    // All sentences played + end call → hang up
    if (q?.done && q?.endCall) {
      this.clear(callSid);
      return HYBRID_HANGUP_TWIML;
    }

    // All sentences played → resume CR
    if (q?.done) {
      this.clear(callSid);
      console.log(`[voice-call][hybrid] All sentences played, resuming CR for ${callSid}`);
      return cr ? buildResumeRelayTwiml(cr) : HYBRID_HANGUP_TWIML;
    }

    // No queue at all → resume relay
    if (!q) {
      return cr ? buildResumeRelayTwiml(cr) : HYBRID_HANGUP_TWIML;
    }

    // Queue not yet marked done — LLM still generating.  Pause then redirect.
    const redirectUrl = this.api.getPlayNextUrl(callSid, callId ?? q?.callId);
    if (!redirectUrl) {
      return cr ? buildResumeRelayTwiml(cr) : HYBRID_HANGUP_TWIML;
    }
    return buildPauseThenRedirectTwiml(redirectUrl, 1);
  }
}
