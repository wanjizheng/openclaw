/**
 * Hybrid mode TwiML builders.
 *
 * Hybrid mode uses three TwiML shapes:
 *  1. Initial: `<Start><Stream>` (one-way STT fork) + optional `<Play>` greeting
 *     + `<Connect><ConversationRelay>` (event channel).  Used when a call is
 *     first answered.
 *  2. Resume relay: `<Pause/><Connect><ConversationRelay/>` — used after a
 *     `<Play>` chain finishes (or after a barge-in interrupt) to put the call
 *     back into the CR event channel.
 *  3. Play next: `<Play>{url}</Play><Redirect>{playNextUrl}</Redirect>` —
 *     issued via Twilio Call Update to inject TTS audio mid-call.
 */

const ESCAPE_RE = /[<>&"']/g;
const ESCAPE_MAP: Record<string, string> = {
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  '"': "&quot;",
  "'": "&apos;",
};

export function escapeXml(str: string): string {
  return str.replace(ESCAPE_RE, (ch) => ESCAPE_MAP[ch] ?? ch);
}

/**
 * Defaults align with the prior fork build: ElevenLabs `bhJUNIXWQQ94l8eI2VUf`
 * voice + Deepgram nova-3-general STT inside CR.  Only Deepgram is used by CR
 * itself for VAD + DTMF; our own OpenAI STT runs in parallel on the inbound
 * `<Stream>` fork.
 */
export type ConversationRelayOptions = {
  wsUrl: string;
  language?: string;
  ttsProvider?: string;
  voice?: string;
  transcriptionProvider?: string;
  speechModel?: string;
  interruptible?: boolean;
  dtmfDetection?: boolean;
  welcomeGreeting?: string;
};

export function buildConversationRelayElement(opts: ConversationRelayOptions): string {
  const language = opts.language ?? "multi";
  const ttsProvider = opts.ttsProvider ?? "ElevenLabs";
  const voice = opts.voice ?? "bhJUNIXWQQ94l8eI2VUf";
  const transcriptionProvider = opts.transcriptionProvider ?? "Deepgram";
  const speechModel = opts.speechModel ?? "nova-3-general";
  const interruptible = opts.interruptible ?? true;
  const dtmfDetection = opts.dtmfDetection ?? true;
  const greetingAttr = opts.welcomeGreeting
    ? ` welcomeGreeting="${escapeXml(opts.welcomeGreeting)}"`
    : "";
  return `<ConversationRelay url="${escapeXml(opts.wsUrl)}" language="${escapeXml(language)}" ttsProvider="${escapeXml(ttsProvider)}" voice="${escapeXml(voice)}" transcriptionProvider="${escapeXml(transcriptionProvider)}" speechModel="${escapeXml(speechModel)}" interruptible="${interruptible}" dtmfDetection="${dtmfDetection}"${greetingAttr} />`;
}

export function buildConversationRelayTwiml(opts: ConversationRelayOptions): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    ${buildConversationRelayElement(opts)}
  </Connect>
</Response>`;
}

/**
 * Build TwiML for hybrid mode initial call setup.
 * Forks inbound audio via `<Start><Stream>` for our own STT, optionally plays
 * a greeting via `<Play>`, then connects ConversationRelay for events.
 */
export function buildHybridInitialTwiml(opts: {
  /** STT stream URL with optional `?token=...` query parameter. */
  streamUrl: string;
  /** ConversationRelay options (incl. wsUrl). */
  cr: ConversationRelayOptions;
  /** Optional public URL to a greeting audio file to `<Play>` before CR. */
  playUrl?: string;
}): string {
  const parsed = new URL(opts.streamUrl);
  const token = parsed.searchParams.get("token");
  parsed.searchParams.delete("token");
  const cleanStreamUrl = parsed.toString();
  const tokenParam = token ? `\n      <Parameter name="token" value="${escapeXml(token)}" />` : "";

  const playElement = opts.playUrl ? `\n  <Play>${escapeXml(opts.playUrl)}</Play>` : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="${escapeXml(cleanStreamUrl)}" track="inbound_track">${tokenParam}
    </Stream>
  </Start>${playElement}
  <Connect>
    ${buildConversationRelayElement(opts.cr)}
  </Connect>
</Response>`;
}

/**
 * Build TwiML to resume ConversationRelay after a `<Play>` chain finishes
 * (or after a barge-in interrupt).  No welcomeGreeting — this is reconnection.
 */
export function buildResumeRelayTwiml(cr: ConversationRelayOptions): string {
  const { welcomeGreeting: _ignored, ...rest } = cr;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="1"/>
  <Connect>
    ${buildConversationRelayElement(rest)}
  </Connect>
</Response>`;
}

export function buildPlayThenRedirectTwiml(audioUrl: string, redirectUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${escapeXml(audioUrl)}</Play>
  <Redirect method="POST">${escapeXml(redirectUrl)}</Redirect>
</Response>`;
}

export function buildPauseThenRedirectTwiml(redirectUrl: string, pauseSec = 1): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="${pauseSec}"/>
  <Redirect method="POST">${escapeXml(redirectUrl)}</Redirect>
</Response>`;
}

export const HYBRID_HANGUP_TWIML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`;
