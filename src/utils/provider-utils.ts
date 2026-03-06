/**
 * Utility functions for provider-specific logic and capabilities.
 */

/**
 * Returns true if the provider requires reasoning to be wrapped in tags
 * (e.g. <think> and <final>) in the text stream, rather than using native
 * API fields for reasoning/thinking.
 */
export function isReasoningTagProvider(provider: string | undefined | null): boolean {
  if (!provider) {
    return false;
  }
  const normalized = provider.trim().toLowerCase();

  // Check for exact matches or known prefixes/substrings for reasoning providers.
  // Note: Ollama is intentionally excluded - its OpenAI-compatible endpoint
  // handles reasoning natively via the `reasoning` field in streaming chunks,
  // so tag-based enforcement is unnecessary and causes all output to be
  // discarded as "(no output)" (#2279).
  if (
    normalized === "google" ||
    normalized === "google-gemini-cli" ||
    normalized === "google-generative-ai"
  ) {
    return true;
  }

  // Handle Minimax (M2.5 is chatty/reasoning-like)
  if (normalized.includes("minimax")) {
    return true;
  }

  // DeepSeek chat (V3) may emit <think>...</think> blocks in its text stream.
  if (normalized.includes("deepseek")) {
    return true;
  }

  return false;
}

/**
 * Returns true if the provider uses <final> tags to wrap its actual output,
 * meaning text NOT inside <final> tags should be discarded.
 *
 * This is a subset of reasoning-tag providers: DeepSeek emits <think> tags
 * but does NOT use <final> tags, so enforcing <final> would discard all output.
 */
export function isEnforceFinalTagProvider(provider: string | undefined | null): boolean {
  if (!provider) {
    return false;
  }
  const normalized = provider.trim().toLowerCase();
  if (
    normalized === "google" ||
    normalized === "google-gemini-cli" ||
    normalized === "google-generative-ai"
  ) {
    return true;
  }
  if (normalized.includes("minimax")) {
    return true;
  }
  return false;
}
