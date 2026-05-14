import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi } from "../api.js";
import { resolveVoiceAgentId } from "./agent-routing.js";
import type { VoiceCallConfig } from "./config.js";
import { findContactByPhone, loadContactsFileAsync } from "./contact-file.js";
import type { CoreConfig } from "./core-bridge.js";
import { deleteCallAudioFiles } from "./hybrid/audio-pipeline.js";
import { resolveVoiceResponseModel } from "./response-model.js";
import type { CallRecord } from "./types.js";

/**
 * Post-call reporting pipeline. Runs once per call after it reaches a terminal
 * state. Writes a call_logs/*.md report and DMs a summary to Discord.
 *
 * Errors are swallowed and logged — this must never affect call cleanup.
 */
export function buildOnCallEndedHandler(params: {
  api: OpenClawPluginApi;
  config: VoiceCallConfig;
}): (call: CallRecord) => void {
  const { api, config } = params;
  return (call: CallRecord) => {
    void deletePerCallSessionFile({ api, call }).catch((err) =>
      api.logger.warn(`[voice-call] session cleanup failed: ${formatErr(err)}`),
    );
    if (config.streaming?.hybridMode) {
      void deleteCallAudioFiles(call.callId).catch((err) =>
        api.logger.warn(`[voice-call][hybrid] audio cleanup failed: ${formatErr(err)}`),
      );
    }
    void runPostCallReport({ api, config, call }).catch((err) =>
      api.logger.warn(`[voice-call] post-call report failed: ${formatErr(err)}`),
    );
  };
}

function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function deletePerCallSessionFile(params: {
  api: OpenClawPluginApi;
  call: CallRecord;
}): Promise<void> {
  const { api, call } = params;
  const agentRuntime = api.runtime.agent;
  const cfg = api.config as CoreConfig;
  const agentId = resolveVoiceAgentId({ sessionKey: call.sessionKey });
  const storePath = agentRuntime.session.resolveStorePath(cfg.session?.store, { agentId });
  const sessionStore = agentRuntime.session.loadSessionStore(storePath);
  const sessionKey = `voice:${call.callId}`;
  const entry = sessionStore[sessionKey] as { sessionId: string; updatedAt: number } | undefined;
  if (!entry) {
    return;
  }
  const sessionFile = agentRuntime.session.resolveSessionFilePath(
    entry.sessionId,
    {},
    {
      agentId,
    },
  );
  delete sessionStore[sessionKey];
  await agentRuntime.session.saveSessionStore(storePath, sessionStore);
  await fsp.unlink(sessionFile).catch(() => {});
  api.logger.info(`[voice-call] Deleted per-call session for ${call.callId}`);
}

async function runPostCallReport(params: {
  api: OpenClawPluginApi;
  config: VoiceCallConfig;
  call: CallRecord;
}): Promise<void> {
  const { api, config, call } = params;
  const agentRuntime = api.runtime.agent;
  const cfg = api.config as CoreConfig;
  const agentId = resolveVoiceAgentId({ sessionKey: call.sessionKey });
  const workspaceDir = agentRuntime.resolveAgentWorkspaceDir(cfg, agentId);
  const agentDir = agentRuntime.resolveAgentDir(cfg, agentId);

  // --- Resolve contact name ---
  let callerName = call.metadata?.callerName as string | undefined;
  const isInbound = call.direction === "inbound";
  const otherPartyPhone = isInbound ? call.from : call.to;

  if (!callerName && otherPartyPhone) {
    try {
      const contacts = await loadContactsFileAsync();
      const contact = findContactByPhone(otherPartyPhone, contacts);
      if (contact?.name) {
        callerName = contact.name;
      }
    } catch {
      // Best-effort.
    }
  }

  const callerLabel = callerName ? `${callerName} (${otherPartyPhone})` : otherPartyPhone;
  const durationMs = call.endedAt && call.startedAt ? call.endedAt - call.startedAt : undefined;
  const durationStr = durationMs ? `${Math.round(durationMs / 1000)}秒` : "未知";

  // --- Resolve bot display name ---
  let botDisplayName = agentRuntime.resolveAgentIdentity(cfg, agentId)?.name?.trim() || "诺岚";
  try {
    const identityPath = path.join(workspaceDir, "IDENTITY.md");
    const identityContent = fs.readFileSync(identityPath, "utf-8");
    const nickMatch = identityContent.match(/^\s*-\s*\*\*NickName\*\*[:：]\s*(.+)$/im);
    const nameMatch = identityContent.match(/^\s*-\s*\*\*Name\*\*[:：]\s*(.+)$/im);
    const nick = nickMatch?.[1]?.trim();
    const name = nameMatch?.[1]?.trim();
    if (nick) {
      botDisplayName = nick;
    } else if (name) {
      botDisplayName = name;
    }
  } catch {
    // IDENTITY.md missing; keep fallback.
  }

  const otherPartyName = callerName ?? (isInbound ? "来电方" : "对方");

  const transcriptLines =
    call.transcript.length > 0
      ? call.transcript
          .map((t) => `[${t.speaker === "bot" ? botDisplayName : otherPartyName}] ${t.text}`)
          .join("\n")
      : "*(无通话记录)*";

  // --- Generate LLM summary ---
  let summary = "";
  if (call.transcript.length > 0) {
    try {
      const { provider, model } = resolveVoiceResponseModel({
        voiceConfig: config,
        agentRuntime,
      });
      const thinkLevel = agentRuntime.resolveThinkingDefault({ cfg, provider, model });
      const sessionId = crypto.randomUUID();
      const sessionFile = agentRuntime.session.resolveSessionFilePath(sessionId, {}, { agentId });

      const transcriptForLLM = call.transcript
        .map((t) => `${t.speaker === "bot" ? botDisplayName : otherPartyName}: ${t.text}`)
        .join("\n");

      const summaryPrompt = `以下是一段电话通话记录。请用中文写一段简短的通话总结（3-5句话），概括通话的主要内容、目的和结果。只输出总结本身，不要加标题或其他格式。\n\n${transcriptForLLM}`;

      const result = await agentRuntime.runEmbeddedPiAgent({
        sessionId,
        sessionKey: `voice:summary:${call.callId}`,
        messageProvider: "voice",
        disableMessageTool: true,
        disableTools: true,
        promptMode: "none",
        sessionFile,
        workspaceDir,
        config: cfg,
        prompt: summaryPrompt,
        provider,
        model,
        thinkLevel,
        verboseLevel: "off",
        timeoutMs: 30000,
        runId: `voice:summary:${Date.now()}`,
        lane: "voice",
        agentDir,
      });

      const texts = (result.payloads ?? [])
        .filter((p: { text?: string; isError?: boolean }) => p.text && !p.isError)
        .map((p: { text?: string }) => p.text?.trim())
        .filter(Boolean);
      summary = texts.join(" ") || "";
      if (summary) {
        api.logger.info(`[voice-call] Generated call summary for ${call.callId}`);
      }
    } catch (err) {
      api.logger.warn(`[voice-call] Failed to generate call summary: ${formatErr(err)}`);
    }
  }

  // --- Build markdown report ---
  const directionLabel = isInbound ? "来电通话" : "去电通话";
  const partyLabel = isInbound ? "来电方" : "去电对象";
  const reportLines = [
    `# 📞 ${directionLabel}记录`,
    ``,
    `- **${partyLabel}：** ${callerLabel}`,
    `- **时长：** ${durationStr}`,
    `- **结束原因：** ${call.endReason ?? "未知"}`,
    ``,
    `## 通话记录`,
    ``,
    transcriptLines,
  ];
  if (summary) {
    reportLines.push(``, `## 通话总结`, ``, summary);
  }
  const reportMd = reportLines.join("\n");

  // --- Save to call_logs/ ---
  try {
    const logsDir = path.join(workspaceDir, "call_logs");
    await fsp.mkdir(logsDir, { recursive: true });
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const timeStr = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const nameTag = (callerName ?? otherPartyPhone ?? "unknown").replace(
      /[^\w\u4e00-\u9fff-]/g,
      "",
    );
    const dirPrefix = isInbound ? "IN" : "OUT";
    const fileName = `${dirPrefix}-${dateStr}-${timeStr}-${nameTag}.md`;
    const filePath = path.join(logsDir, fileName);
    await fsp.writeFile(filePath, reportMd + "\n", "utf-8");
    api.logger.info(`[voice-call] Saved call report to ${filePath}`);
  } catch (err) {
    api.logger.warn(`[voice-call] Failed to save call report: ${formatErr(err)}`);
  }

  // --- Discord DM ---
  await sendDiscordCallReport({
    api,
    isInbound,
    callerLabel,
    durationStr,
    endReason: call.endReason ?? "未知",
    transcriptLines,
    summary,
  });
}

async function sendDiscordCallReport(params: {
  api: OpenClawPluginApi;
  isInbound: boolean;
  callerLabel: string;
  durationStr: string;
  endReason: string;
  transcriptLines: string;
  summary: string;
}): Promise<void> {
  const { api, isInbound, callerLabel, durationStr, endReason, transcriptLines, summary } = params;
  const discordCfg = (api.config as CoreConfig & Record<string, unknown>)?.channels as
    | Record<string, unknown>
    | undefined;
  const allowFrom = (discordCfg?.discord as Record<string, unknown> | undefined)?.allowFrom;
  const ownerId = Array.isArray(allowFrom) ? (allowFrom[0] as string | undefined) : undefined;
  if (!ownerId) {
    api.logger.warn("[voice-call] No Discord owner ID found; cannot send call report");
    return;
  }

  const dirLabel = isInbound ? "来电" : "去电";
  const partyField = isInbound ? "来电方" : "去电对象";
  const lines = [
    `📞 **${dirLabel}通话已结束**（此消息为自动通话记录，无需操作或回复）`,
    `**${partyField}：** ${callerLabel}`,
    `**时长：** ${durationStr}`,
    `**结束原因：** ${endReason}`,
    ``,
    `**通话记录：**`,
    transcriptLines,
  ];
  if (summary) {
    lines.push(``, `**通话总结：**`, summary);
  }
  const text = lines.join("\n");

  try {
    const adapter = await api.runtime.channel.outbound.loadAdapter("discord");
    if (!adapter?.sendText) {
      api.logger.warn("[voice-call] Discord adapter unavailable; cannot send call report");
      return;
    }
    await adapter.sendText({
      cfg: api.config,
      to: `user:${ownerId}`,
      text,
    });
    api.logger.info(`[voice-call] Sent ${dirLabel} call report to Discord user ${ownerId}`);
  } catch (err) {
    api.logger.warn(`[voice-call] Discord call-report send failed: ${formatErr(err)}`);
  }
}
