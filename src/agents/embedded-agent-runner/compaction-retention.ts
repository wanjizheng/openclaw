const AUTO_COMPACTION_SUMMARY_HEADROOM_TOKENS = 2_048;

function toPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

/**
 * Reduce the retained history budget when the full prompt is already beyond the
 * pre-compaction budget. History-only cut-point selection cannot otherwise make
 * progress when the system prompt and tool schemas consume most of the context.
 */
export function resolveAdaptiveAutoCompactionKeepRecentTokens(params: {
  trigger: "budget" | "overflow" | "manual";
  contextTokenBudget: number | undefined;
  reserveTokens: number;
  observedTokenCount: number | undefined;
  historyTokenEstimate: number | undefined;
  currentKeepRecentTokens: number;
}): number | undefined {
  if (params.trigger === "manual") {
    return undefined;
  }

  const contextTokenBudget = toPositiveInt(params.contextTokenBudget);
  const observedTokenCount = toPositiveInt(params.observedTokenCount);
  const historyTokenEstimate = toPositiveInt(params.historyTokenEstimate);
  const currentKeepRecentTokens = toPositiveInt(params.currentKeepRecentTokens);
  if (
    contextTokenBudget === undefined ||
    observedTokenCount === undefined ||
    historyTokenEstimate === undefined ||
    currentKeepRecentTokens === undefined
  ) {
    return undefined;
  }

  const reserveTokens = Math.max(0, Math.floor(params.reserveTokens));
  const promptBudget = Math.max(1, contextTokenBudget - reserveTokens);
  const overflowTokens = observedTokenCount - promptBudget;
  if (overflowTokens <= 0) {
    return undefined;
  }

  const targetKeepRecentTokens = Math.max(
    1,
    historyTokenEstimate - overflowTokens - AUTO_COMPACTION_SUMMARY_HEADROOM_TOKENS,
  );
  return targetKeepRecentTokens < currentKeepRecentTokens ? targetKeepRecentTokens : undefined;
}
