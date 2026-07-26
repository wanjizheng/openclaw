/**
 * Voice-call agent routing helpers.
 *
 * Custom-fork addition: extract a stable agent id from a session key (when
 * upstream encodes it as `agent:<id>:…`) so phone calls can be associated
 * with the right per-agent persona/context.
 */

const DEFAULT_VOICE_AGENT_ID = "main";

function normalizeNonEmpty(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function extractAgentIdFromSessionKey(sessionKey?: string | null): string | undefined {
  const key = normalizeNonEmpty(sessionKey);
  if (!key) {
    return undefined;
  }
  const match = key.match(/^agent:([^:]+):/i);
  return normalizeNonEmpty(match?.[1]);
}

export function resolveVoiceAgentId(params?: {
  agentId?: string | null;
  sessionKey?: string | null;
  fallback?: string;
}): string {
  const explicit = normalizeNonEmpty(params?.agentId);
  if (explicit) {
    return explicit;
  }
  const fromSession = extractAgentIdFromSessionKey(params?.sessionKey);
  if (fromSession) {
    return fromSession;
  }
  return normalizeNonEmpty(params?.fallback) ?? DEFAULT_VOICE_AGENT_ID;
}
