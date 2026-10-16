import type http from "node:http";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getHeader } from "./http-headers.js";

// Voice Call plugin module normalizes proxy IP representations.
export function normalizeProxyIp(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const unwrapped =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  const normalized = unwrapped.toLowerCase();
  const mappedIpv4Prefix = "::ffff:";
  if (normalized.startsWith(mappedIpv4Prefix)) {
    const mappedIpv4 = normalized.slice(mappedIpv4Prefix.length);
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(mappedIpv4)) {
      return mappedIpv4;
    }
  }
  return normalized;
}

export function resolveForwardedClientIp(
  request: http.IncomingMessage,
  normalizedTrustedProxyIps: ReadonlySet<string>,
): string | undefined {
  const forwardedFor = getHeader(request.headers, "x-forwarded-for");
  if (forwardedFor) {
    const forwardedIps = normalizeStringEntries(forwardedFor.split(","));
    if (forwardedIps.length > 0) {
      for (let index = forwardedIps.length - 1; index >= 0; index -= 1) {
        const hop = forwardedIps[index];
        if (!normalizedTrustedProxyIps.has(normalizeProxyIp(hop) ?? "")) {
          return hop;
        }
      }
      return forwardedIps[0];
    }
  }

  const realIp = getHeader(request.headers, "x-real-ip")?.trim();
  return realIp || undefined;
}
