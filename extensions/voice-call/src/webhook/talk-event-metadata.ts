import type { TalkEvent } from "openclaw/plugin-sdk/realtime-voice";
import type { CallRecord } from "../types.js";

export function appendRecentTalkEventMetadata(
  metadata: CallRecord["metadata"],
  event: TalkEvent,
): CallRecord["metadata"] {
  const previous = metadata ?? {};
  const recent = Array.isArray(previous.recentTalkEvents)
    ? previous.recentTalkEvents.filter(
        (entry): entry is { at: string; type: string; sessionId: string; turnId?: string } =>
          Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
  recent.push({
    at: event.timestamp,
    type: event.type,
    sessionId: event.sessionId,
    turnId: event.turnId,
  });
  return {
    ...previous,
    lastTalkEventAt: event.timestamp,
    lastTalkEventType: event.type,
    recentTalkEvents: recent.slice(-10),
  };
}
