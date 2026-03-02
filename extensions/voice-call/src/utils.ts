import os from "node:os";
import path from "node:path";

/**
 * Strip think/reasoning blocks and final-wrapper tags from voice LLM output.
 *
 * Patterns handled:
 *   - <think>…</think>  / <thinking> / <thought> / <antthinking>  → content hidden
 *   - <final>…</final>                                             → tags stripped, content kept
 *
 * When isFinal=false (streaming), a partial tag at the very end of the buffer
 * (e.g. "<thin") is held back so it isn't emitted before we know if it becomes
 * "<think>".  When isFinal=true the holdback is skipped and all remaining text
 * is emitted.
 */
export function computeVoiceVisibleText(raw: string, isFinal = false): string {
  const THINK_OPEN_RE = /^<\s*(?:think(?:ing)?|thought|antthinking)\b[^>]*>/i;
  const FINAL_TAG_RE = /^<\s*\/?\s*final\b[^>]*>/i;
  const THINK_CLOSE_RE = /<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\b[^>]*>/i;
  // Does this string look like the start of a special tag?
  const SPECIAL_PREFIX_RE = /^<\s*(?:\/\s*)?(?:th|fi|an)/i;

  let result = "";
  let inThink = false;
  let i = 0;

  while (i < raw.length) {
    if (!inThink) {
      const lt = raw.indexOf("<", i);
      if (lt === -1) {
        result += raw.slice(i);
        break;
      }
      // Emit everything before the '<'
      result += raw.slice(i, lt);
      i = lt;

      const slice = raw.slice(i);

      // Streaming: if the remaining text looks like a partial special tag, hold it back
      if (!isFinal && !slice.includes(">") && (slice === "<" || SPECIAL_PREFIX_RE.test(slice))) {
        break;
      }

      // Check for think open tag
      const thinkOpen = slice.match(THINK_OPEN_RE);
      if (thinkOpen) {
        inThink = true;
        i += thinkOpen[0].length;
        continue;
      }

      // Check for <final> / </final> — strip just the tag, keep surrounding content
      const finalTag = slice.match(FINAL_TAG_RE);
      if (finalTag) {
        i += finalTag[0].length;
        continue;
      }

      // Ordinary '<' — emit it
      result += "<";
      i++;
    } else {
      // Inside a think block: skip everything until the closing tag
      const rest = raw.slice(i);
      const closeIdx = rest.search(THINK_CLOSE_RE);
      if (closeIdx === -1) {
        // No closing tag found yet — discard the rest (still inside think block)
        break;
      }
      const closeTagMatch = rest.slice(closeIdx).match(THINK_CLOSE_RE)!;
      i += closeIdx + closeTagMatch[0].length;
      inThink = false;
    }
  }

  return result;
}

export function resolveUserPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    const expanded = trimmed.replace(/^~(?=$|[\\/])/, os.homedir());
    return path.resolve(expanded);
  }
  return path.resolve(trimmed);
}
