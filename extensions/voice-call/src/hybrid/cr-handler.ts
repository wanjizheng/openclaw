/**
 * Hybrid mode ConversationRelay WebSocket handler.
 *
 * In hybrid mode the inbound audio is forked to our own STT via `<Start><Stream>`,
 * so the CR socket is used purely as an event channel: setup / interrupt /
 * hangup detection.  We deliberately ignore CR's own `prompt` (Deepgram
 * transcript) events to avoid double-transcription.
 *
 * The CR socket also gets disconnected each time we issue a Call Update with
 * `<Play>` (Twilio replaces the active TwiML). This is expected — we suppress
 * synthesizing `call.ended` while a hybrid play queue is active for the SID.
 */

import http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { CallManager } from "../manager.js";
import type { NormalizedEvent } from "../types.js";

export type HybridCrHandlerDeps = {
  manager: CallManager;
  /** Returns true while a hybrid play queue is active for the given SID. */
  isHybridPlaying: (callSid: string) => boolean;
  /** Abort any in-flight LLM response for a callId. */
  abortInFlightResponse?: (callId: string) => void;
  /** Speak the call's stored initial message via its provider call ID. */
  speakInitialMessage?: (providerCallId: string) => Promise<void>;
};

export class HybridCrHandler {
  private wss: WebSocketServer | null = null;
  private connections = new Map<string, WebSocket>();

  constructor(private readonly deps: HybridCrHandlerDeps) {}

  /** Mount the WS upgrade for a given path. Idempotent. */
  handleUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.wss) {
      this.wss = new WebSocketServer({ noServer: true });
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.handleConnection(ws);
    });
  }

  getConnection(callSid: string): WebSocket | undefined {
    return this.connections.get(callSid);
  }

  private handleConnection(ws: WebSocket): void {
    let callSid: string | null = null;
    let callId: string | null = null;

    console.log("[voice-call][cr] New ConversationRelay WebSocket connection");

    ws.on("message", (data: Buffer | string | ArrayBuffer | Buffer[]) => {
      try {
        let raw: string;
        if (typeof data === "string") {
          raw = data;
        } else if (Array.isArray(data)) {
          raw = Buffer.concat(data).toString();
        } else if (Buffer.isBuffer(data)) {
          raw = data.toString();
        } else {
          raw = Buffer.from(new Uint8Array(data)).toString();
        }
        const msg = JSON.parse(raw);
        const summary = JSON.stringify(msg).slice(0, 300);
        console.log(`[voice-call][cr] Received: ${summary}`);

        switch (msg.type) {
          case "setup": {
            const sid = typeof msg.callSid === "string" ? msg.callSid : null;
            if (!sid) {
              console.warn("[voice-call][cr] setup message missing callSid");
              break;
            }
            callSid = sid;
            this.connections.set(sid, ws);

            const call = this.deps.manager.getCallByProviderCallId(sid);
            if (!call) {
              console.warn(`[voice-call][cr] No call record for callSid ${sid}`);
              break;
            }
            callId = call.callId;
            console.log(`[voice-call][cr] Linked CR session to call ${callId} (${sid})`);

            // Synthesize call.answered if still ringing.
            if (call.state === "ringing") {
              const answered: NormalizedEvent = {
                id: `cr-answered-${Date.now()}`,
                type: "call.answered",
                callId: call.callId,
                providerCallId: sid,
                timestamp: Date.now(),
              };
              this.deps.manager.processEvent(answered);
              console.log(`[voice-call][cr] Synthesized call.answered for ${callId}`);
            }

            // Speak initial message via the manager (which routes through the
            // hybrid TTS queue + Call Update <Play> path when hybrid is on).
            if (
              typeof call.metadata?.initialMessage === "string" &&
              this.deps.speakInitialMessage
            ) {
              const cid = call.callId;
              const providerCallId = sid;
              const direction = call.direction;
              setTimeout(() => {
                this.deps.speakInitialMessage!(providerCallId)
                  .then(() => {
                    console.log(
                      `[voice-call][cr] Greeting playback initiated for ${cid} (${direction})`,
                    );
                  })
                  .catch((err: unknown) => {
                    console.warn(`[voice-call][cr] Failed to speak greeting:`, err);
                  });
              }, 300);
            }
            break;
          }

          case "prompt": {
            // Hybrid mode: STT comes from the fork Media Stream (OpenAI).
            // Ignore CR's Deepgram transcripts to avoid double-transcription.
            const text = typeof msg.voicePrompt === "string" ? msg.voicePrompt : "";
            console.log(
              `[voice-call][cr][hybrid] Ignoring CR prompt (using fork STT): "${text.slice(0, 60)}" (call ${callId})`,
            );
            break;
          }

          case "interrupt": {
            console.log(`[voice-call][cr] Interrupt received for call ${callId}`);
            if (callId && this.deps.abortInFlightResponse) {
              this.deps.abortInFlightResponse(callId);
            }
            break;
          }

          case "dtmf": {
            console.log(`[voice-call][cr] DTMF digit: ${msg.digit} for call ${callId}`);
            break;
          }

          default:
            console.log(`[voice-call][cr] Unknown message type: ${msg.type}`);
        }
      } catch (err) {
        console.error("[voice-call][cr] Message parse error:", err);
      }
    });

    ws.on("close", (code: number, reason: Buffer) => {
      console.log(`[voice-call][cr] WebSocket closed (code=${code}, reason=${reason?.toString()})`);
      if (callSid) {
        this.connections.delete(callSid);
      }
      if (!callId || !callSid) {
        return;
      }

      // Suppress call.ended when CR disconnects due to hybrid <Play> injection.
      if (this.deps.isHybridPlaying(callSid)) {
        console.log(
          `[voice-call][cr][hybrid] Expected CR disconnect during play for ${callId}, not ending call`,
        );
        return;
      }

      const call = this.deps.manager.getCall(callId);
      if (!call) {
        return;
      }
      const terminalStates = new Set(["ended", "failed", "no-answer", "busy", "canceled"]);
      if (terminalStates.has(call.state)) {
        return;
      }

      console.log(`[voice-call][cr] Synthesizing call.ended for ${callId}`);
      const ended: NormalizedEvent = {
        id: `cr-ended-${Date.now()}`,
        type: "call.ended",
        callId,
        providerCallId: callSid,
        timestamp: Date.now(),
        reason: "hangup-user",
      };
      this.deps.manager.processEvent(ended);
    });

    ws.on("error", (err: Error) => {
      console.error(`[voice-call][cr] WebSocket error:`, err);
    });
  }
}
