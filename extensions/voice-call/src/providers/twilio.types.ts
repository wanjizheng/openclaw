import type { WebhookSecurityConfig } from "../config.js";

/**
 * Twilio Voice API provider options.
 */
export interface TwilioProviderOptions {
  /** Allow ngrok free tier compatibility mode (loopback only, less secure) */
  allowNgrokFreeTierLoopbackBypass?: boolean;
  /** Override public URL for signature verification */
  publicUrl?: string;
  /** Path for media stream WebSocket (e.g., /voice/stream) */
  streamPath?: string;
  /** Skip webhook signature verification (development only) */
  skipVerification?: boolean;
  /** Webhook security options (forwarded headers/allowlist) */
  webhookSecurity?: WebhookSecurityConfig;
  /**
   * Enable hybrid mode (fork): `<Start><Stream>` (STT-only fork) +
   * `<Connect><ConversationRelay>` (event channel) + Twilio Call Update
   * `<Play>` for TTS.  Requires `crPath` and a ConversationRelay-capable
   * account.
   */
  hybridMode?: boolean;
  /** Path for the ConversationRelay WebSocket when hybrid mode is enabled. */
  crPath?: string;
}
