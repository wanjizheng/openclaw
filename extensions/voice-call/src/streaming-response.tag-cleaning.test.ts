import { describe, expect, it } from "vitest";
import { TagAwareSentenceBuffer } from "./streaming-response.js";

describe("TagAwareSentenceBuffer tag cleaning", () => {
  it("strips malformed DeepSeek tags in streamed chunks and preserves ElevenLabs tags", () => {
    const emitted: string[] = [];
    const buffer = new TagAwareSentenceBuffer((chunk) => {
      emitted.push(chunk.text);
    });

    buffer.push("<think<final好的主人，");
    buffer.push("[laughs]岚岚去睡啦，");
    buffer.push("晚安～</final");
    const result = buffer.end();

    expect(result.endCall).toBe(false);
    expect(emitted.join("")).toBe("好的主人，[laughs]岚岚去睡啦，晚安～");
  });
});
