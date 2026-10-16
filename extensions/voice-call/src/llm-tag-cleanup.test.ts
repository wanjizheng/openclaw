import { describe, expect, it } from "vitest";
import { stripLlmReasoningTags } from "./llm-tag-cleanup.js";

describe("telephony reasoning cleanup", () => {
  it.each([
    ["<think>private reasoning</think><final>Hello</final>", "Hello"],
    ["<thinking>private <thought>nested</thought> notes</thinking>Hello", "Hello"],
    ["<think>incomplete private reasoning", ""],
    ["<think<final你好</</final>", "你好"],
    ["Hello, 2 < 3 is true.", "Hello, 2 < 3 is true."],
  ])("filters unsafe reasoning but preserves spoken content", (input, output) => {
    expect(stripLlmReasoningTags(input, { isFinal: true })).toBe(output);
  });
});
