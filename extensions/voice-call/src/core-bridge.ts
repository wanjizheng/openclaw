import type { OpenClawPluginApi } from "../api.js";
import type { VoiceCallCoreSessionConfig, VoiceCallTtsConfig } from "./config.js";

export type CoreConfig = {
  session?: VoiceCallCoreSessionConfig & { store?: string };
  messages?: {
    tts?: VoiceCallTtsConfig;
  };
  [key: string]: unknown;
};

export type CoreAgentDeps = OpenClawPluginApi["runtime"]["agent"];
