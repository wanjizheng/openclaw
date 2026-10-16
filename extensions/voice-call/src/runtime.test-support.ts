import { vi } from "vitest";
import type { VoiceCallConfig } from "./config.js";
import { createVoiceCallBaseConfig } from "./test-fixtures.js";

export function createBaseConfig(): VoiceCallConfig {
  return createVoiceCallBaseConfig({ tunnelProvider: "ngrok" });
}

type MockSessionEntry = {
  sessionId?: string;
  updatedAt?: number;
  [key: string]: unknown;
};

export function createMockSessionRuntime(sessionStore: Record<string, unknown>) {
  return {
    resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
    loadSessionStore: vi.fn(() => sessionStore),
    saveSessionStore: vi.fn(async () => {}),
    updateSessionStore: vi.fn(async (_storePath, mutator: (store: never) => unknown) =>
      mutator(sessionStore as never),
    ),
    getSessionEntry: vi.fn(
      ({ sessionKey }: { sessionKey: string }) => sessionStore[sessionKey] as MockSessionEntry,
    ),
    patchSessionEntry: vi.fn(
      async ({
        sessionKey,
        fallbackEntry,
        update,
      }: {
        sessionKey: string;
        fallbackEntry: MockSessionEntry;
        update: (entry: MockSessionEntry) => Promise<MockSessionEntry> | MockSessionEntry;
      }) => {
        const current = (sessionStore[sessionKey] as MockSessionEntry | undefined) ?? fallbackEntry;
        const patch = await update(current);
        const next = { ...current, ...patch };
        sessionStore[sessionKey] = next;
        return next;
      },
    ),
    resolveSessionFilePath: vi.fn(() => "/tmp/session.json"),
  };
}
