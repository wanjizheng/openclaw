import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginLogger, PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import { deleteSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import type { OpenClawPluginApi } from "../api.js";
import { deleteCallAudioFiles, resolveVoiceMessagesDir } from "./hybrid/audio-pipeline.js";
import { findCallInStore } from "./manager/store.js";
import { resolveCallAgentId } from "./resolve-call-agent-id.js";
import { getOptionalVoiceCallStateRuntime, type VoiceCallStateRuntime } from "./runtime-state.js";
import { TerminalStates, type CallRecord } from "./types.js";

const CLEANUP_NAMESPACE = "terminal-cleanup";
const MAX_PENDING_CLEANUPS = 10_000;

type SessionCleanup = {
  agentId: string;
  storePath: string;
  sessionKey: string;
  expectedSessionId: string;
  done: boolean;
};
type CleanupIntent = {
  callId: string;
  agentId: string;
  ready: boolean;
  audioDir: string;
  audioDone: boolean;
  session?: SessionCleanup;
};
type CleanupDependencies = {
  stateRuntime?: VoiceCallStateRuntime["state"];
  storePath: string;
  agentRuntime: {
    session: Pick<
      OpenClawPluginApi["runtime"]["agent"]["session"],
      "resolveStorePath" | "getSessionEntry"
    >;
  };
  coreConfig: OpenClawConfig;
  logger: PluginLogger;
  scheduler: PluginServiceSchedulerV1;
};

export type CallCleanup = {
  /** Persist exact identities before the terminal call snapshot commits. */
  prepare: (call: CallRecord) => Promise<void>;
  /** Mark the prepared intent committed without recapturing resource identities. */
  enqueue: (call: CallRecord) => Promise<void>;
  /** Attempt both resources independently; failures remain durable for retry. */
  run: (callId: string) => Promise<void>;
  start: () => Promise<void>;
  /** Stop retry admission and join accepted cleanup; never force pending deletion. */
  stop: () => Promise<void>;
};

export function createCallCleanup(deps: CleanupDependencies): CallCleanup {
  const stateRuntime = deps.stateRuntime ?? getOptionalVoiceCallStateRuntime()?.state;
  if (!stateRuntime) {
    throw new Error("Voice Call cleanup state runtime not initialized");
  }
  const store = stateRuntime.openKeyedStore<CleanupIntent>({
    namespace: CLEANUP_NAMESPACE,
    maxEntries: MAX_PENDING_CLEANUPS,
    overflowPolicy: "reject-new",
    env: { ...process.env, OPENCLAW_STATE_DIR: deps.storePath },
  });
  const retries = deps.scheduler.scope();
  const pending = new Map<string, Promise<void>>();
  const captures = new Map<string, CleanupIntent>();
  let retryJob: ReturnType<PluginServiceSchedulerV1["schedule"]> | undefined;
  let stopping = false;

  const serialize = (callId: string, work: () => Promise<void>): Promise<void> => {
    const previous = pending.get(callId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    pending.set(callId, next);
    const settled = () => {
      if (pending.get(callId) === next) {
        pending.delete(callId);
      }
    };
    void next.then(settled, settled);
    return next;
  };
  const keyFor = (callId: string) => "call:" + callId;
  const capture = (call: CallRecord, ready: boolean): CleanupIntent => {
    const agentId = resolveCallAgentId(call);
    const intent: CleanupIntent = {
      callId: call.callId,
      agentId,
      ready,
      audioDir: path.resolve(resolveVoiceMessagesDir()),
      audioDone: false,
    };
    const expectedKey = ("agent:" + agentId + ":voice:call:" + call.callId).toLowerCase();
    if (call.sessionKey !== expectedKey) {
      return intent;
    }
    const storePath = deps.agentRuntime.session.resolveStorePath(deps.coreConfig.session?.store, {
      agentId,
    });
    const entry = deps.agentRuntime.session.getSessionEntry({
      agentId,
      storePath,
      sessionKey: expectedKey,
    });
    if (entry?.sessionId) {
      intent.session = {
        agentId,
        storePath,
        sessionKey: expectedKey,
        expectedSessionId: entry.sessionId,
        done: false,
      };
    }
    return intent;
  };
  const admit = (call: CallRecord, ready: boolean): Promise<void> => {
    // Capture exact session and directory identity before any queue/storage await.
    // A missing row stays missing; enqueue never infers a later replacement row.
    let captured = captures.get(call.callId);
    if (!captured) {
      captured = capture(call, ready);
      captures.set(call.callId, captured);
    }
    const candidate = captured;
    return serialize(call.callId, async () => {
      const key = keyFor(call.callId);
      const existing = await store.lookup(key);
      if (existing) {
        if (ready && !existing.ready) {
          await store.register(key, { ...existing, ready: true });
        }
        return;
      }
      await store.registerIfAbsent(key, { ...candidate, ready });
    });
  };

  const run = (callId: string) =>
    serialize(callId, async () => {
      const key = keyFor(callId);
      const intent = await store.lookup(key);
      if (!intent) {
        return;
      }
      if (!intent.ready) {
        // A crash between prepare and terminal persistence cannot clean a live call.
        const terminal = await findCallInStore(deps.storePath, intent.callId, stateRuntime);
        if (
          !terminal ||
          !TerminalStates.has(terminal.state) ||
          resolveCallAgentId(terminal) !== intent.agentId
        ) {
          return;
        }
        intent.ready = true;
        await store.register(key, intent);
      }
      if (intent.session && !intent.session.done) {
        try {
          await deleteSessionEntry({
            agentId: intent.session.agentId,
            storePath: intent.session.storePath,
            sessionKey: intent.session.sessionKey,
            expectedSessionId: intent.session.expectedSessionId,
            archiveTranscript: false,
            deleteTranscriptWithoutArchive: true,
          });
          intent.session.done = true;
        } catch (error) {
          deps.logger.warn(
            "[voice-call] Session cleanup pending for " + callId + ": " + String(error),
          );
        }
      }
      if (!intent.audioDone) {
        try {
          await deleteCallAudioFiles(intent.callId, [], intent.audioDir);
          intent.audioDone = true;
        } catch (error) {
          deps.logger.warn(
            "[voice-call] Audio cleanup pending for " + callId + ": " + String(error),
          );
        }
      }
      if ((!intent.session || intent.session.done) && intent.audioDone) {
        await store.delete(key);
        captures.delete(callId);
      } else {
        await store.register(key, intent);
      }
    }).catch((error: unknown) => {
      deps.logger.warn(
        "[voice-call] Durable cleanup retry pending for " + callId + ": " + String(error),
      );
    });

  const replay = async () => {
    const entries = await store.entries();
    for (const { value } of entries) {
      await run(value.callId);
    }
  };
  return {
    prepare: (call) => admit(call, false),
    enqueue: (call) => admit(call, true),
    run,
    start: async () => {
      if (stopping) {
        return;
      }
      await replay();
      if (!retries.signal.aborted && !stopping && !retryJob) {
        retryJob = retries.schedule({
          id: "terminal-cleanup-retry",
          delayMs: 30_000,
          everyMs: 30_000,
          run: async () => {
            try {
              await replay();
            } catch (error) {
              deps.logger.warn("[voice-call] Cleanup queue replay pending: " + String(error));
            }
          },
        });
      }
    },
    stop: async () => {
      stopping = true;
      retryJob?.cancel();
      await retries.stop();
      await Promise.allSettled(pending.values());
    },
  };
}
