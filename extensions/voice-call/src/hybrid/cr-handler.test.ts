import { EventEmitter } from "node:events";
import type http from "node:http";
import type { Duplex } from "node:stream";
import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import type { CallManager } from "../manager.js";
import { CallRecordSchema } from "../types.js";
import { HybridCrAdmission } from "./cr-admission.js";
import { HybridCrHandler } from "./cr-handler.js";

const fake = vi.hoisted(() => ({ pending: undefined as EventEmitter | undefined }));
vi.mock("openclaw/plugin-sdk/websocket-runtime", () => ({
  WebSocketServer: class {
    clients = new Set<EventEmitter>();
    handleUpgrade(
      _request: unknown,
      _socket: unknown,
      _head: unknown,
      accept: (ws: EventEmitter) => void,
    ) {
      this.clients.add(fake.pending!);
      accept(fake.pending!);
    }
    close() {}
  },
}));

function fixture() {
  let live = true;
  const call = CallRecordSchema.parse({
    callId: "call-1",
    agentId: "sales",
    providerCallId: "CA1",
    provider: "twilio",
    direction: "inbound",
    state: "listening",
    from: "+15550000001",
    to: "+15550000000",
    startedAt: 1,
    transcript: [],
    processedEventIds: [],
  });
  const manager = {
    getCallByProviderCallId: (sid: string) => (live && sid === "CA1" ? call : undefined),
    getCall: () => (live ? call : undefined),
  } as unknown as CallManager;
  const abort = new AbortController();
  const scheduler = {
    signal: abort.signal,
    schedule: () => ({ cancel: vi.fn(), stop: async () => {} }),
  } as unknown as PluginServiceSchedulerV1;
  const admission = new HybridCrAdmission(() => live);
  admission.bind((sid) => manager.getCallByProviderCallId(sid));
  const handler = new HybridCrHandler({ manager, scheduler, admission });
  const connect = (
    encoding: "buffer" | "arraybuffer" | "chunks" = "buffer",
    setupSid: string | null = "CA1",
  ) => {
    const ws = Object.assign(new EventEmitter(), { close: vi.fn(), terminate: vi.fn() });
    fake.pending = ws;
    const options = admission.issue("https://example.test/voice", "/voice/cr", "CA1");
    const grant = options && admission.claim(new URL(options.wsUrl));
    if (!grant) {
      throw new Error("Missing admission");
    }
    handler.handleUpgrade({} as http.IncomingMessage, {} as Duplex, Buffer.alloc(0), grant);
    const bytes = Buffer.from(JSON.stringify({ type: "setup", callSid: setupSid }));
    const data =
      encoding === "buffer"
        ? bytes
        : encoding === "chunks"
          ? [bytes.subarray(0, 8), bytes.subarray(8)]
          : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    if (setupSid !== null) {
      ws.emit("message", data);
    }
    return ws;
  };
  return {
    handler,
    connect,
    retire: () => abort.abort(),
    finalize: () => {
      live = false;
    },
  };
}

describe("hybrid CR connection ownership", () => {
  it.each(["buffer", "arraybuffer", "chunks"] as const)(
    "decodes %s setup and releases a closed socket after its call was finalized",
    (encoding) => {
      const { handler, connect, finalize } = fixture();
      const ws = connect(encoding);
      expect(handler.getConnection("CA1")).toBe(ws);
      finalize();
      ws.emit("close");
      expect(handler.getConnection("CA1")).toBeUndefined();
      handler.close();
    },
  );
  it("pending setup after scheduler retirement cannot replace or close the old socket", () => {
    const { handler, connect, retire } = fixture();
    const active = connect();
    const pending = connect("buffer", null);
    retire();
    pending.emit("message", Buffer.from(JSON.stringify({ type: "setup", callSid: "CA1" })));
    expect(pending.close).toHaveBeenCalledWith(1008);
    expect(active.close).not.toHaveBeenCalled();
    expect(handler.getConnection("CA1")).toBe(active);
    handler.close();
  });
  it("a mismatched setup cannot close or replace the existing socket", () => {
    const { handler, connect } = fixture();
    const first = connect();
    const rejected = connect("buffer", "CA-other");
    expect(rejected.close).toHaveBeenCalledWith(1008);
    expect(first.close).not.toHaveBeenCalled();
    expect(handler.getConnection("CA1")).toBe(first);
    handler.close();
  });
  it("a late close from a replaced socket cannot remove the current transport", () => {
    const { handler, connect } = fixture();
    const first = connect();
    const second = connect();
    first.emit("close");
    expect(handler.getConnection("CA1")).toBe(second);
    second.emit("close");
    expect(handler.getConnection("CA1")).toBeUndefined();
    handler.close();
  });
});
