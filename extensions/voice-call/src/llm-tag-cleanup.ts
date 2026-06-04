const THINK_OPEN_RE = /<\s*(?:think(?:ing)?|thought|antthinking)\b[^<>]*>/gi;
const THINK_CLOSE_RE = /<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\b[^<>]*>/gi;
const FINAL_TAG_RE = /<\s*\/?\s*final\b[^<>]*>/gi;

// Handles malformed starts that may appear in partial streams, e.g.:
//   <think<final你好
//   </</final>
//   </final (without ">")
const MALFORMED_INLINE_PREFIX_RE =
  /<\s*\/?\s*(?:think(?:ing)?|thought|antthinking|final)\b(?=[^>\s])/gi;
const MALFORMED_DOUBLE_CLOSE_RE =
  /<\s*\/\s*<\s*\/?\s*(?:think(?:ing)?|thought|antthinking|final)\b[^<>]*>?/gi;
const TRAILING_PARTIAL_TAG_RE = /<\s*\/?\s*(?:think(?:ing)?|thought|antthinking|final)\b\s*$/gi;

function stripReasoningSegments(text: string): string {
  let output = "";
  let cursor = 0;
  let depth = 0;

  const tokenRe = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\b[^<>]*>/gi;
  for (const match of text.matchAll(tokenRe)) {
    const start = match.index ?? 0;
    const token = match[0];
    const isClose = match[1] === "/";

    if (depth === 0) {
      output += text.slice(cursor, start);
    }

    if (isClose) {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        cursor = start + token.length;
      }
      continue;
    }

    depth += 1;
    if (depth === 1) {
      cursor = start + token.length;
    }
  }

  if (depth === 0) {
    output += text.slice(cursor);
  }

  return output;
}

export function stripLlmReasoningTags(text: string, options?: { isFinal?: boolean }): string {
  if (!text || !text.includes("<")) {
    return text;
  }

  let cleaned = text;

  // Remove well-formed <final> tags but keep their content.
  cleaned = cleaned.replace(FINAL_TAG_RE, "");

  // Remove well-formed <think>/<thinking>/<thought>/<antthinking> blocks.
  cleaned = stripReasoningSegments(cleaned);

  // Remove any remaining standalone thinking tags.
  cleaned = cleaned.replace(THINK_OPEN_RE, "").replace(THINK_CLOSE_RE, "");

  // Remove malformed fragments that often leak in streamed output.
  cleaned = cleaned.replace(MALFORMED_DOUBLE_CLOSE_RE, "");
  cleaned = cleaned.replace(MALFORMED_INLINE_PREFIX_RE, "");
  if (options?.isFinal) {
    cleaned = cleaned.replace(TRAILING_PARTIAL_TAG_RE, "");
  }

  return cleaned;
}
