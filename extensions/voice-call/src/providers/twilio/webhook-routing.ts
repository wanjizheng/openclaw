import crypto from "node:crypto";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getHeader } from "../../http-headers.js";
import type { WebhookContext } from "../../types.js";

export function createTwilioRequestDedupeKey(
  ctx: WebhookContext,
  verifiedRequestKey?: string,
): string {
  if (verifiedRequestKey) {
    return verifiedRequestKey;
  }

  const signature = getHeader(ctx.headers, "x-twilio-signature") ?? "";
  const params = new URLSearchParams(ctx.rawBody);
  const callSid = params.get("CallSid") ?? "";
  const callStatus = params.get("CallStatus") ?? "";
  const direction = params.get("Direction") ?? "";
  const callId = normalizeOptionalString(ctx.query?.callId) ?? "";
  const flow = normalizeOptionalString(ctx.query?.flow) ?? "";
  const turnToken = normalizeOptionalString(ctx.query?.turnToken) ?? "";
  return `twilio:fallback:${crypto
    .createHash("sha256")
    .update(
      `${signature}\n${callSid}\n${callStatus}\n${direction}\n${callId}\n${flow}\n${turnToken}\n${ctx.rawBody}`,
    )
    .digest("hex")}`;
}

/** Pure provider URL projections; call admission and replay ownership stay in TwilioProvider. */
export function buildHybridPlayNextUrl(publicUrl: string | null, callId?: string): string | null {
  if (!publicUrl) {
    return null;
  }
  const url = new URL(publicUrl);
  if (callId) {
    url.searchParams.set("callId", callId);
  }
  url.searchParams.set("playAction", "1");
  return url.toString();
}

export function resolveTwilioWebSocketUrl(publicUrl: string | null, path?: string): string | null {
  if (!publicUrl || !path) {
    return null;
  }
  const origin = new URL(publicUrl).origin
    .replace(/^https:\/\//, "wss://")
    .replace(/^http:\/\//, "ws://");
  return `${origin}${path.startsWith("/") ? path : `/${path}`}`;
}
