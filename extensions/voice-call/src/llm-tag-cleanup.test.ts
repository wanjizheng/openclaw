import { describe, expect, it } from "vitest";
import { stripLlmReasoningTags } from "./llm-tag-cleanup.js";

describe("stripLlmReasoningTags", () => {
  it("removes think blocks and final tags", () => {
    const input = "<think>secret</think><final>好的主人，</final>晚安～";
    expect(stripLlmReasoningTags(input, { isFinal: true })).toBe("好的主人，晚安～");
  });

  it("keeps ElevenLabs square-bracket tags", () => {
    const input = "[laughs] <final>你好呀</final> [short pause]";
    expect(stripLlmReasoningTags(input, { isFinal: true })).toBe("[laughs] 你好呀 [short pause]");
  });

  it("cleans malformed tag prefixes in final output", () => {
    const input = "<think<final好的主人，\n晚安～\n</final";
    expect(stripLlmReasoningTags(input, { isFinal: true })).toBe("好的主人，\n晚安～\n");
  });
});
