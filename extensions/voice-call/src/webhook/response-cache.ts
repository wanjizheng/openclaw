import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import type { WebhookResponsePayload } from "../webhook.types.js";

export function normalizeWebhookResponse(parsed: {
  statusCode?: number;
  providerResponseHeaders?: Record<string, string>;
  providerResponseBody?: string;
}): WebhookResponsePayload {
  return {
    statusCode: parsed.statusCode ?? 200,
    headers: parsed.providerResponseHeaders,
    body: parsed.providerResponseBody ?? "OK",
  };
}

export function buildRealtimeRejectedTwiML(): WebhookResponsePayload {
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/xml" },
    body: '<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="rejected" /></Response>',
  };
}

export function buildTwilioReplayTwiML(): WebhookResponsePayload {
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/xml" },
    body: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
  };
}

const WEBHOOK_REPLAY_RESPONSE_TTL_MS = 10 * 60 * 1000;
const WEBHOOK_REPLAY_RESPONSE_MAX_ENTRIES = 10_000;
const WEBHOOK_REPLAY_RESPONSE_PRUNE_INTERVAL = 64;

type CachedWebhookResponse = {
  expiresAt: number;
  response: Promise<WebhookResponsePayload>;
};

function cloneWebhookResponsePayload(payload: WebhookResponsePayload): WebhookResponsePayload {
  return {
    statusCode: payload.statusCode,
    headers: payload.headers ? { ...payload.headers } : undefined,
    body: payload.body,
  };
}

/** Owns immutable response snapshots and the authenticated replay policy. */
export class WebhookResponseCache {
  private replayResponses = new Map<string, CachedWebhookResponse>();
  private replayResponseCacheCalls = 0;

  constructor(private readonly providerName: string) {}

  private pruneReplayResponses(rawNow: number): void {
    const now = asDateTimestampMs(rawNow);
    if (now !== undefined) {
      for (const [key, entry] of this.replayResponses) {
        if (entry.expiresAt <= now) {
          this.replayResponses.delete(key);
        }
      }
    }
    pruneMapToMaxSize(this.replayResponses, WEBHOOK_REPLAY_RESPONSE_MAX_ENTRIES);
  }

  async get(key: string): Promise<WebhookResponsePayload | null> {
    const now = asDateTimestampMs(Date.now());
    const entry = this.replayResponses.get(key);
    if (!entry || now === undefined) {
      return null;
    }
    if (entry.expiresAt <= now) {
      this.replayResponses.delete(key);
      return null;
    }
    return cloneWebhookResponsePayload(await entry.response);
  }

  async cache(
    key: string,
    buildResponse: () => Promise<WebhookResponsePayload>,
    releaseReplay?: () => void,
    replayPolicy: "token-free" | "exact-cr-action" = "token-free",
  ): Promise<WebhookResponsePayload> {
    const now = Date.now();
    const expiresAt = resolveExpiresAtMsFromDurationMs(WEBHOOK_REPLAY_RESPONSE_TTL_MS, {
      nowMs: now,
    });
    this.replayResponseCacheCalls += 1;
    if (this.replayResponseCacheCalls % WEBHOOK_REPLAY_RESPONSE_PRUNE_INTERVAL === 0) {
      this.pruneReplayResponses(now);
    }

    let cachedEntry: CachedWebhookResponse | undefined;
    const ownerResponse = buildResponse()
      .then(cloneWebhookResponsePayload)
      .catch((err: unknown) => {
        if (cachedEntry && this.replayResponses.get(key) === cachedEntry) {
          this.replayResponses.delete(key);
        }
        releaseReplay?.();
        throw err;
      });
    // Only the authenticated CR action branch returns CR-only reconnect instructions.
    // Retrying its lost HTTP response reuses the SAME grant, without minting or extending it.
    // Initial/media TwiML remains token-free for replay waiters.
    const response = ownerResponse.then((payload) =>
      this.providerName === "twilio" &&
      !(replayPolicy === "exact-cr-action" && payload.statusCode === 200)
        ? buildTwilioReplayTwiML()
        : cloneWebhookResponsePayload(payload),
    );
    // Preserve rejection for concurrent waiters without creating an orphaned rejection.
    void response.catch(() => {});
    if (expiresAt !== undefined) {
      cachedEntry = {
        expiresAt,
        response,
      };
      this.replayResponses.set(key, cachedEntry);
    }
    if (this.replayResponses.size > WEBHOOK_REPLAY_RESPONSE_MAX_ENTRIES) {
      this.pruneReplayResponses(now);
    }
    return cloneWebhookResponsePayload(await ownerResponse);
  }
}
