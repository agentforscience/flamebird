/**
 * Content Quality Gate
 *
 * Last-mile check on LLM-generated text right before it's posted anywhere —
 * papers, comments, takes, reviews. Catches the class of failure where an
 * upstream LLM call errors out or refuses, but the error string itself gets
 * treated as real content and propagated through fallback templates (long
 * enough to pass a bare length check, with a real target to post to).
 */

const BROKEN_CONTENT_PATTERNS: RegExp[] = [
  /error generating (response|content|summary|report)/i,
  /please try again/i,
  /^i (cannot|can't|am unable to)/i,
  /^as an ai (language model|assistant|chatbot|model)/i,
  /^i apologize/i,
  /i don'?t have (enough|sufficient) (information|context|access)/i,
  /^\s*\{.*"error"/i,
  /Traceback \(most recent call last\)/,
  /\[object Object\]/,
  // Placeholder conclusions from failed/incomplete runs
  /^results demonstrate the validity of the proposed approach\.?$/i,
  /^this paper presents novel research findings\.?$/i,
  /^the results? (confirm|demonstrate|show|validate) (the|our) (approach|method|framework)\.?$/i,
  // Generic filler comments that add nothing to the discussion
  /^(excellent|great|solid|interesting|good) (work|paper|analysis|study|contribution)\.?$/i,
  /^this reminds me of earlier work on \w+\s*[—–-]\s*the \w+ framing adds a genuinely new perspective\.?$/i,
  /^the connection between \w+ and \w+ is underappreciated\.? this (work|paper) makes it clearer\.?$/i,
];

export interface QualityCheckResult {
  ok: boolean;
  reason?: string;
}

/** Assess a single piece of text. Empty/undefined and pattern matches both fail. */
export function assessTextQuality(text: string | undefined, minLength: number): QualityCheckResult {
  const trimmed = text?.trim() ?? '';
  if (trimmed.length < minLength) {
    return { ok: false, reason: `too short (${trimmed.length}/${minLength} chars)` };
  }
  const hit = BROKEN_CONTENT_PATTERNS.find(p => p.test(text!));
  if (hit) {
    return { ok: false, reason: `matched broken-content pattern: ${hit}` };
  }
  return { ok: true };
}

/**
 * Assess multiple named fields at once. Returns the first failure found, or
 * null if every field passes. `fields` maps a label (for the error message)
 * to `[text, minLength]`.
 */
export function assessFieldsQuality(
  fields: Record<string, [text: string | undefined, minLength: number]>,
): string | null {
  for (const [label, [text, minLength]] of Object.entries(fields)) {
    const result = assessTextQuality(text, minLength);
    if (!result.ok) {
      return `${label}: ${result.reason}`;
    }
  }
  return null;
}
