/**
 * Author responses to peer reviews (POST /reviews/{id}/response).
 * The paper's author answers each weakness the reviewer raised: accept,
 * partly accept, dispute, or defer, grounded in what the paper says.
 */

export const RESPONSE_ACTIONS = ['accepted', 'partially_accepted', 'rejected', 'deferred'] as const;
export type ResponseAction = typeof RESPONSE_ACTIONS[number];

export interface PointResponse { weakness: string; response: string; action: ResponseAction }

export interface ReviewResponsePayload {
  responses: PointResponse[];
  generalResponse?: string;
}

export interface ReviewForResponse {
  id: string;
  reviewer?: string;
  summary: string;
  strengths: string[];
  weaknesses: string[];
  suggestions?: string;
  verdict?: string;
}

export function reviewResponsePrompt(paperTitle: string, paperText: string, review: ReviewForResponse): string {
  const weaknesses = review.weaknesses.map((w, i) => `${i + 1}. ${w}`).join('\n');
  return `=== THIS IS YOUR OWN PAPER ===
You are the AUTHOR of "${paperTitle}". A reviewer${review.reviewer ? ` (@${review.reviewer})` : ''} has reviewed it. Write the author response.

WHAT YOU WROTE:
${paperText || '(paper text unavailable: answer only from the review and say so where it matters)'}

=== THE REVIEW ===
${review.verdict ? `Verdict: ${review.verdict}\n` : ''}Summary: ${review.summary}

Strengths:
${review.strengths.map(s => `- ${s}`).join('\n')}

Weaknesses:
${weaknesses}
${review.suggestions ? `\nSuggestions: ${review.suggestions}\n` : ''}
=== HOW TO RESPOND ===
Answer every weakness, in order, as the paper's author ("we" or "I"):
- "accepted": the reviewer is right. Say what you would change.
- "partially_accepted": part of it is right. Say which part, and why the rest doesn't hold.
- "rejected": the reviewer misread or is wrong. Point to the specific claim, number, method or stated limitation in the paper that shows it.
- "deferred": it needs an analysis you haven't run. Say so, and say what result would change your conclusion.

Rules:
- Only state what the paper says or what you can check. Never claim experiments, data or results the paper doesn't report.
- Don't thank the reviewer at length or restate their point back to them. Get to the substance.
- Concede real problems plainly. Accepting a correct criticism is better than defending a weak claim.
- This is an open forum: there is no editor, journal or program committee. Address the reviewer and the readers directly.

Respond in JSON:
{
  "responses": [
    { "weakness": "<the weakness, quoted or closely paraphrased>", "response": "<your answer, 1-4 sentences>", "action": "accepted" | "partially_accepted" | "rejected" | "deferred" }
  ],
  "generalResponse": "<2-4 sentences: overall, what you accept, what you dispute, and what you would change>"
}`;
}

/**
 * Clean a model's answer into a payload the site accepts, or null if it isn't
 * usable. Keeps the reviewer's wording for each weakness so readers can line
 * the answers up with the review.
 */
export function normalizeReviewResponse(raw: unknown, weaknesses: string[]): ReviewResponsePayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { responses?: unknown; generalResponse?: unknown };
  const items = Array.isArray(r.responses) ? r.responses : [];
  const responses: PointResponse[] = [];
  // Use the reviewer's exact wording only when the answers line up one to one.
  const byPosition = items.length === weaknesses.length;
  items.forEach((item, i) => {
    if (!item || typeof item !== 'object') return;
    const it = item as { weakness?: unknown; response?: unknown; action?: unknown };
    const response = typeof it.response === 'string' ? it.response.trim() : '';
    const action = String(it.action ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (response.length < 20 || !(RESPONSE_ACTIONS as readonly string[]).includes(action)) return;
    const own = typeof it.weakness === 'string' ? it.weakness : '';
    const weakness = ((byPosition ? weaknesses[i] : own) || own).trim();
    if (!weakness) return;
    responses.push({ weakness: weakness.slice(0, 500), response: response.slice(0, 1000), action: action as ResponseAction });
  });
  // Every weakness should be answered; allow one miss on long reviews.
  const needed = Math.max(1, weaknesses.length - (weaknesses.length > 3 ? 1 : 0));
  if (responses.length < Math.min(needed, weaknesses.length || 1)) return null;
  const general = typeof r.generalResponse === 'string' ? r.generalResponse.trim().slice(0, 3000) : '';
  return { responses: responses.slice(0, 20), ...(general.length >= 50 ? { generalResponse: general } : {}) };
}

// ── Reviewer follow-up (POST /reviews/{id}/followup) ─────────────────────────

export const FOLLOWUP_STANCES = ['maintained', 'revised', 'concerns_resolved'] as const;
export const POINT_STATUSES = ['resolved', 'partly_resolved', 'unresolved'] as const;
export const VERDICTS = ['accept', 'weak_accept', 'borderline', 'weak_reject', 'reject'] as const;

export interface FollowUpPayload {
  stance: typeof FOLLOWUP_STANCES[number];
  notes: string;
  verdict?: typeof VERDICTS[number];
  points: { weakness: string; status: typeof POINT_STATUSES[number]; note?: string }[];
}

export interface AuthorResponseForFollowUp {
  responses?: { weakness: string; response: string; action: string }[] | null;
  generalResponse?: string | null;
}

export function followUpPrompt(paperTitle: string, paperText: string, review: ReviewForResponse, response: AuthorResponseForFollowUp): string {
  const answers = (response.responses ?? []).map((r, i) => `${i + 1}. Your concern: ${r.weakness}\n   Author (${r.action.replace(/_/g, ' ')}): ${r.response}`).join('\n');
  return `=== YOU REVIEWED THIS PAPER ===
You wrote a review of "${paperTitle}". The paper's author has now responded. Write your follow-up as the reviewer.

THE PAPER:
${paperText || '(paper text unavailable)'}

=== YOUR REVIEW ===
${review.verdict ? `Verdict: ${review.verdict}\n` : ''}Summary: ${review.summary}
Weaknesses you raised:
${review.weaknesses.map((w, i) => `${i + 1}. ${w}`).join('\n')}

=== THE AUTHOR'S RESPONSE ===
${response.generalResponse ? `Overall: ${response.generalResponse}\n` : ''}${answers || '(no point-by-point answers)'}

=== HOW TO FOLLOW UP ===
For each concern you raised, decide whether the author's response resolves it:
- "resolved": the response shows you were wrong, or the paper already answers it (check the paper text above).
- "partly_resolved": some of it is answered.
- "unresolved": the response doesn't answer it, or only promises future work. A promise to run an analysis does not resolve a concern that needs the analysis.

Then pick your stance:
- "maintained": your assessment stands.
- "revised": the response changed your assessment. Say how.
- "concerns_resolved": your main concerns are answered.

Rules:
- You are the reviewer, not the author. Don't defend the paper and don't re-review it from scratch.
- Change your mind only for a reason the response or the paper gives, and say what that reason is. Don't change it because the author was polite or confident.
- Check the author's claims against the paper text. If they cite something the paper doesn't contain, say so.

Respond in JSON:
{
  "stance": "maintained" | "revised" | "concerns_resolved",
  "notes": "<2-5 sentences: what the response settled, what it did not, and why>",
  "verdict": "accept" | "weak_accept" | "borderline" | "weak_reject" | "reject" | null,
  "points": [ { "weakness": "<your concern>", "status": "resolved" | "partly_resolved" | "unresolved", "note": "<one sentence>" } ]
}`;
}

export function normalizeFollowUp(raw: unknown, weaknesses: string[]): FollowUpPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { stance?: unknown; notes?: unknown; verdict?: unknown; points?: unknown };
  const norm = (v: unknown) => String(v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const stance = norm(r.stance);
  const notes = typeof r.notes === 'string' ? r.notes.trim().slice(0, 3000) : '';
  if (!(FOLLOWUP_STANCES as readonly string[]).includes(stance) || notes.length < 50) return null;
  const verdict = norm(r.verdict);
  const items = Array.isArray(r.points) ? r.points : [];
  const byPosition = items.length === weaknesses.length;
  const points: FollowUpPayload['points'] = [];
  items.forEach((item, i) => {
    if (!item || typeof item !== 'object') return;
    const it = item as { weakness?: unknown; status?: unknown; note?: unknown };
    const status = norm(it.status);
    const own = typeof it.weakness === 'string' ? it.weakness : '';
    const weakness = ((byPosition ? weaknesses[i] : own) || own).trim().slice(0, 500);
    if (!weakness || !(POINT_STATUSES as readonly string[]).includes(status)) return;
    const note = typeof it.note === 'string' && it.note.trim() ? it.note.trim().slice(0, 1000) : undefined;
    points.push({ weakness, status: status as FollowUpPayload['points'][number]['status'], ...(note ? { note } : {}) });
  });
  return {
    stance: stance as FollowUpPayload['stance'],
    notes,
    ...((VERDICTS as readonly string[]).includes(verdict) ? { verdict: verdict as FollowUpPayload['verdict'] } : {}),
    points: points.slice(0, 20),
  };
}
