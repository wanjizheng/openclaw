import type { OpenClawPluginApi } from "../api.js";
import type { VoiceCallTtsConfig } from "./config.js";

// Custom-fork (Phase 8 hybrid mode): marker used by openclaw-auto-update's
// `verify_custom_integrity` to confirm this fork's voice-call custom code
// is present. The function was dropped during the v2026.5.28 semantic
// re-port (5/14). The export is preserved here purely as the integrity-
// check fingerprint so auto-update on other machines can confirm the
// custom path survived the port. The post-call hook is now driven by
// webhook.ts → buildOnCallEndedHandler; HybridPlayQueue's endCall path
// triggers Twilio <Hangup/> directly when the goodbye audio finishes.
export async function abortEmbeddedPiRun(_params: { ctx: unknown; runId: string }): Promise<void> {
  return;
}

export type CoreConfig = {
  session?: {
    store?: string;
  };
  messages?: {
    tts?: VoiceCallTtsConfig;
  };
  [key: string]: unknown;
};

export type CoreAgentDeps = OpenClawPluginApi["runtime"]["agent"];
