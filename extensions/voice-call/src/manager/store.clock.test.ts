import type {
  OpenAsyncKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, expect, it, vi } from "vitest";
import type { VoiceCallStateRuntime } from "../runtime-state.js";
import { CallRecordSchema } from "../types.js";
import { findCallInStore, getCallHistoryFromStore, persistCallRecord } from "./store.js";

/** In-memory SDK contract fixture isolates writer ordering from native lease clocks. */
function createState(): VoiceCallStateRuntime["state"] {
  const namespaces = new Map<string, Map<string, { value: unknown; createdAt: number }>>();
  return {
    resolveStateDir: () => "/synthetic/state",
    openChannelIngressQueue: () => {
      throw new Error("not used");
    },
    openChannelIngressDrain: () => {
      throw new Error("not used");
    },
    openKeyedStore: <T>(options: OpenAsyncKeyedStoreOptions): PluginStateKeyedStore<T> => {
      let rows = namespaces.get(options.namespace);
      if (!rows) {
        rows = new Map();
        namespaces.set(options.namespace, rows);
      }
      const entries = rows;
      return {
        register: async (key, value) => {
          entries.set(key, { value, createdAt: Date.now() });
        },
        registerIfAbsent: async (key, value) => {
          if (entries.has(key)) {
            return false;
          }
          entries.set(key, { value, createdAt: Date.now() });
          return true;
        },
        lookup: async (key) => entries.get(key)?.value as T | undefined,
        consume: async (key) => {
          const value = entries.get(key)?.value as T | undefined;
          entries.delete(key);
          return value;
        },
        delete: async (key) => entries.delete(key),
        entries: async () =>
          [...entries].map(([key, row]) => ({
            key,
            value: row.value as T,
            createdAt: row.createdAt,
          })),
        count: async () => entries.size,
        clear: async () => {
          entries.clear();
        },
      };
    },
  };
}

afterEach(() => vi.restoreAllMocks());

it("keeps terminal history newer than initiation after the wall clock moves backwards", async () => {
  const state = createState();
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const initial = CallRecordSchema.parse({
    callId: "clock-call",
    agentId: "sales",
    provider: "twilio",
    direction: "outbound",
    state: "initiated",
    from: "+15550000000",
    to: "+15550000001",
    startedAt: now,
    transcript: [],
    processedEventIds: [],
  });
  await persistCallRecord("/synthetic/state", initial, state);
  now -= 60_000;
  const terminal = CallRecordSchema.parse({
    ...initial,
    state: "hangup-bot",
    endedAt: now,
    endReason: "hangup-bot",
    transcript: [{ timestamp: now, speaker: "bot", text: "Preserved transcript" }],
  });
  await persistCallRecord("/synthetic/state", terminal, state);
  expect(await findCallInStore("/synthetic/state", initial.callId, state)).toEqual(terminal);
  expect(await getCallHistoryFromStore("/synthetic/state", 2, state)).toEqual([initial, terminal]);
});
