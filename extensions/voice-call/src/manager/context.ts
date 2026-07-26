// Voice Call plugin module implements context behavior.
import type { VoiceCallConfig, VoiceCallCoreSessionConfig } from "../config.js";
import type { VoiceCallProvider } from "../providers/base.js";
import type { CallId, CallRecord } from "../types.js";

type TranscriptWaiter = {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
  turnToken?: string;
};

type CallManagerRuntimeState = {
  activeCalls: Map<CallId, CallRecord>;
  providerCallIdMap: Map<string, CallId>;
  processedEventIds: Set<string>;
  /** Provider call IDs we already sent a reject hangup for; avoids duplicate hangup calls. */
  rejectedProviderCallIds: Set<string>;
  /** CallIds whose end-of-call hook has already fired; prevents duplicate post-call reports
   * when finalizeCall is invoked from multiple end paths (provider webhook + stream disconnect). */
  firedEndIds: Set<CallId>;
};

type CallManagerRuntimeDeps = {
  provider: VoiceCallProvider | null;
  config: VoiceCallConfig;
  coreSession?: VoiceCallCoreSessionConfig;
  storePath: string;
  webhookUrl: string | null;
};

type CallManagerTransientState = {
  activeTurnCalls: Set<CallId>;
  transcriptWaiters: Map<CallId, TranscriptWaiter>;
  maxDurationTimers: Map<CallId, NodeJS.Timeout>;
  initialMessageInFlight: Set<CallId>;
};

/** Issue a carrier-side stream session for a provider that attaches Media Streaming
 * at dial/answer time (e.g. Telnyx). Wired by the runtime when realtime is enabled. */
export type StreamSessionIssuer = (request: {
  providerName: "twilio" | "telnyx";
  callId: CallId;
  from?: string;
  to?: string;
  direction: "inbound" | "outbound";
}) => { token: string; streamUrl: string } | undefined;

type CallManagerHooks = {
  /** Optional runtime hook invoked after an event transitions a call into answered state. */
  onCallAnswered?: (call: CallRecord) => void;
  /** Optional runtime hook invoked exactly once after a call reaches a terminal state.
   * Receives the finalized CallRecord (transcript + endReason populated). */
  onCallEnded?: (call: CallRecord) => void;
  /** Carrier-side stream session issuer. Wired by the runtime when realtime is enabled. */
  streamSessionIssuer?: StreamSessionIssuer;
};

export type CallManagerContext = CallManagerRuntimeState &
  CallManagerRuntimeDeps &
  CallManagerTransientState &
  CallManagerHooks;
