/**
 * Voice call response generator - uses the embedded Pi agent for tool support.
 * Routes voice responses through the same agent infrastructure as messaging.
 */

import crypto from "node:crypto";
import { applyModelOverrideToSessionEntry } from "openclaw/plugin-sdk/model-session-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SessionEntry } from "../api.js";
import { resolveVoiceAgentId } from "./agent-routing.js";
import { resolveVoiceCallSessionKey, type VoiceCallConfig } from "./config.js";
import { findContactByPhone, loadContactsFileAsync, type ParsedContact } from "./contact-file.js";
import type { CoreAgentDeps, CoreConfig } from "./core-bridge.js";
import { stripLlmReasoningTags } from "./llm-tag-cleanup.js";
import { resolveVoiceResponseModel } from "./response-model.js";

export type VoiceResponseParams = {
  /** Voice call config */
  voiceConfig: VoiceCallConfig;
  /** Core OpenClaw config */
  coreConfig: CoreConfig;
  /** Injected host agent runtime */
  agentRuntime: CoreAgentDeps;
  /** Call ID for session tracking */
  callId: string;
  /** Persisted call session key */
  sessionKey?: string;
  /** Caller's phone number */
  from: string;
  /** Conversation transcript */
  transcript: Array<{ speaker: "user" | "bot"; text: string }>;
  /** Latest user message */
  userMessage: string;
};

export type VoiceResponseResult = {
  text: string | null;
  error?: string;
};

type VoiceResponsePayload = {
  text?: string;
  isError?: boolean;
  isReasoning?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readExplicitToolsAllow(value: unknown): string[] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const allow = value.allow;
  if (!Array.isArray(allow)) {
    return undefined;
  }

  return allow.filter((entry): entry is string => typeof entry === "string");
}

function resolveVoiceAgentToolsAllow(config: CoreConfig, agentId: string): string[] | undefined {
  const agents = isRecord(config.agents) ? config.agents : undefined;
  const list = Array.isArray(agents?.list) ? agents.list : [];
  const agent = list.find((entry) => isRecord(entry) && entry.id === agentId);
  if (!isRecord(agent)) {
    return undefined;
  }

  return readExplicitToolsAllow(isRecord(agent.tools) ? agent.tools : undefined);
}

const VOICE_SPOKEN_OUTPUT_CONTRACT = [
  "Output format requirements:",
  '- Return only valid JSON in this exact shape: {"spoken":"..."}',
  "- Do not include markdown, code fences, planning text, or extra keys.",
  '- Put exactly what should be spoken to the caller into "spoken".',
  '- If there is nothing to say, return {"spoken":""}.',
].join("\n");

function normalizeSpokenText(value: string): string | null {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function tryParseSpokenJson(text: string): string | null {
  const candidates: string[] = [];
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  candidates.push(trimmed);

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) {
    candidates.push(fenced[1]);
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { spoken?: unknown };
      if (typeof parsed?.spoken !== "string") {
        continue;
      }
      return normalizeSpokenText(parsed.spoken) ?? "";
    } catch {
      // Continue trying other candidates.
    }
  }

  const inlineSpokenMatch = trimmed.match(/"spoken"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
  if (!inlineSpokenMatch) {
    return null;
  }

  try {
    const decoded = JSON.parse(`"${inlineSpokenMatch[1] ?? ""}"`) as string;
    return normalizeSpokenText(decoded) ?? "";
  } catch {
    return null;
  }
}

function isLikelyMetaReasoningParagraph(paragraph: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(paragraph);
  if (!lower) {
    return false;
  }

  if (lower.startsWith("thinking process")) {
    return true;
  }
  if (lower.startsWith("reasoning:") || lower.startsWith("analysis:")) {
    return true;
  }
  if (
    lower.startsWith("the user ") &&
    (lower.includes("i should") || lower.includes("i need to") || lower.includes("i will"))
  ) {
    return true;
  }
  if (
    lower.includes("this is a natural continuation of the conversation") ||
    lower.includes("keep the conversation flowing")
  ) {
    return true;
  }

  return false;
}

function sanitizePlainSpokenText(text: string): string | null {
  const withoutCodeFences = text.replace(/```[\s\S]*?```/g, " ").trim();
  if (!withoutCodeFences) {
    return null;
  }

  const paragraphs = withoutCodeFences
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  while (paragraphs.length > 1 && isLikelyMetaReasoningParagraph(paragraphs[0])) {
    paragraphs.shift();
  }

  return normalizeSpokenText(paragraphs.join(" "));
}

function extractSpokenTextFromPayloads(payloads: VoiceResponsePayload[]): string | null {
  const spokenSegments: string[] = [];

  for (const payload of payloads) {
    if (payload.isError || payload.isReasoning) {
      continue;
    }

    const rawText = payload.text?.trim() ?? "";
    if (!rawText) {
      continue;
    }

    // Custom-fork: strip DeepSeek/anthropic-style <think>/<final> reasoning
    // tags BEFORE attempting JSON or plain-text parsing so the spoken text
    // never includes leaked chain-of-thought.
    const cleaned = stripLlmReasoningTags(rawText, { isFinal: true });
    const strippedText = cleaned.trim();
    if (!strippedText) {
      continue;
    }

    const structured = tryParseSpokenJson(strippedText);
    if (structured !== null) {
      if (structured.length > 0) {
        spokenSegments.push(structured);
      }
      continue;
    }

    const plain = sanitizePlainSpokenText(strippedText);
    if (plain) {
      spokenSegments.push(plain);
    }
  }

  return spokenSegments.length > 0 ? spokenSegments.join(" ").trim() : null;
}

function resolveVoiceSandboxSessionKey(agentId: string, sessionKey: string): string {
  const trimmed = sessionKey.trim();
  if (trimmed.toLowerCase().startsWith("agent:")) {
    return trimmed;
  }
  return `agent:${agentId}:${trimmed}`;
}

/**
 * Generate a voice response using the embedded Pi agent with full tool support.
 * Uses the same agent infrastructure as messaging for consistent behavior.
 */
export async function generateVoiceResponse(
  params: VoiceResponseParams,
): Promise<VoiceResponseResult> {
  const {
    voiceConfig,
    callId,
    sessionKey,
    from,
    transcript,
    userMessage,
    coreConfig,
    agentRuntime,
  } = params;

  if (!coreConfig) {
    return { text: null, error: "Core config unavailable for voice response" };
  }
  const cfg = coreConfig;

  const resolvedSessionKey = resolveVoiceCallSessionKey({
    config: voiceConfig,
    callId,
    phone: from,
    explicitSessionKey: sessionKey,
  });
  // Custom-fork: support sessionKey-prefixed agent ids (`agent:<id>:...`)
  // and fall back to voiceConfig.agentId or "main".
  const agentId = resolveVoiceAgentId({
    agentId: voiceConfig.agentId,
    sessionKey: resolvedSessionKey,
    fallback: "main",
  });
  const toolsAllow = resolveVoiceAgentToolsAllow(cfg, agentId);

  // Custom-fork: load CONTACT_LIST.md (if present) so we can enrich the
  // system prompt with caller name + per-contact info. Failures are
  // swallowed by loadContactsFileAsync.
  let contact: ParsedContact | undefined;
  try {
    const contacts = await loadContactsFileAsync();
    contact = findContactByPhone(from, contacts);
  } catch {
    contact = undefined;
  }

  // Resolve paths
  const storePath = agentRuntime.session.resolveStorePath(cfg.session?.store, { agentId });
  const agentDir = agentRuntime.resolveAgentDir(cfg, agentId);
  const workspaceDir = agentRuntime.resolveAgentWorkspaceDir(cfg, agentId);

  // Ensure workspace exists
  await agentRuntime.ensureAgentWorkspace({ dir: workspaceDir });

  // Load or create session entry
  const sessionStore = agentRuntime.session.loadSessionStore(storePath);
  const now = Date.now();
  const existingSessionEntry = sessionStore[resolvedSessionKey] as SessionEntry | undefined;

  // Resolve model from config
  const { provider, model } = resolveVoiceResponseModel({ voiceConfig, agentRuntime });

  let sessionEntry = existingSessionEntry;
  if (!sessionEntry?.sessionId || voiceConfig.responseModel) {
    sessionEntry = await agentRuntime.session.updateSessionStore(storePath, (store) => {
      let entry = store[resolvedSessionKey] as SessionEntry | undefined;
      if (!entry?.sessionId) {
        entry = {
          ...entry,
          sessionId: crypto.randomUUID(),
          updatedAt: now,
        };
        store[resolvedSessionKey] = entry;
      }
      if (voiceConfig.responseModel) {
        applyModelOverrideToSessionEntry({
          entry,
          selection: { provider, model },
          selectionSource: "auto",
        });
      }
      return entry;
    });
  }
  const sessionId = sessionEntry.sessionId;

  const sessionFile = agentRuntime.session.resolveSessionFilePath(sessionId, sessionEntry, {
    agentId,
  });

  // Resolve thinking level
  const thinkLevel = agentRuntime.resolveThinkingDefault({ cfg, provider, model });

  // Resolve agent identity for personalized prompt
  const identity = agentRuntime.resolveAgentIdentity(cfg, agentId);
  const agentName = identity?.name?.trim() || "assistant";

  // Build system prompt with conversation history
  const callerLabel = contact?.name ? `${contact.name} (${from})` : from;
  const basePrompt =
    voiceConfig.responseSystemPrompt ??
    `You are ${agentName}, a helpful voice assistant on a phone call. Keep responses brief and conversational (1-2 sentences max). Be natural and friendly. The caller is ${callerLabel}. You have access to tools - use them when helpful.`;

  let extraSystemPrompt = basePrompt;

  // Custom-fork: if the caller is a known contact, inject their per-contact
  // free-form info block so the agent has the right relational context.
  if (contact?.info) {
    extraSystemPrompt = `${extraSystemPrompt}\n\nCaller info:\n${contact.info}`;
  }

  if (transcript.length > 0) {
    const history = transcript
      .map((entry) => `${entry.speaker === "bot" ? "You" : "Caller"}: ${entry.text}`)
      .join("\n");
    extraSystemPrompt = `${extraSystemPrompt}\n\nConversation so far:\n${history}`;
  }
  extraSystemPrompt = `${extraSystemPrompt}\n\n${VOICE_SPOKEN_OUTPUT_CONTRACT}`;

  // Resolve timeout
  const timeoutMs = voiceConfig.responseTimeoutMs ?? agentRuntime.resolveAgentTimeoutMs({ cfg });
  const runId = `voice:${callId}:${Date.now()}`;

  try {
    const result = await agentRuntime.runEmbeddedPiAgent({
      sessionId,
      sessionKey: resolvedSessionKey,
      sandboxSessionKey: resolveVoiceSandboxSessionKey(agentId, resolvedSessionKey),
      agentId,
      messageProvider: "voice",
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: userMessage,
      provider,
      model,
      thinkLevel,
      verboseLevel: "off",
      timeoutMs,
      runId,
      lane: "voice",
      extraSystemPrompt,
      agentDir,
      toolsAllow,
    });

    const text = extractSpokenTextFromPayloads((result.payloads ?? []) as VoiceResponsePayload[]);

    if (!text && result.meta?.aborted) {
      return { text: null, error: "Response generation was aborted" };
    }

    return { text };
  } catch (err) {
    console.error(`[voice-call] Response generation failed:`, err);
    return { text: null, error: String(err) };
  }
}
