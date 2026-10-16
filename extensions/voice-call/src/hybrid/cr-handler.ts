import crypto from "node:crypto";
import type http from "node:http";
import type { Duplex } from "node:stream";
import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { type WebSocket, WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";
import type { CallManager } from "../manager.js";
import { TerminalStates } from "../types.js";
import type { CrAdmission, HybridCrAdmission } from "./cr-admission.js";

export type HybridCrHandlerDeps = {
  manager: CallManager;
  scheduler: PluginServiceSchedulerV1;
  admission: HybridCrAdmission;
  speakInitialMessage?: (providerCallId: string) => Promise<void>;
};

/** Signature admission belongs to the webhook owner; setup also binds a live call. */
export class HybridCrHandler {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private readonly connections = new Map<string, WebSocket>();
  private closed = false;

  constructor(private readonly deps: HybridCrHandlerDeps) {}

  handleUpgrade(
    request: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    admission: CrAdmission,
  ): void {
    if (this.closed || this.deps.scheduler.signal.aborted) {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => this.handleConnection(ws, admission));
  }

  getConnection(sid: string): WebSocket | undefined {
    return this.connections.get(sid);
  }

  close(): void {
    this.closed = true;
    for (const ws of this.wss.clients) {
      ws.terminate();
    }
    this.connections.clear();
    this.wss.close();
  }

  private handleConnection(ws: WebSocket, admission: CrAdmission): void {
    let callSid: string | undefined;
    let callId: string | undefined;
    let rejected = false;
    const currentCall = () => {
      if (
        this.closed ||
        this.deps.scheduler.signal.aborted ||
        callSid === undefined ||
        callId === undefined ||
        this.connections.get(callSid) !== ws ||
        !this.deps.admission.isActive(admission)
      ) {
        return undefined;
      }
      const call = this.deps.manager.getCall(callId);
      return call !== undefined && !TerminalStates.has(call.state) ? call : undefined;
    };
    const timeout = this.deps.scheduler.schedule({
      id: `voice:cr:setup:${crypto.randomUUID()}`,
      delayMs: 5000,
      run: () => {
        if (!callSid) {
          ws.terminate();
        }
      },
    });
    ws.on("message", (data) => {
      if (rejected) {
        return;
      }
      try {
        const bytes = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data);
        const msg: unknown = JSON.parse(bytes.toString("utf8"));
        if (!isRecord(msg)) {
          return;
        }
        const value = msg;
        if (value.type === "setup") {
          if (
            this.closed ||
            this.deps.scheduler.signal.aborted ||
            callSid ||
            typeof value.callSid !== "string"
          ) {
            rejected = true;
            ws.close(1008);
            return;
          }
          const call = this.deps.manager.getCallByProviderCallId(value.callSid);
          if (
            !call ||
            call.callId !== admission.callId ||
            TerminalStates.has(call.state) ||
            !this.deps.admission.promote(admission, value.callSid)
          ) {
            rejected = true;
            ws.close(1008);
            return;
          }
          callSid = value.callSid;
          callId = call.callId;
          this.connections.get(callSid)?.close(1000);
          this.connections.set(callSid, ws);
          timeout.cancel();
          this.deps.scheduler.schedule({
            id: `voice:cr:greeting:${callId}`,
            delayMs: 0,
            run: async () => {
              const greetingCall = currentCall();
              if (greetingCall === undefined) {
                return;
              }
              if (greetingCall.state === "ringing" || greetingCall.state === "initiated") {
                await this.deps.manager.processEvent({
                  id: `cr-answered:${callId}`,
                  type: "call.answered",
                  callId: greetingCall.callId,
                  providerCallId: callSid,
                  timestamp: Date.now(),
                });
              }
              const readyCall = currentCall();
              if (
                readyCall !== undefined &&
                typeof readyCall.metadata?.initialMessage === "string" &&
                readyCall.providerCallId !== undefined
              ) {
                await this.deps.speakInitialMessage?.(readyCall.providerCallId);
              }
            },
          });
        } else if (value.type === "interrupt") {
          const interruptedCall = currentCall();
          if (interruptedCall !== undefined) {
            this.deps.manager.invalidateAutoResponse(interruptedCall);
          }
        }
        // STT comes exclusively from the authenticated inbound media fork.
      } catch {
        rejected = true;
        ws.close(1007);
      }
    });
    ws.on("close", () => {
      timeout.cancel();
      // Release this transport even after its call was finalized; never remove its replacement.
      if (callSid && this.connections.get(callSid) === ws) {
        this.connections.delete(callSid);
      }
      // Carrier terminal callbacks own termination. A replaced/dropped CR socket
      // alone does not prove the call ended, including expected MP3 Call Updates.
    });
    ws.on("error", () => {});
  }
}
