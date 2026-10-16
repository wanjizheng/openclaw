import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { VoiceCallConfigSchema } from "./config.js";
import { CallManager } from "./manager.js";
import {
  createManagerHarness,
  createTestStorePath,
  installVoiceCallStateRuntimeForTests,
  FakeProvider,
  registerTestManagerCleanup,
} from "./manager.test-harness.js";
import { PlivoProvider } from "./providers/plivo.js";
import { TwilioProvider } from "./providers/twilio.js";
import type { HangupCallInput } from "./types.js";

class DeferredHangupProvider extends FakeProvider {
  readonly attempts: Array<ReturnType<typeof createDeferred<void>>> = [];

  override hangupCall(input: HangupCallInput): Promise<void> {
    this.hangupCalls.push(input);
    const attempt = createDeferred<void>();
    this.attempts.push(attempt);
    return attempt.promise;
  }
}

async function initiateCall() {
  const provider = new DeferredHangupProvider();
  const { manager } = await createManagerHarness({}, provider);
  const result = await manager.initiateCall("+15550000001");
  expect(result.success).toBe(true);
  const call = manager.getCall(result.callId);
  if (!call) {
    throw new Error("expected initiated call");
  }
  return { call, manager, provider };
}

describe("CallManager termination lifecycle", () => {
  it("reports a persisted terminal call once after releasing its active identity", async () => {
    const { manager } = await createManagerHarness();
    const started = await manager.initiateCall("+15550000001");
    const onEnded = vi.fn((call) => {
      expect(manager.getCall(call.callId)).toBeUndefined();
      expect(call.endedAt).toBeDefined();
    });
    manager.setOnCallEnded(onEnded);
    await manager.endCall(started.callId);
    expect(onEnded).toHaveBeenCalledTimes(1);
    await manager.processEvent({
      id: "late-terminal",
      type: "call.ended",
      callId: started.callId,
      timestamp: Date.now(),
      reason: "hangup-user",
    });
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it.each([
    { providerName: "twilio", restart: false },
    { providerName: "twilio", restart: true },
    { providerName: "plivo", restart: true },
  ] as const)(
    "keeps finalized identity for fresh $providerName callbacks (restart=$restart)",
    async ({ providerName, restart }) => {
      const config = VoiceCallConfigSchema.parse({
        enabled: true,
        provider: providerName,
        fromNumber: "+15550000000",
        agentId: "default-agent",
      });
      const { manager, provider, storePath } = await createManagerHarness(
        config,
        new FakeProvider(providerName),
      );
      const started = await manager.initiateCall("+15550000001", "agent:sales:voice:fixture", {
        agentId: "sales",
      });
      expect(started.success).toBe(true);
      const initialProviderId = manager.getCall(started.callId)?.providerCallId;
      if (!initialProviderId) {
        throw new Error("expected an initiated provider call");
      }
      const parser =
        providerName === "twilio"
          ? new TwilioProvider({ accountSid: "AC-fixture", authToken: "synthetic-token" })
          : new PlivoProvider({ authId: "MA-fixture", authToken: "synthetic-token" });
      const callback = (providerId: string, callStatus: string, includeInternalId: boolean) => {
        const query: Record<string, string> = includeInternalId
          ? { callId: started.callId, type: "status" }
          : {};
        const rawBody = new URLSearchParams({
          CallStatus: callStatus,
          From: "+15550000000",
          To: "+15550000001",
          Direction: providerName === "twilio" ? "outbound-api" : "outbound",
          ...(providerName === "twilio" ? { CallSid: providerId } : { RequestUUID: providerId }),
          ...(providerName === "plivo" && includeInternalId ? { CallUUID: "call-uuid" } : {}),
        }).toString();
        const parsed = parser.parseWebhookEvent({
          headers: {},
          rawBody,
          url: `https://example.com/voice/webhook?${new URLSearchParams(query)}`,
          method: "POST",
          query,
        });
        expect(parsed.events).toHaveLength(1);
        const event = parsed.events[0];
        if (!event) {
          throw new Error("expected a normalized provider callback");
        }
        return event;
      };
      await manager.processEvent(callback(initialProviderId, "in-progress", true));
      await expect(
        manager.speak(started.callId, "Preserve this call transcript."),
      ).resolves.toEqual({
        success: true,
      });
      await expect(manager.endCall(started.callId, { reason: "hangup-bot" })).resolves.toEqual({
        success: true,
      });
      const terminal = await manager.getCallFromMemoryOrStore(started.callId);
      if (!terminal) {
        throw new Error("expected the finalized call in SQLite");
      }
      expect(terminal).toMatchObject({
        agentId: "sales",
        sessionKey: "agent:sales:voice:fixture",
        state: "hangup-bot",
        transcript: [expect.objectContaining({ text: "Preserve this call transcript." })],
      });
      let current = manager;
      if (restart) {
        resetPluginStateStoreForTests();
        current = registerTestManagerCleanup(new CallManager(config, storePath));
        await current.initialize(provider, "https://example.com/voice/webhook");
      }

      const late = callback(
        initialProviderId,
        providerName === "plivo" ? "ringing" : "completed",
        providerName === "twilio",
      );
      expect((await current.processEvent(late)).kind).not.toBe("final-speech");

      const history = await current.getCallHistory();
      expect(new Set(history.map((call) => call.callId))).toEqual(new Set([started.callId]));
      expect(await current.getCallFromMemoryOrStore(initialProviderId)).toMatchObject({
        ...terminal,
        processedEventIds: expect.arrayContaining(terminal.processedEventIds),
      });
      expect(current.getActiveCalls()).toEqual([]);
      expect(provider.playTtsCalls).toHaveLength(1);
      expect(provider.hangupCalls).toHaveLength(1);
      expect(provider.startListeningCalls).toEqual([]);
    },
  );

  it("preserves the first provider terminal facts when a pending manager hangup settles", async () => {
    const { call, manager, provider } = await initiateCall();
    const endedAt = Date.now() + 1_000;

    const pendingEnd = manager.endCall(call.callId, { reason: "timeout" });
    try {
      expect(provider.attempts).toHaveLength(1);

      await manager.processEvent({
        id: "provider-terminal",
        type: "call.ended",
        callId: call.callId,
        providerCallId: call.providerCallId,
        timestamp: endedAt,
        reason: "completed",
      });
    } finally {
      for (const attempt of provider.attempts) {
        attempt.resolve();
      }
      await pendingEnd;
    }

    await expect(pendingEnd).resolves.toEqual({ success: true });
    expect(call).toMatchObject({
      state: "completed",
      endReason: "completed",
      endedAt,
    });
  });

  it("shares one carrier hangup result and releases a failed operation for retry", async () => {
    const { call, manager, provider } = await initiateCall();

    const first = manager.endCall(call.callId, { reason: "error" });
    const second = manager.endCall(call.callId, { reason: "error" });
    const firstAttemptCount = provider.attempts.length;
    for (const attempt of provider.attempts) {
      attempt.reject(new Error("carrier unavailable"));
    }
    const [firstResult, secondResult] = await Promise.all([first, second]);

    const retry = manager.endCall(call.callId, { reason: "error" });
    try {
      const retryAttempt = provider.attempts.at(-1);
      if (!retryAttempt) {
        throw new Error("expected retry hangup attempt");
      }
      retryAttempt.resolve();
    } finally {
      for (const attempt of provider.attempts) {
        attempt.resolve();
      }
      await retry;
    }
    await expect(retry).resolves.toEqual({ success: true });

    expect(second).toBe(first);
    expect(firstAttemptCount).toBe(1);
    expect(secondResult).toBe(firstResult);
    expect(firstResult).toEqual({ success: false, error: "carrier unavailable" });
    expect(provider.hangupCalls).toHaveLength(2);
  });
});

describe("CallManager inbound contact greetings", () => {
  it.each([
    { scenario: "contact override", contact: "known", expected: "Welcome Alex!" },
    { scenario: "configured template", contact: "no-greeting", expected: "Hello Alex" },
    { scenario: "unknown caller", contact: "known", from: "+15550000002", expected: "Hello" },
    {
      scenario: "built-in fallback",
      contact: "empty",
      greeting: "",
      expected: "Hello! How can I help you today?",
    },
    { scenario: "empty workspace", contact: "empty", expected: "Hello" },
    { scenario: "unreadable workspace", contact: "EACCES", expected: "Hello" },
    { scenario: "missing workspace legacy fallback", contact: "ENOENT", expected: "Legacy Alex" },
    {
      scenario: "routed agent workspace",
      contact: "no-greeting",
      routed: true,
      expected: "Routed Alex",
    },
    {
      scenario: "older constructor without workspace resolver",
      contact: "known",
      resolver: false,
      expected: "Hello",
    },
    {
      scenario: "workspace resolver failure",
      contact: "known",
      resolverError: true,
      expected: "Hello",
    },
  ])("persists and plays $scenario through the inbound entry", async (fixture) => {
    const workspaceDir = "/synthetic/voice-agent-workspace";
    const workspaceFile = path.join(workspaceDir, "CONTACT_LIST.md");
    const legacyFile = path.join(os.homedir(), ".openclaw", "workspace", "CONTACT_LIST.md");
    const contact = `# Contacts

## Alex
- 电话: +15550000001
${fixture.contact === "no-greeting" ? "" : "- 问候语: Welcome {name}!"}
`;
    const reads: string[] = [];
    const originalRead = fsp.readFile;
    const read = vi.spyOn(fsp, "readFile").mockImplementation(async (...args) => {
      const file = String(args[0]);
      if (file !== workspaceFile && file !== legacyFile) {
        return Reflect.apply(originalRead, fsp, args);
      }
      reads.push(file);
      if (file === legacyFile) {
        return contact.replace("Welcome {name}!", "Legacy {name}");
      }
      if (fixture.contact === "ENOENT" || fixture.contact === "EACCES") {
        throw Object.assign(new Error("synthetic contact file failure"), { code: fixture.contact });
      }
      return fixture.contact === "empty" ? "" : contact;
    });
    try {
      const config = VoiceCallConfigSchema.parse({
        enabled: true,
        provider: "plivo",
        inboundPolicy: "open",
        fromNumber: "+15550000000",
        agentId: "main",
        inboundGreeting: fixture.greeting ?? "Hello {name}",
        ...(fixture.routed
          ? {
              numbers: {
                "+15550000000": { agentId: "voice-agent", inboundGreeting: "Routed {name}" },
              },
            }
          : {}),
      });
      const resolver = vi.fn((agentId: string) => {
        expect(agentId).toBe(fixture.routed ? "voice-agent" : "main");
        if (fixture.resolverError) {
          throw new Error("synthetic resolver failure");
        }
        return workspaceDir;
      });
      installVoiceCallStateRuntimeForTests();
      const provider = new FakeProvider();
      const manager = registerTestManagerCleanup(
        new CallManager(
          config,
          createTestStorePath(),
          undefined,
          undefined,
          fixture.resolver === false ? undefined : resolver,
        ),
      );
      await manager.initialize(provider, "https://example.test/voice");
      await manager.processEvent({
        id: "inbound-contact-start",
        type: "call.initiated",
        callId: "provider-inbound",
        providerCallId: "provider-inbound",
        timestamp: Date.now(),
        direction: "inbound",
        from: fixture.from ?? "+15550000001",
        to: "+15550000000",
      });
      const call = manager.getCallByProviderCallId("provider-inbound");
      expect(call?.metadata?.initialMessage).toBe(fixture.expected);
      expect(call?.agentId).toBe(fixture.routed ? "voice-agent" : "main");
      expect((await manager.getCallHistory()).at(-1)?.metadata?.initialMessage).toBe(
        fixture.expected,
      );
      await manager.speakInitialMessage("provider-inbound");
      expect(provider.playTtsCalls).toEqual([
        expect.objectContaining({ text: fixture.expected, providerCallId: "provider-inbound" }),
      ]);
      const persisted = (await manager.getCallHistory()).at(-1);
      expect(persisted?.metadata?.initialMessage).toBeUndefined();
      expect(persisted?.transcript).toContainEqual(
        expect.objectContaining({ speaker: "bot", text: fixture.expected }),
      );
      if (fixture.resolver === false || fixture.resolverError) {
        expect(reads).toEqual([]);
      } else {
        expect(reads).toEqual(
          fixture.contact === "ENOENT" ? [workspaceFile, legacyFile] : [workspaceFile],
        );
      }
    } finally {
      read.mockRestore();
    }
  });
});
