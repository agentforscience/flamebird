/**
 * Smart truncation utilities
 * Truncates text at sentence or word boundaries instead of chopping mid-word.
 */

/**
 * Truncate text at the last sentence boundary within maxLen.
 * Falls back to word boundary, then hard cut as last resort.
 */
export function smartTruncate(text: string | undefined | null, maxLen: number): string {
  if (!text) return '';
  if (text.length <= maxLen) return text;

  const chunk = text.slice(0, maxLen);

  // Try to cut at the last sentence-ending punctuation (.!?) followed by a space or end
  const sentenceEnd = chunk.match(/^([\s\S]*[.!?])(\s|$)/);
  if (sentenceEnd && sentenceEnd[1].length >= maxLen * 0.5) {
    return sentenceEnd[1].trimEnd();
  }

  // Fall back to last word boundary (space, newline, comma, semicolon)
  const lastBreak = chunk.lastIndexOf(' ');
  if (lastBreak > maxLen * 0.5) {
    return chunk.slice(0, lastBreak).trimEnd();
  }

  // Hard cut as absolute last resort
  return chunk;
}

/**
 * Try to repair truncated JSON from LLM output.
 * When the LLM hits token limits, JSON often gets cut mid-string or mid-object.
 * This attempts to close open strings, arrays, and objects to make it parseable.
 */
export function repairJSON(raw: string): string | null {
  // First try: maybe it's already valid
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    // needs repair
  }

  let repaired = raw.trimEnd();

  // Remove trailing commas (including before ] or })
  repaired = repaired.replace(/,\s*$/, '');
  repaired = repaired.replace(/,\s*([}\]])/g, '$1');

  // Close unclosed string (odd number of unescaped quotes)
  const unescapedQuotes = repaired.match(/(?<!\\)"/g);
  if (unescapedQuotes && unescapedQuotes.length % 2 !== 0) {
    repaired += '"';
  }

  // Count open brackets/braces and close them
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let prevChar = '';

  for (const ch of repaired) {
    if (ch === '"' && prevChar !== '\\') {
      inString = !inString;
    } else if (!inString) {
      if (ch === '{') openBraces++;
      else if (ch === '}') openBraces--;
      else if (ch === '[') openBrackets++;
      else if (ch === ']') openBrackets--;
    }
    prevChar = ch;
  }

  // Remove trailing comma before we close (might be inside last value)
  repaired = repaired.replace(/,\s*$/, '');

  for (let i = 0; i < openBrackets; i++) repaired += ']';
  for (let i = 0; i < openBraces; i++) repaired += '}';

  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    return null;
  }
}
