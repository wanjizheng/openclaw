import crypto from "node:crypto";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { resolveTwilioWebSocketUrl } from "../providers/twilio/webhook-routing.js";
import type { CallRecord } from "../types.js";
import { TerminalStates } from "../types.js";
import type { ConversationRelayOptions } from "./twiml.js";

export type CrAdmission = {
  readonly callId: string;
  readonly callSid: string;
  readonly token: string;
  readonly expiresAt: number;
  claimed: boolean;
  promoted: boolean;
  actionUsed: boolean;
};
type CallLease = { latest: CrAdmission; active?: CrAdmission };
const ADMISSION_TTL_MS = 5 * 60_000;

/** The provider's sole owner of pending URL grants and promoted CR connection identity. */
export class HybridCrAdmission {
  private readonly calls = new Map<string, CallLease>();
  private resolveCall: (sid: string) => CallRecord | undefined = () => undefined;

  constructor(
    private readonly isCurrentOwner: () => boolean,
    private readonly now: () => number = () => performance.now(),
  ) {}

  bind(resolveCall: (sid: string) => CallRecord | undefined): void {
    this.invalidateAll();
    this.resolveCall = resolveCall;
  }

  revoke(callSid: string): void {
    this.calls.delete(callSid);
  }

  invalidateAll(): void {
    this.calls.clear();
  }

  private live(callSid: string, callId?: string): CallRecord | undefined {
    if (!this.isCurrentOwner()) {
      this.invalidateAll();
      return undefined;
    }
    const call = this.resolveCall(callSid);
    if (!call || call.providerCallId !== callSid || TerminalStates.has(call.state)) {
      this.revoke(callSid);
      return undefined;
    }
    return callId !== undefined && call.callId !== callId ? undefined : call;
  }

  issue(
    publicUrl: string | null,
    path: string | undefined,
    callSid: string,
  ): ConversationRelayOptions | null {
    const call = this.live(callSid);
    const relayUrl = resolveTwilioWebSocketUrl(publicUrl, path ?? "/voice/cr");
    if (!call || !relayUrl || !publicUrl) {
      return null;
    }
    const admission: CrAdmission = {
      callId: call.callId,
      callSid,
      token: crypto.randomBytes(32).toString("base64url"),
      expiresAt: this.now() + ADMISSION_TTL_MS,
      claimed: false,
      promoted: false,
      actionUsed: false,
    };
    const active = this.calls.get(callSid)?.active;
    this.calls.set(callSid, { latest: admission, active });
    const wsUrl = new URL(relayUrl);
    const actionUrl = new URL(publicUrl);
    for (const url of [wsUrl, actionUrl]) {
      url.searchParams.set("callId", call.callId);
      url.searchParams.set("crCallSid", callSid);
    }
    wsUrl.searchParams.set("crToken", admission.token);
    actionUrl.searchParams.set("crAction", admission.token);
    return { wsUrl: wsUrl.toString(), actionUrl: actionUrl.toString() };
  }

  private exact(url: URL, tokenKey: "crToken" | "crAction"): CrAdmission | undefined {
    if (
      ["callId", "crCallSid", tokenKey].some((key) => url.searchParams.getAll(key).length !== 1)
    ) {
      return undefined;
    }
    const callSid = url.searchParams.get("crCallSid") ?? "";
    const admission = this.calls.get(callSid)?.latest;
    if (
      !admission ||
      !safeEqualSecret(url.searchParams.get(tokenKey) ?? "", admission.token) ||
      !this.live(callSid, url.searchParams.get("callId") ?? "") ||
      admission.callId !== url.searchParams.get("callId")
    ) {
      return undefined;
    }
    return admission;
  }

  /** Consume before WebSocket admission; failed setup cannot replay or replace a live socket. */
  claim(url: URL): CrAdmission | undefined {
    const admission = this.exact(url, "crToken");
    if (!admission || admission.claimed || this.now() >= admission.expiresAt) {
      return undefined;
    }
    admission.claimed = true;
    return admission;
  }

  promote(admission: CrAdmission, setupSid: string): boolean {
    const lease = this.calls.get(admission.callSid);
    if (
      setupSid !== admission.callSid ||
      !admission.claimed ||
      admission.promoted ||
      lease?.latest !== admission ||
      this.now() >= admission.expiresAt ||
      !this.live(admission.callSid, admission.callId)
    ) {
      return false;
    }
    admission.promoted = true;
    lease.active = admission;
    return true;
  }

  isActive(admission: CrAdmission): boolean {
    return (
      this.calls.get(admission.callSid)?.active === admission &&
      this.live(admission.callSid, admission.callId) !== undefined
    );
  }

  reconnect(
    url: URL,
    callSid: string,
    publicUrl: string | null,
    path?: string,
  ): ConversationRelayOptions | null {
    const admission = this.exact(url, "crAction");
    if (
      !admission ||
      admission.callSid !== callSid ||
      admission.actionUsed ||
      (!admission.promoted && this.now() >= admission.expiresAt)
    ) {
      return null;
    }
    admission.actionUsed = true;
    return this.issue(publicUrl, path, callSid);
  }
}
