import { afterEach, describe, expect, it, vi } from "vitest";
import type { RetryRunner } from "../infra/retry-policy.js";
import { sendDiscordVoiceMessage } from "./voice-message.js";

const runWithoutRetry: RetryRunner = async <T>(fn: () => Promise<T>) => fn();

describe("sendDiscordVoiceMessage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends native voice message using multipart form payload", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ id: "m1", channel_id: "c1" }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendDiscordVoiceMessage(
      "123",
      Buffer.from([1, 2, 3]),
      { durationSecs: 3.2, waveform: "AQID" },
      undefined,
      runWithoutRetry,
      "test-token",
    );

    expect(result).toEqual({ id: "m1", channel_id: "c1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://discord.com/api/v10/channels/123/messages");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: "Bot test-token" });
    expect(init.body).toBeInstanceOf(FormData);

    const form = init.body as FormData;
    const payloadRaw = form.get("payload_json");
    expect(typeof payloadRaw).toBe("string");
    expect(JSON.parse(payloadRaw as string)).toEqual({
      flags: 8192,
      attachments: [
        {
          id: "0",
          filename: "voice-message.ogg",
          duration_secs: 3.2,
          waveform: "AQID",
        },
      ],
    });
    expect(form.get("files[0]")).toBeTruthy();
  });

  it("includes discord response body in send errors", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({}),
      text: async () => "{\"message\":\"bad request\"}",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendDiscordVoiceMessage(
        "123",
        Buffer.from([1, 2, 3]),
        { durationSecs: 1, waveform: "AQID" },
        "456",
        runWithoutRetry,
        "test-token",
        true,
      ),
    ).rejects.toThrow(
      "Failed to send voice message: 400 Bad Request - {\"message\":\"bad request\"}",
    );
  });
});
