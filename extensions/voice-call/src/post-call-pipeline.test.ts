import { beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceCallConfigSchema } from "./config.js";
import { buildOnCallEndedHandler } from "./post-call-pipeline.js";
import { CallRecordSchema } from "./types.js";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  readFile: vi.fn(),
  loadContactsFileAsync: vi.fn(async (_options?: unknown) => []),
  contact: undefined as { name: string; phone: string } | undefined,
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  open: vi.fn(),
  link: vi.fn(),
  unlink: vi.fn(),
  sync: vi.fn(),
  close: vi.fn(),
  directorySync: vi.fn(),
  enqueueCleanup: vi.fn(),
  runCleanup: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ default: mocks }));
vi.mock("./contact-file.js", () => ({
  loadContactsFileAsync: mocks.loadContactsFileAsync,
  findContactByPhone: () => mocks.contact,
}));

type SummaryRunParams = Parameters<
  Parameters<typeof buildOnCallEndedHandler>[0]["agentRuntime"]["runEmbeddedAgent"]
>[0];

function fixture() {
  const jobs: Array<() => void | Promise<unknown>> = [];
  let current = true;
  const sendText = vi.fn();
  const runEmbeddedAgent = vi.fn(async (params: SummaryRunParams) => {
    // The public plugin boundary requires a persisted row for every sessionTarget.
    // Summary identities deliberately have no row; detached does not waive that guard.
    if (params.sessionTarget) {
      throw new Error("A persisted session requires its exact session target identity.");
    }
    return { payloads: [{ text: "总结内容" }] };
  });
  const controller = new AbortController();
  const scheduler = {
    signal: controller.signal,
    schedule: vi.fn((params) => {
      jobs.push(params.run);
    }),
  };
  const deps = {
    scheduler,
    cleanup: { enqueue: mocks.enqueueCleanup, run: mocks.runCleanup },
    config: VoiceCallConfigSchema.parse({
      streaming: { hybridMode: true },
      postCallReport: { discord: { target: "user:123456789012345678" } },
    }),
    coreConfig: { channels: { discord: { allowFrom: ["synthetic-owner"] } } },
    agentRuntime: {
      runEmbeddedAgent,
      defaults: { provider: "openai", model: "synthetic-model" },
      resolveThinkingDefault: () => "off",
      resolveAgentDir: () => "/synthetic/agent",
      resolveAgentWorkspaceDir: () => "/synthetic/workspace",
      resolveAgentIdentity: () => ({ name: "Agent" }),
      resolveAgentDisplayIdentity: vi.fn(async () => ({ name: "规范助手" })),
      session: {
        resolveStorePath: () => "/synthetic/store",
        getSessionEntry: () => ({ sessionId: "synthetic-session", updatedAt: 1 }),
        upsertSessionEntry: vi.fn(),
        runWithWorkAdmission: async (
          _params: unknown,
          run: (signal: AbortSignal) => Promise<unknown>,
        ) => run(new AbortController().signal),
      },
    },
    outboundRuntime: { loadAdapter: vi.fn(async () => ({ sendText })) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    isCurrent: () => current,
  } as unknown as Parameters<typeof buildOnCallEndedHandler>[0];
  const call = CallRecordSchema.parse({
    callId: "call-1",
    agentId: "sales",
    sessionKey: "agent:sales:voice:call:call-1",
    direction: "outbound",
    from: "+15550000000",
    to: "+15550000001",
    provider: "twilio",
    state: "hangup-bot",
    endReason: "hangup-bot",
    startedAt: 1000,
    endedAt: 3000,
    transcript: [],
    processedEventIds: [],
  });
  return {
    deps,
    call,
    jobs,
    sendText,
    runEmbeddedAgent,
    abort: () => controller.abort(),
    retire: () => {
      current = false;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.contact = undefined;
  mocks.readFile.mockReset().mockResolvedValue("- **Name:** 规范助手\n- **NickName:** 小助\n");
  mocks.loadContactsFileAsync.mockReset().mockResolvedValue([]);
  mocks.access
    .mockReset()
    .mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
  mocks.writeFile.mockReset().mockResolvedValue(undefined);
  mocks.sync.mockReset().mockResolvedValue(undefined);
  mocks.directorySync.mockReset().mockResolvedValue(undefined);
  mocks.mkdir.mockReset().mockResolvedValue("/synthetic/workspace/call_logs");
  mocks.open
    .mockReset()
    .mockImplementation(async (_path: string, mode: string) =>
      mode === "r"
        ? { sync: mocks.directorySync, close: mocks.close }
        : { writeFile: mocks.writeFile, sync: mocks.sync, close: mocks.close },
    );
  mocks.enqueueCleanup.mockReset().mockResolvedValue(undefined);
  mocks.runCleanup.mockReset().mockResolvedValue(undefined);
  mocks.link.mockReset().mockResolvedValue(undefined);
  mocks.unlink.mockResolvedValue(undefined);
});

describe("service-owned post-call reports", () => {
  it.each([true, false])(
    "uses canonical assistant identity and a name-only known contact (known: %s)",
    async (known) => {
      const { deps, call, jobs, sendText } = fixture();
      if (known) {
        mocks.contact = { name: "演示联系人", phone: call.to };
      }
      call.transcript = [
        { speaker: "user", text: "你好", timestamp: 1500, isFinal: true },
        { speaker: "bot", text: "已听到", timestamp: 1600, isFinal: true },
      ];
      await buildOnCallEndedHandler(deps)(call);
      await jobs[0]!();
      const label = known ? "演示联系人" : call.to;
      const report = mocks.writeFile.mock.calls[0]![0] as string;
      expect(report).toContain(`- **对方：** ${label}\n`);
      expect(report).toContain(`[${label}] 你好`);
      expect(report).toContain("[规范助手] 已听到");
      expect(report).not.toContain("[Agent]");
      expect(report).not.toContain("[小助]");
      if (known) {
        expect(report).not.toContain(call.to);
      }
      expect(deps.agentRuntime.resolveAgentDisplayIdentity).toHaveBeenCalledWith({
        cfg: deps.coreConfig,
        agentId: "sales",
        workspaceDir: "/synthetic/workspace",
      });
      expect(mocks.loadContactsFileAsync).toHaveBeenCalledWith({
        workspaceDir: "/synthetic/workspace",
      });
      expect(sendText).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining(report) }),
      );
    },
  );

  it("never exposes a report receipt when writing the temporary artifact fails", async () => {
    const { deps, call, jobs, sendText } = fixture();
    mocks.writeFile.mockRejectedValueOnce(new Error("synthetic partial write"));
    await buildOnCallEndedHandler(deps)(call);
    await jobs[0]!();
    expect(mocks.link).not.toHaveBeenCalled();
    expect(mocks.unlink).toHaveBeenCalledWith(expect.stringContaining(".partial-"));
    expect(sendText).not.toHaveBeenCalled();
    expect(mocks.runCleanup).toHaveBeenCalledWith(call.callId);
  });

  it("summarizes with the frozen call owner and no tools or durable auxiliary state", async () => {
    const { deps, call, jobs, runEmbeddedAgent, sendText } = fixture();
    call.transcript = [{ speaker: "user", text: "测试通话内容", timestamp: 1500, isFinal: true }];
    await buildOnCallEndedHandler(deps)(call);
    await jobs[0]!();
    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "sales",
        disableTools: true,
        senderIsOwner: false,
        sessionKey: "agent:sales:voice:summary:call-1",
        sessionPersistence: "detached",
        disableTrajectory: true,
      }),
    );
    const summaryRun = runEmbeddedAgent.mock.calls[0]![0];
    expect(summaryRun).not.toHaveProperty("sessionTarget");
    expect(summaryRun).not.toHaveProperty("sessionFile");
    expect(summaryRun.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(deps.agentRuntime.session.upsertSessionEntry).not.toHaveBeenCalled();
    expect(deps.logger.warn).not.toHaveBeenCalled();
    expect(mocks.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("## 通话总结\n\n总结内容"),
      "utf8",
    );
    expect(mocks.enqueueCleanup).toHaveBeenCalledWith(call);
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("总结内容") }),
    );
  });

  it("writes one deterministic report and uses lifecycle cleanup for the recorded agent", async () => {
    const { deps, call, jobs, sendText } = fixture();
    await buildOnCallEndedHandler(deps)(call);
    await jobs[0]!();
    expect(mocks.open).toHaveBeenCalledWith(expect.stringContaining(".partial-"), "wx", 0o600);
    expect(mocks.sync).toHaveBeenCalledTimes(1);
    expect(mocks.link).toHaveBeenCalledWith(
      expect.any(String),
      "/synthetic/workspace/call_logs/OUT-1970-01-01-000003-call-1.md",
    );
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueCleanup).toHaveBeenCalledWith(call);
    expect(mocks.runCleanup).toHaveBeenCalledWith(call.callId);
    expect(mocks.directorySync).toHaveBeenCalledTimes(2);
    expect(mocks.directorySync.mock.invocationCallOrder.at(-1)).toBeLessThan(
      sendText.mock.invocationCallOrder[0]!,
    );
  });
  it("never sends a duplicate report when the durable artifact already exists", async () => {
    const { deps, call, jobs, sendText } = fixture();
    mocks.access.mockResolvedValue(undefined);
    await buildOnCallEndedHandler(deps)(call);
    await jobs[0]!();
    expect(sendText).not.toHaveBeenCalled();
    expect(mocks.runCleanup).toHaveBeenCalledWith(call.callId);
  });
  it("cleans retired queued work without generating or sending a report", async () => {
    const { deps, call, jobs, retire } = fixture();
    await buildOnCallEndedHandler(deps)(call);
    retire();
    await jobs[0]!();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.runCleanup).toHaveBeenCalledWith(call.callId);
  });
  it("records the cleanup obligation even when finalization arrives after service abort", async () => {
    const { deps, call, jobs, abort } = fixture();
    abort();
    await buildOnCallEndedHandler(deps)(call);
    expect(mocks.enqueueCleanup).toHaveBeenCalledWith(call);
    expect(jobs).toHaveLength(0);
  });
  it("still cleans a report whose summary is interrupted by retirement", async () => {
    const { deps, call, jobs, retire, abort, runEmbeddedAgent, sendText } = fixture();
    call.transcript = [
      { speaker: "user", text: "during shutdown", timestamp: 1500, isFinal: true },
    ];
    let finish!: (value: { payloads: { text: string }[] }) => void;
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    runEmbeddedAgent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
          enter();
        }),
    );
    await buildOnCallEndedHandler(deps)(call);
    const pending = jobs[0]!();
    await entered;
    retire();
    abort();
    finish({ payloads: [{ text: "late summary" }] });
    await pending;
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(mocks.runCleanup).toHaveBeenCalledWith(call.callId);
  });
  it("does not send when publication directory sync fails", async () => {
    const { deps, call, jobs, sendText } = fixture();
    mocks.directorySync.mockRejectedValueOnce(new Error("directory sync failed"));
    await buildOnCallEndedHandler(deps)(call);
    await jobs[0]!();
    expect(mocks.link).toHaveBeenCalledTimes(1);
    expect(sendText).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("directory sync failed"));
    expect(mocks.runCleanup).toHaveBeenCalledWith(call.callId);
  });
  it("does not send after a concurrent report wins publication", async () => {
    const { deps, call, jobs, sendText } = fixture();
    mocks.link.mockRejectedValueOnce(Object.assign(new Error("exists"), { code: "EEXIST" }));
    await buildOnCallEndedHandler(deps)(call);
    await jobs[0]!();
    expect(mocks.directorySync).toHaveBeenCalledTimes(2);
    expect(sendText).not.toHaveBeenCalled();
  });
  it("filters phantom reports while still releasing ephemeral resources", async () => {
    const { deps, call, jobs, sendText } = fixture();
    call.endedAt = call.startedAt;
    await buildOnCallEndedHandler(deps)(call);
    await jobs[0]!();
    expect(sendText).not.toHaveBeenCalled();
    expect(mocks.runCleanup).toHaveBeenCalledWith(call.callId);
    expect(mocks.runCleanup).toHaveBeenCalledTimes(1);
  });
});
