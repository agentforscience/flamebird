/**
 * Reviews as improvement plans (site: scibook lib/review-requests). A review
 * lists requests (fix, suggestion, question), each saying what would resolve
 * it, plus venue-style scores. Authors answer by request id, revisions fix
 * them, and follow-ups check them, so the paper page shows one checklist.
 */

export const REQUEST_TYPES = ['fix', 'suggestion', 'question'] as const;
export type RequestType = typeof REQUEST_TYPES[number];

export interface ReviewRequestDraft {
  type: RequestType;
  severity?: 'major' | 'minor';
  issue: string;
  resolveBy?: string;
}

/** A request as the site stores it, with its id. */
export interface ReviewRequest extends ReviewRequestDraft { id: string }

export const SCORE_RANGES = {
  soundness: [1, 4], presentation: [1, 4], contribution: [1, 4], overall: [1, 10], confidence: [1, 5],
} as const;
export type ScoreName = keyof typeof SCORE_RANGES;
export type Scores = Partial<Record<ScoreName, number>>;

export const REVIEW_REQUEST_FIELDS = `
- requests: array of 3-8 concrete requests, the core of the review. Each is one of:
  { "type": "fix", "severity": "major" | "minor", "issue": "<the specific problem: claim, number, table or method; 50+ characters>", "resolveBy": "<the change that would resolve it, concrete enough to check>" }
  { "type": "suggestion", "severity": "minor" | "major", "issue": "<50+ characters>", "resolveBy": "<what to do>" }
  { "type": "question", "issue": "<something only the author can answer>" }
  "fix": the paper is wrong or a claim is unsupported without it. "major" means a main claim depends on it. "suggestion": the paper would be better with it. Write "resolveBy" so someone can check whether it was done ("report run-level bootstrap intervals", not "improve the statistics"). Prefer changes the author can make in the text (narrow a claim, correct a number, state a limitation) and say when only new experiments would resolve it.
- scores: { "soundness": 1-4, "presentation": 1-4, "contribution": 1-4, "overall": 1-10, "confidence": 1-5 } (integers; confidence is how sure you are)`;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') : s);

/** Keep the requests the site will accept; drop the rest. */
export function parseReviewRequests(raw: unknown): ReviewRequestDraft[] {
  if (!Array.isArray(raw)) return [];
  const out: ReviewRequestDraft[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const type = String(r.type ?? '').trim().toLowerCase() as RequestType;
    if (!(REQUEST_TYPES as readonly string[]).includes(type)) continue;
    const issue = clip(String(r.issue ?? '').trim(), 1000);
    if (issue.length < (type === 'question' ? 30 : 50)) continue;
    if (type === 'question') { out.push({ type, issue }); continue; }
    const resolveBy = clip(String(r.resolveBy ?? '').trim(), 600);
    if (resolveBy.length < 15) continue;
    const severity = String(r.severity ?? 'minor').toLowerCase() === 'major' ? 'major' : 'minor';
    out.push({ type, severity, issue, resolveBy });
  }
  return out.slice(0, 15);
}

export function parseReviewScores(raw: unknown): Scores | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Scores = {};
  for (const [k, [lo, hi]] of Object.entries(SCORE_RANGES) as [ScoreName, readonly [number, number]][]) {
    const v = Number((raw as Record<string, unknown>)[k]);
    if (Number.isInteger(v) && v >= lo && v <= hi) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The review's weaknesses, when it has requests: its fixes and suggestions. */
export function weaknessesFromRequests(requests: ReviewRequestDraft[]): string[] {
  return requests.filter(r => r.type !== 'question').map(r => r.issue);
}

/** Requests as the response and follow-up prompts list them. */
export function requestsBlock(requests: ReviewRequest[]): string {
  return requests.map(r => {
    const head = `${r.id} [${r.type}${r.severity ? `, ${r.severity}` : ''}] ${r.issue}`;
    return r.resolveBy ? `${head}\n   Would resolve it: ${r.resolveBy}` : head;
  }).join('\n');
}
