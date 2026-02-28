import { Type } from "@sinclair/typebox";
import type { GatewayRequestHandlerOptions, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerVoiceCallCli } from "./src/cli.js";
import {
  VoiceCallConfigSchema,
  resolveVoiceCallConfig,
  validateProviderConfig,
  type VoiceCallConfig,
} from "./src/config.js";
import type { CoreConfig } from "./src/core-bridge.js";
import { deleteCallAudioFiles, maybeGenerateHostedAudioUrl } from "./src/response-generator.js";
import { createVoiceCallRuntime, type VoiceCallRuntime } from "./src/runtime.js";

const voiceCallConfigSchema = {
  parse(value: unknown): VoiceCallConfig {
    const raw =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

    const twilio = raw.twilio as Record<string, unknown> | undefined;
    const legacyFrom = typeof twilio?.from === "string" ? twilio.from : undefined;

    const enabled = typeof raw.enabled === "boolean" ? raw.enabled : true;
    const providerRaw = raw.provider === "log" ? "mock" : raw.provider;
    const provider = providerRaw ?? (enabled ? "mock" : undefined);

    return VoiceCallConfigSchema.parse({
      ...raw,
      enabled,
      provider,
      fromNumber: raw.fromNumber ?? legacyFrom,
    });
  },
  uiHints: {
    provider: {
      label: "Provider",
      help: "Use twilio, telnyx, or mock for dev/no-network.",
    },
    fromNumber: { label: "From Number", placeholder: "+15550001234" },
    toNumber: { label: "Default To Number", placeholder: "+15550001234" },
    inboundPolicy: { label: "Inbound Policy" },
    allowFrom: { label: "Inbound Allowlist" },
    inboundGreeting: { label: "Inbound Greeting", advanced: true },
    "telnyx.apiKey": { label: "Telnyx API Key", sensitive: true },
    "telnyx.connectionId": { label: "Telnyx Connection ID" },
    "telnyx.publicKey": { label: "Telnyx Public Key", sensitive: true },
    "twilio.accountSid": { label: "Twilio Account SID" },
    "twilio.authToken": { label: "Twilio Auth Token", sensitive: true },
    "outbound.defaultMode": { label: "Default Call Mode" },
    "outbound.notifyHangupDelaySec": {
      label: "Notify Hangup Delay (sec)",
      advanced: true,
    },
    "serve.port": { label: "Webhook Port" },
    "serve.bind": { label: "Webhook Bind" },
    "serve.path": { label: "Webhook Path" },
    "tailscale.mode": { label: "Tailscale Mode", advanced: true },
    "tailscale.path": { label: "Tailscale Path", advanced: true },
    "tunnel.provider": { label: "Tunnel Provider", advanced: true },
    "tunnel.ngrokAuthToken": {
      label: "ngrok Auth Token",
      sensitive: true,
      advanced: true,
    },
    "tunnel.ngrokDomain": { label: "ngrok Domain", advanced: true },
    "tunnel.allowNgrokFreeTierLoopbackBypass": {
      label: "Allow ngrok Free Tier (Loopback Bypass)",
      advanced: true,
    },
    "streaming.enabled": { label: "Enable Streaming", advanced: true },
    "streaming.openaiApiKey": {
      label: "OpenAI Realtime API Key",
      sensitive: true,
      advanced: true,
    },
    "streaming.sttModel": { label: "Realtime STT Model", advanced: true },
    "streaming.streamPath": { label: "Media Stream Path", advanced: true },
    "tts.provider": {
      label: "TTS Provider Override",
      help: "Deep-merges with messages.tts (Edge is ignored for calls).",
      advanced: true,
    },
    "tts.openai.model": { label: "OpenAI TTS Model", advanced: true },
    "tts.openai.voice": { label: "OpenAI TTS Voice", advanced: true },
    "tts.openai.apiKey": {
      label: "OpenAI API Key",
      sensitive: true,
      advanced: true,
    },
    "tts.elevenlabs.modelId": { label: "ElevenLabs Model ID", advanced: true },
    "tts.elevenlabs.voiceId": { label: "ElevenLabs Voice ID", advanced: true },
    "tts.elevenlabs.apiKey": {
      label: "ElevenLabs API Key",
      sensitive: true,
      advanced: true,
    },
    "tts.elevenlabs.baseUrl": { label: "ElevenLabs Base URL", advanced: true },
    publicUrl: { label: "Public Webhook URL", advanced: true },
    skipSignatureVerification: {
      label: "Skip Signature Verification",
      advanced: true,
    },
    store: { label: "Call Log Store Path", advanced: true },
    responseModel: { label: "Response Model", advanced: true },
    responseSystemPrompt: { label: "Response System Prompt", advanced: true },
    responseTimeoutMs: { label: "Response Timeout (ms)", advanced: true },
  },
};

const VoiceCallToolSchema = Type.Union([
  Type.Object({
    action: Type.Literal("initiate_call"),
    to: Type.Optional(Type.String({ description: "Call target" })),
    message: Type.String({ description: "Intro message" }),
    mode: Type.Optional(Type.Union([Type.Literal("notify"), Type.Literal("conversation")])),
  }),
  Type.Object({
    action: Type.Literal("continue_call"),
    callId: Type.String({ description: "Call ID" }),
    message: Type.String({ description: "Follow-up message" }),
  }),
  Type.Object({
    action: Type.Literal("speak_to_user"),
    callId: Type.String({ description: "Call ID" }),
    message: Type.String({ description: "Message to speak" }),
  }),
  Type.Object({
    action: Type.Literal("end_call"),
    callId: Type.String({ description: "Call ID" }),
  }),
  Type.Object({
    action: Type.Literal("get_status"),
    callId: Type.String({ description: "Call ID" }),
  }),
  Type.Object({
    mode: Type.Optional(Type.Union([Type.Literal("call"), Type.Literal("status")])),
    to: Type.Optional(Type.String({ description: "Call target" })),
    sid: Type.Optional(Type.String({ description: "Call SID" })),
    message: Type.Optional(Type.String({ description: "Optional intro message" })),
  }),
]);

const voiceCallPlugin = {
  id: "voice-call",
  name: "Voice Call",
  description: "Voice-call plugin with Telnyx/Twilio/Plivo providers",
  configSchema: voiceCallConfigSchema,
  register(api: OpenClawPluginApi) {
    const config = resolveVoiceCallConfig(voiceCallConfigSchema.parse(api.pluginConfig));
    const validation = validateProviderConfig(config);

    if (api.pluginConfig && typeof api.pluginConfig === "object") {
      const raw = api.pluginConfig as Record<string, unknown>;
      const twilio = raw.twilio as Record<string, unknown> | undefined;
      if (raw.provider === "log") {
        api.logger.warn('[voice-call] provider "log" is deprecated; use "mock" instead');
      }
      if (typeof twilio?.from === "string") {
        api.logger.warn("[voice-call] twilio.from is deprecated; use fromNumber instead");
      }
    }

    let runtimePromise: Promise<VoiceCallRuntime> | null = null;
    let runtime: VoiceCallRuntime | null = null;

    const ensureRuntime = async () => {
      if (!config.enabled) {
        throw new Error("Voice call disabled in plugin config");
      }
      if (!validation.valid) {
        throw new Error(validation.errors.join("; "));
      }
      if (runtime) {
        return runtime;
      }
      if (!runtimePromise) {
        runtimePromise = createVoiceCallRuntime({
          config,
          coreConfig: api.config as CoreConfig,
          ttsRuntime: api.runtime.tts,
          logger: api.logger,
        });
      }
      runtime = await runtimePromise;
      return runtime;
    };

    const sendError = (respond: (ok: boolean, payload?: unknown) => void, err: unknown) => {
      respond(false, { error: err instanceof Error ? err.message : String(err) });
    };

    api.registerGatewayMethod(
      "voicecall.initiate",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const message = typeof params?.message === "string" ? params.message.trim() : "";
          if (!message) {
            respond(false, { error: "message required" });
            return;
          }
          const rt = await ensureRuntime();
          const to =
            typeof params?.to === "string" && params.to.trim()
              ? params.to.trim()
              : rt.config.toNumber;
          if (!to) {
            respond(false, { error: "to required" });
            return;
          }
          const mode =
            params?.mode === "notify" || params?.mode === "conversation" ? params.mode : undefined;
          const result = await rt.manager.initiateCall(to, undefined, {
            message,
            mode,
          });
          if (!result.success) {
            respond(false, { error: result.error || "initiate failed" });
            return;
          }
          respond(true, { callId: result.callId, initiated: true });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "voicecall.continue",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const callId = typeof params?.callId === "string" ? params.callId.trim() : "";
          const message = typeof params?.message === "string" ? params.message.trim() : "";
          if (!callId || !message) {
            respond(false, { error: "callId and message required" });
            return;
          }
          const rt = await ensureRuntime();
          const result = await rt.manager.continueCall(callId, message);
          if (!result.success) {
            respond(false, { error: result.error || "continue failed" });
            return;
          }
          respond(true, { success: true, transcript: result.transcript });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "voicecall.speak",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const callId = typeof params?.callId === "string" ? params.callId.trim() : "";
          const message = typeof params?.message === "string" ? params.message.trim() : "";
          if (!callId || !message) {
            respond(false, { error: "callId and message required" });
            return;
          }
          const rt = await ensureRuntime();
          const result = await rt.manager.speak(callId, message);
          if (!result.success) {
            respond(false, { error: result.error || "speak failed" });
            return;
          }
          respond(true, { success: true });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "voicecall.end",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const callId = typeof params?.callId === "string" ? params.callId.trim() : "";
          if (!callId) {
            respond(false, { error: "callId required" });
            return;
          }
          const rt = await ensureRuntime();
          const result = await rt.manager.endCall(callId);
          if (!result.success) {
            respond(false, { error: result.error || "end failed" });
            return;
          }
          respond(true, { success: true });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "voicecall.status",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const raw =
            typeof params?.callId === "string"
              ? params.callId.trim()
              : typeof params?.sid === "string"
                ? params.sid.trim()
                : "";
          if (!raw) {
            respond(false, { error: "callId required" });
            return;
          }
          const rt = await ensureRuntime();
          const call = rt.manager.getCall(raw) || rt.manager.getCallByProviderCallId(raw);
          if (!call) {
            respond(true, { found: false });
            return;
          }
          respond(true, { found: true, call });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "voicecall.start",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const to = typeof params?.to === "string" ? params.to.trim() : "";
          const message = typeof params?.message === "string" ? params.message.trim() : "";
          if (!to) {
            respond(false, { error: "to required" });
            return;
          }
          const rt = await ensureRuntime();
          const result = await rt.manager.initiateCall(to, undefined, {
            message: message || undefined,
          });
          if (!result.success) {
            respond(false, { error: result.error || "initiate failed" });
            return;
          }
          respond(true, { callId: result.callId, initiated: true });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerTool({
      name: "voice_call",
      label: "Voice Call",
      description: "Make phone calls and have voice conversations via the voice-call plugin.",
      parameters: VoiceCallToolSchema,
      async execute(_toolCallId, params) {
        const json = (payload: unknown) => ({
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          details: payload,
        });

        try {
          const rt = await ensureRuntime();

          if (typeof params?.action === "string") {
            switch (params.action) {
              case "initiate_call": {
                const message = String(params.message || "").trim();
                if (!message) {
                  throw new Error("message required");
                }
                const to =
                  typeof params.to === "string" && params.to.trim()
                    ? params.to.trim()
                    : rt.config.toNumber;
                if (!to) {
                  throw new Error("to required");
                }

                // Pre-generate SAG audio for the initial greeting so it plays
                // immediately when the call connects (no TTS delay).
                let initialMessageAudioUrl: string | undefined;
                try {
                  const preGenStart = Date.now();
                  initialMessageAudioUrl = await maybeGenerateHostedAudioUrl({
                    text: message,
                    coreConfig: api.config as CoreConfig,
                    voiceConfig: config,
                  });
                  const preGenMs = Date.now() - preGenStart;
                  console.log(
                    `[voice-call] Pre-generated initial message audio in ${preGenMs}ms (url: ${initialMessageAudioUrl ? "yes" : "no"})`,
                  );
                } catch (err) {
                  console.warn(
                    `[voice-call] Failed to pre-generate initial message audio:`,
                    err instanceof Error ? err.message : String(err),
                  );
                }

                const result = await rt.manager.initiateCall(to, undefined, {
                  message,
                  mode:
                    params.mode === "notify" || params.mode === "conversation"
                      ? params.mode
                      : undefined,
                  initialMessageAudioUrl,
                });
                if (!result.success) {
                  throw new Error(result.error || "initiate failed");
                }

                // Wait for the call to complete so we can return the transcript
                // back to the calling agent (e.g. Discord) for post-call summary.
                try {
                  const callRecord = await rt.manager.waitForCallEnd(result.callId);

                  // Clean up all audio files generated during this call.
                  void deleteCallAudioFiles(
                    result.callId,
                    initialMessageAudioUrl ? [initialMessageAudioUrl] : [],
                  ).catch(() => {});

                  const durationMs =
                    callRecord.endedAt && callRecord.startedAt
                      ? callRecord.endedAt - callRecord.startedAt
                      : undefined;
                  const transcript = callRecord.transcript
                    .map((t) => `[${t.speaker === "bot" ? "Bot" : "User"}] ${t.text}`)
                    .join("\n");
                  return json({
                    callId: result.callId,
                    completed: true,
                    to,
                    endReason: callRecord.endReason || "unknown",
                    durationSeconds: durationMs ? Math.round(durationMs / 1000) : undefined,
                    transcript: transcript || "(no transcript recorded)",
                  });
                } catch {
                  // If waitForCallEnd fails (e.g. call ended before we registered),
                  // fall back to returning just the initiated status.
                  return json({ callId: result.callId, initiated: true });
                }
              }
              case "continue_call": {
                const callId = String(params.callId || "").trim();
                const message = String(params.message || "").trim();
                if (!callId || !message) {
                  throw new Error("callId and message required");
                }
                const result = await rt.manager.continueCall(callId, message);
                if (!result.success) {
                  throw new Error(result.error || "continue failed");
                }
                return json({ success: true, transcript: result.transcript });
              }
              case "speak_to_user": {
                const callId = String(params.callId || "").trim();
                const message = String(params.message || "").trim();
                if (!callId || !message) {
                  throw new Error("callId and message required");
                }
                const result = await rt.manager.speak(callId, message);
                if (!result.success) {
                  throw new Error(result.error || "speak failed");
                }
                return json({ success: true });
              }
              case "end_call": {
                const callId = String(params.callId || "").trim();
                if (!callId) {
                  throw new Error("callId required");
                }
                const result = await rt.manager.endCall(callId);
                if (!result.success) {
                  throw new Error(result.error || "end failed");
                }
                return json({ success: true });
              }
              case "get_status": {
                const callId = String(params.callId || "").trim();
                if (!callId) {
                  throw new Error("callId required");
                }
                const call =
                  rt.manager.getCall(callId) || rt.manager.getCallByProviderCallId(callId);
                return json(call ? { found: true, call } : { found: false });
              }
            }
          }

          const mode = params?.mode ?? "call";
          if (mode === "status") {
            const sid = typeof params.sid === "string" ? params.sid.trim() : "";
            if (!sid) {
              throw new Error("sid required for status");
            }
            const call = rt.manager.getCall(sid) || rt.manager.getCallByProviderCallId(sid);
            return json(call ? { found: true, call } : { found: false });
          }

          const to =
            typeof params.to === "string" && params.to.trim()
              ? params.to.trim()
              : rt.config.toNumber;
          if (!to) {
            throw new Error("to required for call");
          }
          const legacyMessage =
            typeof params.message === "string" && params.message.trim()
              ? params.message.trim()
              : undefined;

          // Pre-generate SAG audio for the initial message.
          let legacyAudioUrl: string | undefined;
          if (legacyMessage) {
            try {
              legacyAudioUrl = await maybeGenerateHostedAudioUrl({
                text: legacyMessage,
                coreConfig: api.config as CoreConfig,
                voiceConfig: config,
              });
            } catch {
              // Non-fatal — will fall back to provider TTS.
            }
          }

          const result = await rt.manager.initiateCall(to, undefined, {
            message: legacyMessage,
            initialMessageAudioUrl: legacyAudioUrl,
          });
          if (!result.success) {
            throw new Error(result.error || "initiate failed");
          }
          return json({ callId: result.callId, initiated: true });
        } catch (err) {
          return json({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    });

    api.registerCli(
      ({ program }) =>
        registerVoiceCallCli({
          program,
          config,
          ensureRuntime,
          logger: api.logger,
        }),
      { commands: ["voicecall"] },
    );

    api.registerService({
      id: "voicecall",
      start: async () => {
        if (!config.enabled) {
          return;
        }
        try {
          const rt = await ensureRuntime();

          // Wire up post-call handler: runs once per call regardless of
          // whether it ended via stream-disconnect or Twilio webhook.
          rt.manager.onCallEnded = (call) => {
            // Clean up audio files for every call (covers stream-disconnect
            // path which previously skipped this).
            void deleteCallAudioFiles(call.callId).catch(() => {});

            void (async () => {
              try {
                const nodePath = require("node:path") as typeof import("node:path");
                const nodeFs = require("node:fs") as typeof import("node:fs");
                const nodeFsp = require("node:fs/promises") as typeof import("node:fs/promises");
                const nodeOs = require("node:os") as typeof import("node:os");

                const callerName = call.metadata?.callerName as string | undefined;
                const callerLabel = callerName ? `${callerName} (${call.from})` : call.from;
                const durationMs =
                  call.endedAt && call.startedAt ? call.endedAt - call.startedAt : undefined;
                const durationStr = durationMs ? `${Math.round(durationMs / 1000)}秒` : "未知";

                // Resolve bot display name from IDENTITY.md NickName
                let botDisplayName = "Bot";
                try {
                  const identityPath = nodePath.join(
                    nodeOs.homedir(),
                    ".openclaw/workspace/IDENTITY.md",
                  );
                  const identityContent = nodeFs.readFileSync(identityPath, "utf-8") as string;
                  const nickMatch = identityContent.match(/\*\*NickName[:：]?\*\*[:：]?\s*(.+)/i);
                  if (nickMatch?.[1]?.trim()) {
                    botDisplayName = nickMatch[1].trim();
                  }
                } catch {
                  // IDENTITY.md not found; fall back to "Bot"
                }

                const isInbound = call.direction === "inbound";
                const otherPartyName = callerName ?? (isInbound ? "来电方" : "对方");

                const transcriptLines =
                  call.transcript.length > 0
                    ? call.transcript
                        .map(
                          (t) =>
                            `[${t.speaker === "bot" ? botDisplayName : otherPartyName}] ${t.text}`,
                        )
                        .join("\n")
                    : "*(无通话记录)*";

                // --- Generate LLM summary ---
                let summary = "";
                if (call.transcript.length > 0) {
                  try {
                    const { loadCoreAgentDeps } = await import("./src/core-bridge.js");
                    const deps = await loadCoreAgentDeps();
                    const cfg = api.config as CoreConfig;
                    const agentId = "main";
                    const workspaceDir = deps.resolveAgentWorkspaceDir(cfg, agentId);
                    const agentDir = deps.resolveAgentDir(cfg, agentId);

                    const modelRef =
                      config.responseModel || `${deps.DEFAULT_PROVIDER}/${deps.DEFAULT_MODEL}`;
                    const slashIdx = modelRef.indexOf("/");
                    const provider =
                      slashIdx === -1 ? deps.DEFAULT_PROVIDER : modelRef.slice(0, slashIdx);
                    const model = slashIdx === -1 ? modelRef : modelRef.slice(slashIdx + 1);
                    const thinkLevel = deps.resolveThinkingDefault({ cfg, provider, model });

                    const crypto = require("node:crypto") as typeof import("node:crypto");
                    const sessionId = crypto.randomUUID();
                    const sessionEntry = { sessionId, updatedAt: Date.now() };
                    const sessionFile = deps.resolveSessionFilePath(sessionId, sessionEntry, {
                      agentId,
                    });

                    const transcriptForLLM = call.transcript
                      .map(
                        (t) =>
                          `${t.speaker === "bot" ? botDisplayName : otherPartyName}: ${t.text}`,
                      )
                      .join("\n");

                    const summaryPrompt = `以下是一段电话通话记录。请用中文写一段简短的通话总结（3-5句话），概括通话的主要内容、目的和结果。只输出总结本身，不要加标题或其他格式。\n\n${transcriptForLLM}`;

                    const result = await deps.runEmbeddedPiAgent({
                      sessionId,
                      sessionKey: `voice:summary:${call.callId}`,
                      messageProvider: "voice",
                      disableMessageTool: true,
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
                    api.logger.warn(
                      `[voice-call] Failed to generate call summary: ${
                        err instanceof Error ? err.message : String(err)
                      }`,
                    );
                  }
                }

                // --- Build report ---
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

                // --- Save to call_logs ---
                try {
                  const logsDir = nodePath.join(nodeOs.homedir(), ".openclaw/workspace/call_logs");
                  await nodeFsp.mkdir(logsDir, { recursive: true });

                  const now = new Date();
                  const pad = (n: number) => String(n).padStart(2, "0");
                  const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
                  const timeStr = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
                  const nameTag = (callerName ?? call.from).replace(/[^\w\u4e00-\u9fff-]/g, "");
                  const fileName = `${dateStr}-${timeStr}-${nameTag}.md`;
                  const filePath = nodePath.join(logsDir, fileName);

                  await nodeFsp.writeFile(filePath, reportMd + "\n", "utf-8");
                  api.logger.info(`[voice-call] Saved call report to ${filePath}`);
                } catch (err) {
                  api.logger.warn(
                    `[voice-call] Failed to save call report: ${
                      err instanceof Error ? err.message : String(err)
                    }`,
                  );
                }

                // --- Discord DM for inbound calls ---
                if (isInbound) {
                  const discordCfg = (api.config as CoreConfig & Record<string, unknown>)
                    ?.channels as Record<string, unknown> | undefined;
                  const allowFrom = (discordCfg?.discord as Record<string, unknown> | undefined)
                    ?.allowFrom;
                  const ownerId = Array.isArray(allowFrom)
                    ? (allowFrom[0] as string | undefined)
                    : undefined;
                  if (!ownerId) {
                    api.logger.warn(
                      "[voice-call] No Discord owner ID found; cannot send inbound call report",
                    );
                    return;
                  }

                  // Discord message uses simpler format (no markdown headings)
                  const discordLines = [
                    `📞 **来电通话已结束**`,
                    `**来电方：** ${callerLabel}`,
                    `**时长：** ${durationStr}`,
                    `**结束原因：** ${call.endReason ?? "未知"}`,
                    ``,
                    `**通话记录：**`,
                    transcriptLines,
                  ];
                  if (summary) {
                    discordLines.push(``, `**通话总结：**`, summary);
                  }

                  await api.runtime.channel.discord.sendMessageDiscord(
                    `user:${ownerId}`,
                    discordLines.join("\n"),
                  );
                  api.logger.info(
                    `[voice-call] Sent inbound call report to Discord user ${ownerId}`,
                  );
                }
              } catch (err) {
                api.logger.warn(
                  `[voice-call] Failed to generate/send call report: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                );
              }
            })();
          };
        } catch (err) {
          api.logger.error(
            `[voice-call] Failed to start runtime: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      },
      stop: async () => {
        if (!runtimePromise) {
          return;
        }
        try {
          const rt = await runtimePromise;
          await rt.stop();
        } finally {
          runtimePromise = null;
          runtime = null;
        }
      },
    });
  },
};

export default voiceCallPlugin;
