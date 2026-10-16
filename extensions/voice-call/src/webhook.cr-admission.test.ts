import crypto from "node:crypto";
import { once } from "node:events";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import type { RealtimeTranscriptionProviderPlugin } from "openclaw/plugin-sdk/realtime-transcription";
import { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { describe, expect, it, vi } from "vitest";
import { VoiceCallConfigSchema } from "./config.js";
import type { CallManager } from "./manager.js";
import { TwilioProvider } from "./providers/twilio.js";
import { CallRecordSchema, type NormalizedEvent } from "./types.js";
import { VoiceCallWebhookServer } from "./webhook.js";

vi.mock("./realtime-transcription.runtime.js", () => ({
  getRealtimeTranscriptionProvider: () => undefined,
  listRealtimeTranscriptionProviders: () => [
    {
      id: "fixture",
      label: "Fixture",
      isConfigured: () => true,
      createSession: (): never => {
        throw new Error("No media start in CR admission tests");
      },
    } satisfies RealtimeTranscriptionProviderPlugin,
  ],
}));

function xmlUrl(xml: string, element: string, attribute: string): URL {
  const value = new RegExp(`<${element}[^>]* ${attribute}="([^"]+)"`).exec(xml)?.[1];
  if (!value) {
    throw new Error("Missing expected TwiML URL");
  }
  return new URL(value.replaceAll("&amp;", "&"));
}

async function fixture() {
  const auth = "synthetic-admission-token";
  const publicUrl = "https://relay.example.test/voice/webhook";
  const scheduler = createTestPluginServiceScheduler();
  const config = VoiceCallConfigSchema.parse({
    provider: "twilio",
    inboundPolicy: "open",
    serve: { port: 1, bind: "127.0.0.1", path: "/voice/webhook" },
    staleCallReaperSeconds: 0,
    streaming: { enabled: true, hybridMode: true },
  });
  config.serve.port = 0;
  const calls = new Map<string, ReturnType<typeof CallRecordSchema.parse>>();
  const addCall = (sid: string) => {
    const call = CallRecordSchema.parse({
      callId: crypto.randomUUID(),
      providerCallId: sid,
      provider: "twilio",
      direction: "inbound",
      state: "listening",
      from: "+15550000001",
      to: "+15550000002",
      startedAt: Date.now(),
      transcript: [],
      processedEventIds: [],
    });
    calls.set(sid, call);
    return call;
  };
  const invalidateAutoResponse = vi.fn();
  const processEvent = vi.fn<CallManager["processEvent"]>(async (event: NormalizedEvent) => {
    if (event.providerCallId && !calls.has(event.providerCallId)) {
      addCall(event.providerCallId);
    }
    return { kind: "ignored" };
  });
  const manager = {
    getCallByProviderCallId: (sid: string) => calls.get(sid),
    getCall: (id: string) => [...calls.values()].find((call) => call.callId === id),
    processEvent,
    invalidateAutoResponse,
    speakInitialMessage: vi.fn(),
  } as unknown as CallManager;
  let current = true;
  const provider = new TwilioProvider(
    { accountSid: "AC-fixture", authToken: auth },
    {
      publicUrl,
      hybridMode: true,
      streamPath: "/voice/stream",
      crPath: "/voice/cr",
    },
  );
  provider.setLifecycleGuard(() => current);
  const server = new VoiceCallWebhookServer(scheduler, config, manager, provider);
  const local = new URL(await server.start());
  const sockets = new Set<WebSocket>();
  const signature = (url: URL, body = "") => {
    let input = url.toString();
    const params = new URLSearchParams(body);
    for (const key of [...new Set(params.keys())].toSorted()) {
      for (const value of params.getAll(key).toSorted()) {
        input += key + value;
      }
    }
    return crypto.createHmac("sha1", auth).update(input).digest("base64");
  };
  const wire = (url: URL) => {
    const requestUrl = new URL(url);
    requestUrl.protocol = "http:";
    requestUrl.host = local.host;
    return requestUrl;
  };
  const socket = (url: URL, signedUrl = url) => {
    const requestUrl = wire(url);
    requestUrl.protocol = "ws:";
    const ws = new WebSocket(requestUrl, {
      headers: { "x-twilio-signature": signature(signedUrl) },
    });
    sockets.add(ws);
    ws.on("error", () => {});
    return ws;
  };
  const tryUpgrade = async (url: URL, signedUrl = url) => {
    const ws = socket(url, signedUrl);
    const status = await new Promise<number>((resolve) => {
      ws.once("open", () => resolve(101));
      ws.once("unexpected-response", (_request, response) => {
        response.resume();
        ws.terminate();
        resolve(response.statusCode ?? 0);
      });
    });
    return { status, ws };
  };
  const connect = async (url: URL, sid: string) => {
    const ws = socket(url);
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "setup", callSid: sid }));
    return ws;
  };
  const rejected = async (url: URL) => {
    const ws = socket(url);
    return await new Promise<number>((resolve) => {
      ws.once("unexpected-response", (_request, response) => {
        response.resume();
        ws.terminate();
        resolve(response.statusCode ?? 0);
      });
    });
  };
  const post = async (url: URL, body: string) => {
    const result = await fetch(wire(url), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signature(url, body),
      },
      body,
    });
    return { status: result.status, body: await result.text() };
  };
  const issue = (sid: string) => {
    const result = provider.hybridCr.issue(publicUrl, "/voice/cr", sid);
    if (!result?.actionUrl) {
      throw new Error("Missing call-scoped grant");
    }
    return { ws: new URL(result.wsUrl), action: new URL(result.actionUrl) };
  };
  return {
    calls,
    addCall,
    manager,
    processEvent,
    provider,
    connect,
    tryUpgrade,
    rejected,
    post,
    issue,
    publicUrl,
    invalidateAutoResponse,
    retire: () => {
      current = false;
    },
    stop: async () => {
      for (const ws of sockets) {
        ws.terminate();
      }
      await server.stop();
      await scheduler.stop();
    },
  };
}

describe("signed CR upgrade and reconnect boundary", () => {
  it("rejects signatures for a different scheme or query without consuming the WSS grant", async () => {
    const f = await fixture();
    const sid = `CA-${crypto.randomUUID()}`;
    f.addCall(sid);
    try {
      const issued = f.issue(sid);
      const https = new URL(issued.ws);
      https.protocol = "https:";
      const insecure = new URL(issued.ws);
      insecure.protocol = "ws:";
      const noQuery = new URL(issued.ws);
      noQuery.search = "";
      const changedQuery = new URL(issued.ws);
      changedQuery.searchParams.set("crCallSid", "CA-other");
      for (const signedUrl of [https, insecure, noQuery, changedQuery]) {
        expect((await f.tryUpgrade(issued.ws, signedUrl)).status).toBe(401);
      }
      const active = await f.connect(issued.ws, sid);
      active.send(JSON.stringify({ type: "interrupt" }));
      await vi.waitFor(() => expect(f.invalidateAutoResponse).toHaveBeenCalledTimes(1));
      expect(await f.rejected(issued.ws)).toBe(401);
    } finally {
      await f.stop();
    }
  });

  it("rejects legacy static CR URL replay at the real signed upgrade boundary", async () => {
    const f = await fixture();
    const sid = `CA-${crypto.randomUUID()}`;
    f.addCall(sid);
    try {
      // No admission-owner helper: this probe also runs against the pre-fix implementation.
      const legacy = new URL("/voice/cr", f.publicUrl);
      legacy.protocol = "wss:";
      const first = await f.tryUpgrade(legacy);
      if (first.status === 401) {
        // Current positive-grant tests separately prove authenticated CR remains usable.
        expect(first.status).toBe(401);
        return;
      }
      expect(first.status).toBe(101);
      first.ws.send(JSON.stringify({ type: "setup", callSid: sid }));
      first.ws.send(JSON.stringify({ type: "interrupt" }));
      await vi.waitFor(() => expect(f.invalidateAutoResponse).toHaveBeenCalledTimes(1));
      const replay = await f.tryUpgrade(legacy);
      expect(replay.status).toBe(401);
    } finally {
      await f.stop();
    }
  });

  it("rejects a captured consumed GET and mismatched setup without replacing the live socket", async () => {
    const f = await fixture();
    const sid = `CA-${crypto.randomUUID()}`;
    f.addCall(sid);
    try {
      const first = f.issue(sid);
      const active = await f.connect(first.ws, sid);
      active.send(JSON.stringify({ type: "interrupt" }));
      await vi.waitFor(() => expect(f.invalidateAutoResponse).toHaveBeenCalledTimes(1));
      expect(await f.rejected(first.ws)).toBe(401);
      const fresh = f.issue(sid);
      const wrong = await f.connect(fresh.ws, "CA-another-call");
      await once(wrong, "close");
      expect(active.readyState).toBe(WebSocket.OPEN);
      active.send(JSON.stringify({ type: "interrupt" }));
      await vi.waitFor(() => expect(f.invalidateAutoResponse).toHaveBeenCalledTimes(2));
      expect(await f.rejected(fresh.ws)).toBe(401);
    } finally {
      await f.stop();
    }
  });

  it("returns a fresh signed action reconnect URL once; captured old POST never rotates it again", async () => {
    const f = await fixture();
    const sid = `CA-${crypto.randomUUID()}`;
    f.addCall(sid);
    try {
      const first = f.issue(sid);
      const initial = await f.connect(first.ws, sid);
      initial.send(JSON.stringify({ type: "interrupt" }));
      await vi.waitFor(() => expect(f.invalidateAutoResponse).toHaveBeenCalledTimes(1));
      expect((await f.post(first.action, "CallSid=CA-other")).status).toBe(410);
      const body = new URLSearchParams({ CallSid: sid }).toString();
      const issue = vi.spyOn(f.provider.hybridCr, "issue");
      const next = await f.post(first.action, body);
      expect(next.status).toBe(200);
      const nextUrl = xmlUrl(next.body, "ConversationRelay", "url");
      expect(nextUrl.toString()).not.toBe(first.ws.toString());
      // A lost action HTTP response can be retried, without issuing or rotating its grant.
      const replay = await f.post(first.action, body);
      expect(replay).toEqual(next);
      expect(xmlUrl(replay.body, "ConversationRelay", "url").toString()).toBe(nextUrl.toString());
      expect(issue).toHaveBeenCalledTimes(1);
      expect(initial.readyState).toBe(WebSocket.OPEN);
      initial.send(JSON.stringify({ type: "interrupt" }));
      await vi.waitFor(() => expect(f.invalidateAutoResponse).toHaveBeenCalledTimes(2));
      const resumed = await f.connect(nextUrl, sid);
      resumed.send(JSON.stringify({ type: "interrupt" }));
      await vi.waitFor(() => expect(f.invalidateAutoResponse).toHaveBeenCalledTimes(3));
      expect(await f.rejected(nextUrl)).toBe(401);
      expect(await f.post(first.action, body)).toEqual(next);
      expect(issue).toHaveBeenCalledTimes(1);
      expect(await f.rejected(nextUrl)).toBe(401);
      resumed.send(JSON.stringify({ type: "interrupt" }));
      await vi.waitFor(() => expect(f.invalidateAutoResponse).toHaveBeenCalledTimes(4));
      const action = xmlUrl(next.body, "Connect", "action");
      expect((await f.post(action, body)).status).toBe(200);
    } finally {
      await f.stop();
    }
  });

  it("binds initial grants after manager admission and preserves duplicate POST identity", async () => {
    const f = await fixture();
    const sid = `CA-${crypto.randomUUID()}`;
    const body = new URLSearchParams({
      CallSid: sid,
      CallStatus: "in-progress",
      Direction: "inbound",
      From: "+15550000001",
      To: "+15550000002",
    }).toString();
    try {
      const initial = await f.post(new URL(f.publicUrl), body);
      expect(initial.status).toBe(200);
      const wsUrl = xmlUrl(initial.body, "ConversationRelay", "url");
      expect(wsUrl.searchParams.get("callId")).toBe(f.calls.get(sid)?.callId);
      const replay = await f.post(new URL(f.publicUrl), body);
      expect(replay.status).toBe(200);
      expect(replay.body).not.toContain("crToken");
      expect(replay.body).not.toContain("crAction");
      expect(replay.body).not.toContain("ConversationRelay");
      const active = await f.connect(wsUrl, sid);
      active.send(JSON.stringify({ type: "interrupt" }));
      await vi.waitFor(() => expect(f.invalidateAutoResponse).toHaveBeenCalledTimes(1));
      expect(await f.rejected(wsUrl)).toBe(401);
      expect(f.processEvent).toHaveBeenCalledTimes(1);
    } finally {
      await f.stop();
    }
  });

  it.each(["terminal", "retired"])("rejects %s service/call admission", async (boundary) => {
    const f = await fixture();
    const sid = `CA-${crypto.randomUUID()}`;
    const call = f.addCall(sid);
    try {
      const issued = f.issue(sid);
      if (boundary === "terminal") {
        call.state = "hangup-bot";
      } else {
        f.retire();
      }
      expect(await f.rejected(issued.ws)).toBe(401);
    } finally {
      await f.stop();
    }
  });
});
