import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { onTestFinished, vi } from "vitest";
import { VoiceCallConfigSchema, resolveVoiceCallConfig, type VoiceCallConfig } from "./config.js";
import type { CallManager } from "./manager.js";
import type { CallRecord } from "./types.js";
import { VoiceCallWebhookServer } from "./webhook.js";

type VoiceCallConfigInput = Parameters<typeof resolveVoiceCallConfig>[0];

export const createConfig = (overrides: VoiceCallConfigInput = {}): VoiceCallConfig => {
  const config = VoiceCallConfigSchema.parse({
    ...overrides,
    serve: { ...overrides.serve, port: overrides.serve?.port || 1 },
  });
  config.serve.port = overrides.serve?.port ?? 0;
  return config;
};

export const createCall = (startedAt: number): CallRecord => ({
  callId: "call-1",
  agentId: "main",
  providerCallId: "provider-call-1",
  provider: "mock",
  direction: "outbound",
  state: "initiated",
  from: "+15550001234",
  to: "+15550005678",
  startedAt,
  transcript: [],
  processedEventIds: [],
});

export const automaticReplyManagerStub = {
  updateCallMetadata: async (
    call: CallRecord,
    update: (metadata: CallRecord["metadata"]) => CallRecord["metadata"],
  ) => {
    call.metadata = update(call.metadata);
  },
  createAutoResponseGuard: () => ({ isCurrent: () => true, release: () => {} }),
  invalidateAutoResponse: () => {},
};

export const createManager = (calls: CallRecord[]) => {
  const endCall = vi.fn(async () => ({ success: true }));
  const processEvent = vi.fn<CallManager["processEvent"]>(async () => ({ kind: "processed" }));
  const manager = {
    ...automaticReplyManagerStub,
    getActiveCalls: () => calls,
    endCall,
    processEvent,
  };

  // SAFETY: this fixture supplies every manager capability used by these webhook tests; unrelated operations are not invoked.
  return { manager: manager as unknown as CallManager, endCall, processEvent };
};

export type WebhookServerArgs =
  ConstructorParameters<typeof VoiceCallWebhookServer> extends [unknown, ...infer Args]
    ? Args
    : never;

export function createServer(...args: WebhookServerArgs) {
  const server = new VoiceCallWebhookServer(createTestPluginServiceScheduler(), ...args);
  onTestFinished(() => server.stop());
  return server;
}
