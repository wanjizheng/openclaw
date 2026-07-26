import { describe, expect, it } from "vitest";
import { resolveAdaptiveAutoCompactionKeepRecentTokens } from "./compaction-retention.js";

describe("resolveAdaptiveAutoCompactionKeepRecentTokens", () => {
  it("shrinks the retained tail enough to cover full-prompt overflow and summary headroom", () => {
    expect(
      resolveAdaptiveAutoCompactionKeepRecentTokens({
        trigger: "overflow",
        contextTokenBudget: 65_536,
        reserveTokens: 20_000,
        observedTokenCount: 54_941,
        historyTokenEstimate: 14_442,
        currentKeepRecentTokens: 20_000,
      }),
    ).toBe(2_989);
  });

  it("does not override retention when the prompt is within budget", () => {
    expect(
      resolveAdaptiveAutoCompactionKeepRecentTokens({
        trigger: "budget",
        contextTokenBudget: 65_536,
        reserveTokens: 20_000,
        observedTokenCount: 40_000,
        historyTokenEstimate: 14_000,
        currentKeepRecentTokens: 20_000,
      }),
    ).toBeUndefined();
  });

  it("does not change manual compaction retention", () => {
    expect(
      resolveAdaptiveAutoCompactionKeepRecentTokens({
        trigger: "manual",
        contextTokenBudget: 65_536,
        reserveTokens: 20_000,
        observedTokenCount: 54_941,
        historyTokenEstimate: 14_442,
        currentKeepRecentTokens: 20_000,
      }),
    ).toBeUndefined();
  });

  it("keeps at least one token when overflow exceeds estimated history", () => {
    expect(
      resolveAdaptiveAutoCompactionKeepRecentTokens({
        trigger: "overflow",
        contextTokenBudget: 65_536,
        reserveTokens: 20_000,
        observedTokenCount: 70_000,
        historyTokenEstimate: 5_000,
        currentKeepRecentTokens: 20_000,
      }),
    ).toBe(1);
  });
});
