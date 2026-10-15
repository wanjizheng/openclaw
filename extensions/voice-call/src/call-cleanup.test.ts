import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import type {
  OpenAsyncKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCallCleanup } from "./call-cleanup.js";
import type { VoiceCallStateRuntime } from "./runtime-state.js";
import { CallRecordSchema } from "./types.js";

const mocks = vi.hoisted(() => ({
  deleteSessionEntry: vi.fn(),
  deleteCallAudioFiles: vi.fn(),
  resolveVoiceMessagesDir: vi.fn(),
  findCallInStore: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  deleteSessionEntry: mocks.deleteSessionEntry,
}));
vi.mock("./hybrid/audio-pipeline.js", () => ({
  deleteCallAudioFiles: mocks.deleteCallAudioFiles,
  resolveVoiceMessagesDir: mocks.resolveVoiceMessagesDir,
}));
vi.mock("./manager/store.js", () => ({ findCallInStore: mocks.findCallInStore }));

function fixture() {
  const values = new Map<string, unknown>();
  const openOptions: OpenAsyncKeyedStoreOptions[] = [];
  let rejectAdmission = false;
  function openStore<T>(options: OpenAsyncKeyedStoreOptions): PluginStateKeyedStore<T> {
    openOptions.push(options);
    const read = (key: string) => structuredClone(values.get(key)) as T | undefined;
    return {
      register: async (key, value) => {
        values.set(key, structuredClone(value));
      },
      registerIfAbsent: async (key, value) => {
        if (rejectAdmission) {
          throw new Error("synthetic capacity refusal");
        }
        if (values.has(key)) {
          return false;
        }
        values.set(key, structuredClone(value));
        return true;
      },
      lookup: async (key) => read(key),
      consume: async (key) => {
        const value = read(key);
        values.delete(key);
        return value;
      },
      delete: async (key) => values.delete(key),
      entries: async () =>
        [...values.keys()].map((key) => ({ key, value: read(key)!, createdAt: 1 })),
      clear: async () => {
        values.clear();
      },
    };
  }
  const stateRuntime: VoiceCallStateRuntime["state"] = {
    openKeyedStore: openStore,
    resolveStateDir: () => "/synthetic/state",
    openChannelIngressQueue: () => {
      throw new Error("unused queue");
    },
    openChannelIngressDrain: () => {
      throw new Error("unused drain");
    },
  };
  const abort = new AbortController();
  const jobs: Array<Parameters<PluginServiceSchedulerV1["schedule"]>[0]> = [];
  const scheduler: PluginServiceSchedulerV1 = {
    version: 1,
    signal: abort.signal,
    now: () => 1,
    schedule: (job) => {
      jobs.push(job);
      return { cancel: vi.fn(), stop: async () => {} };
    },
    scope: () => scheduler,
    beginClose: () => abort.abort(),
    stop: async () => {
      abort.abort();
    },
  };
  const getSessionEntry = vi.fn((): { sessionId: string; updatedAt: number } | undefined => ({
    sessionId: "old-session",
    updatedAt: 1,
  }));
  const deps: Parameters<typeof createCallCleanup>[0] = {
    stateRuntime,
    storePath: "/synthetic/calls",
    agentRuntime: {
      session: { resolveStorePath: () => "/synthetic/session-store", getSessionEntry },
    },
    coreConfig: {},
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    scheduler,
  };
  const call = CallRecordSchema.parse({
    callId: "call-1",
    agentId: "sales",
    sessionKey: "agent:sales:voice:call:call-1",
    direction: "outbound",
    from: "+15550000000",
    to: "+15550000001",
    provider: "twilio",
    state: "hangup-bot",
    startedAt: 1,
    endedAt: 1001,
    endReason: "hangup-bot",
    transcript: [],
    processedEventIds: [],
  });
  return {
    deps,
    call,
    values,
    jobs,
    abort,
    getSessionEntry,
    openOptions,
    capacityFull: () => {
      rejectAdmission = true;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveVoiceMessagesDir.mockReturnValue("/synthetic/audio-old");
  mocks.deleteSessionEntry.mockResolvedValue(true);
  mocks.deleteCallAudioFiles.mockResolvedValue(undefined);
  mocks.findCallInStore.mockResolvedValue(undefined);
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("durable terminal cleanup", () => {
  it("replays an obligation from real SQLite after closing the old owner and database", async () => {
    const f = fixture();
    const storePath = tempDirs.make("voice-call-cleanup-durable-");
    const original = f.deps.stateRuntime;
    if (!original) {
      throw new Error("Expected fixture state runtime");
    }
    const stateRuntime: VoiceCallStateRuntime["state"] = {
      ...original,
      openKeyedStore: <T>(options: OpenAsyncKeyedStoreOptions) =>
        createPluginStateKeyedStoreForTests<T>("voice-call", options),
    };
    const first = createCallCleanup({ ...f.deps, storePath, stateRuntime });
    try {
      await first.enqueue(f.call);
      await first.stop();
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
      const nextScheduler = fixture().deps.scheduler;
      const next = createCallCleanup({
        ...f.deps,
        storePath,
        stateRuntime,
        scheduler: nextScheduler,
      });
      try {
        await next.start();
        expect(mocks.deleteSessionEntry).toHaveBeenCalledWith(
          expect.objectContaining({ expectedSessionId: "old-session" }),
        );
        const pending = stateRuntime.openKeyedStore<unknown>({
          namespace: "terminal-cleanup",
          maxEntries: 10000,
          overflowPolicy: "reject-new",
          env: { ...process.env, OPENCLAW_STATE_DIR: storePath },
        });
        expect(await pending.entries()).toEqual([]);
      } finally {
        await next.stop();
      }
    } finally {
      await first.stop();
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
    }
  });

  it("persists before dispatch and cleans after retirement with exact frozen identities", async () => {
    const f = fixture();
    const cleanup = createCallCleanup(f.deps);
    const admission = cleanup.prepare(f.call);
    // Capture is synchronous, before storage/manager work can yield to replacement.
    expect(f.getSessionEntry).toHaveBeenCalledTimes(1);
    await admission;
    f.getSessionEntry.mockReturnValue({ sessionId: "replacement", updatedAt: 2 });
    mocks.resolveVoiceMessagesDir.mockReturnValue("/synthetic/audio-new");
    await cleanup.enqueue(f.call);
    f.abort.abort();
    await cleanup.run(f.call.callId);
    expect(mocks.deleteSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSessionId: "old-session",
        sessionKey: f.call.sessionKey,
        archiveTranscript: false,
        deleteTranscriptWithoutArchive: true,
      }),
    );
    expect(mocks.deleteCallAudioFiles).toHaveBeenCalledWith("call-1", [], "/synthetic/audio-old");
    expect(f.values.size).toBe(0);
    expect(f.getSessionEntry).toHaveBeenCalledTimes(1);
    expect(f.openOptions[0]).toMatchObject({ overflowPolicy: "reject-new", maxEntries: 10000 });
    expect(f.openOptions[0]).not.toHaveProperty("defaultTtlMs");
  });

  it("attempts audio despite session failure and replays only the failed resource after restart", async () => {
    const f = fixture();
    const first = createCallCleanup(f.deps);
    await first.enqueue(f.call);
    mocks.deleteSessionEntry.mockRejectedValueOnce(new Error("database busy"));
    await first.run(f.call.callId);
    expect(mocks.deleteCallAudioFiles).toHaveBeenCalledOnce();
    expect(f.values.size).toBe(1);
    // A new owner over the same durable namespace replays without recapturing session identity.
    const restarted = createCallCleanup(f.deps);
    await restarted.start();
    expect(mocks.deleteSessionEntry).toHaveBeenCalledTimes(2);
    expect(mocks.deleteCallAudioFiles).toHaveBeenCalledTimes(1);
    expect(f.values.size).toBe(0);
    await restarted.stop();
  });

  it("retains failed audio independently after session deletion succeeds", async () => {
    const f = fixture();
    const cleanup = createCallCleanup(f.deps);
    await cleanup.enqueue(f.call);
    mocks.deleteCallAudioFiles.mockRejectedValueOnce(new Error("EACCES"));
    await cleanup.run(f.call.callId);
    expect(f.values.size).toBe(1);
    await cleanup.start();
    expect(mocks.deleteSessionEntry).toHaveBeenCalledTimes(1);
    expect(mocks.deleteCallAudioFiles).toHaveBeenCalledTimes(2);
    expect(f.values.size).toBe(0);
  });

  it("keeps prepared intent without terminal proof and recovers the crash gap once terminal is durable", async () => {
    const f = fixture();
    const cleanup = createCallCleanup(f.deps);
    await cleanup.prepare(f.call);
    mocks.findCallInStore.mockResolvedValue({ ...f.call, state: "listening" });
    await cleanup.run(f.call.callId);
    expect(f.values.size).toBe(1);
    expect(mocks.deleteSessionEntry).not.toHaveBeenCalled();
    mocks.findCallInStore.mockResolvedValue(f.call);
    await cleanup.run(f.call.callId);
    expect(f.values.size).toBe(0);
  });

  it("does not infer a newly created row when admission found no session", async () => {
    const f = fixture();
    f.getSessionEntry.mockReturnValue(undefined);
    const cleanup = createCallCleanup(f.deps);
    await cleanup.prepare(f.call);
    f.getSessionEntry.mockReturnValue({ sessionId: "new-row", updatedAt: 2 });
    await cleanup.enqueue(f.call);
    await cleanup.run(f.call.callId);
    expect(mocks.deleteSessionEntry).not.toHaveBeenCalled();
    expect(mocks.deleteCallAudioFiles).toHaveBeenCalledOnce();
  });

  it.each(["agent:sales:main", "agent:sales:voice:phone:+15550000001"])(
    "never removes shared session %s",
    async (sessionKey) => {
      const f = fixture();
      const cleanup = createCallCleanup(f.deps);
      await cleanup.enqueue({ ...f.call, sessionKey });
      await cleanup.run(f.call.callId);
      expect(f.getSessionEntry).not.toHaveBeenCalled();
      expect(mocks.deleteSessionEntry).not.toHaveBeenCalled();
    },
  );

  it("refuses capacity overflow rather than evicting an unfinished obligation", async () => {
    const f = fixture();
    const cleanup = createCallCleanup(f.deps);
    await cleanup.enqueue(f.call);
    f.capacityFull();
    await expect(cleanup.prepare({ ...f.call, callId: "call-2" })).rejects.toThrow("capacity");
    expect(f.values.size).toBe(1);
  });

  it("pending intent survives cancellation of scheduled report work and service stop", async () => {
    const f = fixture();
    const cleanup = createCallCleanup(f.deps);
    await cleanup.enqueue(f.call);
    await cleanup.stop();
    expect(f.values.size).toBe(1);
    expect(mocks.deleteSessionEntry).not.toHaveBeenCalled();
  });
});
