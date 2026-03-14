import { describe, expect, it } from "vitest";
import type { WebhookContext } from "../types.js";
import { TwilioProvider } from "./twilio.js";

const STREAM_URL = "wss://example.ngrok.app/voice/stream";

function createProvider(): TwilioProvider {
  return new TwilioProvider(
    { accountSid: "AC123", authToken: "secret" },
    { publicUrl: "https://example.ngrok.app", streamPath: "/voice/stream" },
  );
}

function createContext(rawBody: string, query?: WebhookContext["query"]): WebhookContext {
  return {
    headers: {},
    rawBody,
    url: "https://example.ngrok.app/voice/twilio",
    method: "POST",
    query,
  };
}

function expectStreamingTwiml(body: string) {
  expect(body).toContain(STREAM_URL);
  expect(body).toContain('<Parameter name="token" value="');
  expect(body).toContain("<Connect>");
}

describe("TwilioProvider", () => {
  it("returns streaming TwiML for outbound conversation calls before in-progress", () => {
    const provider = createProvider();
    const ctx = createContext("CallStatus=initiated&Direction=outbound-api&CallSid=CA123", {
      callId: "call-1",
    });

    const result = provider.parseWebhookEvent(ctx);

    expect(result.providerResponseBody).toBeDefined();
    expectStreamingTwiml(result.providerResponseBody ?? "");
  });

  it("returns streaming TwiML for outbound callbacks even without callId query", () => {
    const provider = createProvider();
    const ctx = createContext("Direction=outbound-api&CallSid=CA321");

    const result = provider.parseWebhookEvent(ctx);

    expect(result.providerResponseBody).toContain(STREAM_URL);
    expect(result.providerResponseBody).toContain('<Parameter name="token" value="');
    expect(result.providerResponseBody).toContain("<Connect>");
  });

  it("returns empty TwiML for status callbacks", () => {
    const provider = createProvider();
    const ctx = createContext("CallStatus=ringing&Direction=outbound-api", {
      callId: "call-1",
      type: "status",
    });

    const result = provider.parseWebhookEvent(ctx);

    expect(result.providerResponseBody).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    );
  });

  it("returns streaming TwiML for inbound calls", () => {
    const provider = createProvider();
    const ctx = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA456");

    const result = provider.parseWebhookEvent(ctx);

    expect(result.providerResponseBody).toBeDefined();
    expectStreamingTwiml(result.providerResponseBody ?? "");
  });

  it("returns queue TwiML for second inbound call when first call is active", () => {
    const provider = createProvider();
    const firstInbound = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA111");
    const secondInbound = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA222");

    const firstResult = provider.parseWebhookEvent(firstInbound);
    const secondResult = provider.parseWebhookEvent(secondInbound);

    expect(firstResult.providerResponseBody).toContain("<Connect>");
    expect(secondResult.providerResponseBody).toContain("Please hold while we connect you.");
    expect(secondResult.providerResponseBody).toContain("<Enqueue");
    expect(secondResult.providerResponseBody).toContain("hold-queue");
  });

  it("connects next inbound call after unregisterCallStream cleanup", () => {
    const provider = createProvider();
    const firstInbound = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA311");
    const secondInbound = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA322");

    provider.parseWebhookEvent(firstInbound);
    provider.unregisterCallStream("CA311");
    const secondResult = provider.parseWebhookEvent(secondInbound);

    expect(secondResult.providerResponseBody).toContain("<Connect>");
    expect(secondResult.providerResponseBody).not.toContain("hold-queue");
  });

  it("cleans up active inbound call on completed status callback", () => {
    const provider = createProvider();
    const firstInbound = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA411");
    const completed = createContext("CallStatus=completed&Direction=inbound&CallSid=CA411", {
      type: "status",
    });
    const nextInbound = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA422");

    provider.parseWebhookEvent(firstInbound);
    provider.parseWebhookEvent(completed);
    const nextResult = provider.parseWebhookEvent(nextInbound);

    expect(nextResult.providerResponseBody).toContain("<Connect>");
    expect(nextResult.providerResponseBody).not.toContain("hold-queue");
  });

  it("cleans up active inbound call on canceled status callback", () => {
    const provider = createProvider();
    const firstInbound = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA511");
    const canceled = createContext("CallStatus=canceled&Direction=inbound&CallSid=CA511", {
      type: "status",
    });
    const nextInbound = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA522");

    provider.parseWebhookEvent(firstInbound);
    provider.parseWebhookEvent(canceled);
    const nextResult = provider.parseWebhookEvent(nextInbound);

    expect(nextResult.providerResponseBody).toContain("<Connect>");
    expect(nextResult.providerResponseBody).not.toContain("hold-queue");
  });

  it("QUEUE_TWIML references /voice/hold-music waitUrl", () => {
    const provider = createProvider();
    const firstInbound = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA611");
    const secondInbound = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA622");

    provider.parseWebhookEvent(firstInbound);
    const result = provider.parseWebhookEvent(secondInbound);

    expect(result.providerResponseBody).toContain('waitUrl="/voice/hold-music"');
  });

  it("uses a stable fallback dedupeKey for identical request payloads", () => {
    const provider = createProvider();
    const rawBody = "CallSid=CA789&Direction=inbound&SpeechResult=hello";
    const ctxA = {
      ...createContext(rawBody, { callId: "call-1", turnToken: "turn-1" }),
      headers: { "i-twilio-idempotency-token": "idem-123" },
    };
    const ctxB = {
      ...createContext(rawBody, { callId: "call-1", turnToken: "turn-1" }),
      headers: { "i-twilio-idempotency-token": "idem-123" },
    };

    const eventA = provider.parseWebhookEvent(ctxA).events[0];
    const eventB = provider.parseWebhookEvent(ctxB).events[0];

    expect(eventA).toBeDefined();
    expect(eventB).toBeDefined();
    expect(eventA?.id).not.toBe(eventB?.id);
    expect(eventA?.dedupeKey).toContain("twilio:fallback:");
    expect(eventA?.dedupeKey).toBe(eventB?.dedupeKey);
  });

  it("uses verified request key for dedupe and ignores idempotency header changes", () => {
    const provider = createProvider();
    const rawBody = "CallSid=CA790&Direction=inbound&SpeechResult=hello";
    const ctxA = {
      ...createContext(rawBody, { callId: "call-1", turnToken: "turn-1" }),
      headers: { "i-twilio-idempotency-token": "idem-a" },
    };
    const ctxB = {
      ...createContext(rawBody, { callId: "call-1", turnToken: "turn-1" }),
      headers: { "i-twilio-idempotency-token": "idem-b" },
    };

    const eventA = provider.parseWebhookEvent(ctxA, { verifiedRequestKey: "twilio:req:abc" })
      .events[0];
    const eventB = provider.parseWebhookEvent(ctxB, { verifiedRequestKey: "twilio:req:abc" })
      .events[0];

    expect(eventA?.dedupeKey).toBe("twilio:req:abc");
    expect(eventB?.dedupeKey).toBe("twilio:req:abc");
  });

  it("keeps turnToken from query on speech events", () => {
    const provider = createProvider();
    const ctx = createContext("CallSid=CA222&Direction=inbound&SpeechResult=hello", {
      callId: "call-2",
      turnToken: "turn-xyz",
    });

    const event = provider.parseWebhookEvent(ctx).events[0];
    expect(event?.type).toBe("call.speech");
    expect(event?.turnToken).toBe("turn-xyz");
  });

  it("playTts with hosted audio uses Play then reconnects stream (no Gather)", async () => {
    const provider = createProvider();
    (provider as unknown as { callWebhookUrls: Map<string, string> }).callWebhookUrls.set(
      "CA100",
      "https://example.ngrok.app/voice/webhook?callId=call-1",
    );

    const fetchMock = async (_url: string, init?: RequestInit): Promise<Response> => {
      const body = init?.body as URLSearchParams;
      const twiml = body.get("Twiml") || "";
      expect(twiml).toContain("<Play>");
      expect(twiml).toContain("<Connect>");
      expect(twiml).toContain("<Stream");
      expect(twiml).not.toContain("<Gather");
      return new Response("", { status: 200 });
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      await provider.playTts({
        callId: "call-1",
        providerCallId: "CA100",
        text: "hello",
        audioUrl: "https://cdn.example.com/reply.mp3",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("playTts Say fallback reconnects stream without Gather", async () => {
    const provider = createProvider();
    (provider as unknown as { callWebhookUrls: Map<string, string> }).callWebhookUrls.set(
      "CA101",
      "https://example.ngrok.app/voice/webhook?callId=call-2",
    );

    const fetchMock = async (_url: string, init?: RequestInit): Promise<Response> => {
      const body = init?.body as URLSearchParams;
      const twiml = body.get("Twiml") || "";
      expect(twiml).toContain("<Say");
      expect(twiml).toContain("<Connect>");
      expect(twiml).toContain("<Stream");
      expect(twiml).not.toContain("<Gather");
      return new Response("", { status: 200 });
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      await provider.playTts({
        callId: "call-2",
        providerCallId: "CA101",
        text: "fallback",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns voicemail TwiML and voicemail end event when AnsweredBy is machine", () => {
    const provider = createProvider();
    (
      provider as unknown as {
        voicemailTwimlStorage: Map<string, string>;
      }
    ).voicemailTwimlStorage.set(
      "call-voicemail",
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say>please call back</Say><Hangup/></Response>',
    );

    const ctx = createContext(
      "CallStatus=in-progress&Direction=outbound-api&CallSid=CA777&AnsweredBy=machine_end_beep",
      { callId: "call-voicemail" },
    );

    const result = provider.parseWebhookEvent(ctx);

    expect(result.providerResponseBody).toContain("please call back");
    expect(result.events[0]?.type).toBe("call.ended");
    expect(result.events[0]).toMatchObject({ reason: "voicemail" });
  });

  it("hangs up immediately when machine is detected but voicemail TwiML is missing", () => {
    const provider = createProvider();
    const ctx = createContext(
      "CallStatus=in-progress&Direction=outbound-api&CallSid=CA778&AnsweredBy=machine_start",
      { callId: "call-no-voicemail" },
    );

    const result = provider.parseWebhookEvent(ctx);

    expect(result.providerResponseBody).toContain("<Hangup/>");
    expect(result.events[0]?.type).toBe("call.ended");
    expect(result.events[0]).toMatchObject({ reason: "voicemail" });
  });

  it("passes MachineDetection when configured for Twilio outbound", async () => {
    const provider = createProvider();
    let capturedBody: URLSearchParams | null = null;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit): Promise<Response> => {
      capturedBody = init?.body as URLSearchParams;
      return new Response(JSON.stringify({ sid: "CA900", status: "queued" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const result = await provider.initiateCall({
        callId: "call-amd",
        from: "+15550000000",
        to: "+15550000001",
        webhookUrl: "https://example.ngrok.app/voice/webhook",
        twilioMachineDetection: "DetectMessageEnd",
      });

      expect(result.providerCallId).toBe("CA900");
      expect(capturedBody?.get("MachineDetection")).toBe("DetectMessageEnd");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
