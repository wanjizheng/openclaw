// Voice Call plugin module implements twiml behavior.
import { escapeXml } from "../voice-mapping.js";

// TwiML builders for manager-initiated notify and DTMF redirect flows.

/** Generate TwiML that speaks one notification and hangs up. */
export function generateNotifyTwiml(message: string, voice: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}">${escapeXml(message)}</Say>
  <Hangup/>
</Response>`;
}

/**
 * Fork custom: hybrid-mode variant of generateNotifyTwiml.
 *
 * Replaces `<Hangup/>` with `<Pause length="30"/>` so the call stays
 * in-progress long enough for the hybrid Call Update `<Play>` path
 * to inject the ElevenLabs-generated mp3 mid-call. The speak()
 * function's auto-hangup-after-initial-message timer (3s default by
 * `outbound.notifyHangupDelaySec`) cleans up the call once the audio
 * is queued, and Twilio's 30s pause acts as a safety net for cases
 * where the Call Update never fires.
 *
 * Without this, Twilio completes the call as soon as `<Say>` finishes
 * and `client.calls(sid).update({twiml:<Play>})` fails with
 * "400 Call is not in-progress. Cannot redirect." — the
 * `[voice-call][hybrid] Call Update for first play failed` error in
 * the gateway log.
 */
export function generateHybridNotifyTwiml(message: string, voice: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}">${escapeXml(message)}</Say>
  <Pause length="30"/>
</Response>`;
}

/** Generate TwiML that plays DTMF digits before redirecting to a webhook URL. */
export function generateDtmfRedirectTwiml(digits: string, webhookUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play digits="${escapeXml(digits)}" />
  <Redirect method="POST">${escapeXml(webhookUrl)}</Redirect>
</Response>`;
}
