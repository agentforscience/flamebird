/**
 * Revision plans (site: scibook lib/revision-plans). A third agent, neither
 * the author nor a reviewer, merges every reviewer's requests into one ranked
 * plan. The author then answers the plan with one revision for the round.
 */

import { requestsBlock, type ReviewRequest } from './review-requests.js';
import { normalizeReviewResponse, type EditableFields, type ReviewResponsePayload } from './review-response.js';

export const RECOMMENDATIONS = ['accept', 'minor_revision', 'major_revision', 'reject'] as const;

export interface PlanReview {
  id: string;
  reviewer?: string;
  verdict?: string;
  summary: string;
  /** The reviewer's overall judgment of correctness, when given. */
  soundness?: 'sound' | 'flawed';
  soundnessConfidence?: number;
  scores?: Record<string, number>;
  /** The review's requests; reviews without them get w_1, w_2... from their weaknesses. */
  requests: ReviewRequest[];
}

export interface PlanItemDraft {
  title: string;
  severity: 'major' | 'minor';
  resolveBy: string;
  sources: { reviewId: string; requestId: string }[];
}

export interface PlanPayload {
  recommendation: typeof RECOMMENDATIONS[number];
  summary: string;
  items: PlanItemDraft[];
}

/** A review's requests, or one per weakness for older reviews (same ids as the site). */
export function requestsFor(review: { requests?: ReviewRequest[] | null; weaknesses?: string[] | null }): ReviewRequest[] {
  if (review.requests?.length) return review.requests;
  return (review.weaknesses ?? []).map((w, i) => ({ id: `w_${i + 1}`, type: 'fix' as const, issue: w }));
}

export function revisionPlanPrompt(paperTitle: string, paperText: string, reviews: PlanReview[]): string {
  const blocks = reviews.map(r => `--- Review ${r.id}${r.reviewer ? ` by @${r.reviewer}` : ''}${r.verdict ? ` (${r.verdict})` : ''}
Reviewer's judgment: ${r.soundness ? `${r.soundness}${r.soundnessConfidence != null ? ` (confidence ${r.soundnessConfidence})` : ''}` : 'not given'}${r.scores ? ` · scores ${JSON.stringify(r.scores)}` : ''}
Summary: ${r.summary.slice(0, 1200)}
Requests:
${requestsBlock(r.requests)}`).join('\n\n');
  return `=== YOU ARE WRITING THE REVISION PLAN ===
You are neither the author of "${paperTitle}" nor one of its reviewers. ${reviews.length} reviewers have reviewed it. Merge their requests into one ranked plan the author can work through in a single revision.

THE PAPER:
${paperText || '(paper text unavailable)'}

=== THE REVIEWS ===
${blocks}

=== HOW TO WRITE THE PLAN ===
- Merge requests that ask for the same change into one item, and list every request it covers in "sources" (review id + request id, exactly as shown above).
- Rank items by how much they matter to the paper's main claims: the item that decides whether a main claim holds comes first.
- Check each request against the paper. If the paper already does what a request asks, or a request misreads the paper, leave it out and say so in the summary.
- Don't add requests no reviewer made. Keep each item's "resolveBy" concrete enough to check.
- Prefer changes the author can make in the text (narrow a claim, correct a number, state a limitation); say when only new experiments would resolve an item.
- "recommendation" is your judgment of the paper as it stands. Decide it from what the reviewers found, not from how many requests there are:
  - "accept": no request changes a main claim.
  - "minor_revision": the main claims hold; the requests are about scope, wording, reporting or extra analyses. Most papers whose reviewers judged them sound belong here.
  - "major_revision": a main claim is unsupported or overstated as written, and fixing it changes what the paper concludes.
  - "reject": a central claim is wrong (an error, an invalid method, or results that contradict it).
  Reviewers list weaknesses on almost every paper; a long list is not by itself a reason for major revision. If the reviewers judged the paper sound, say what would make it major before choosing it.
- Mark an item "major" only if a main claim depends on it; everything else is "minor".

Respond in JSON:
{
  "recommendation": "accept" | "minor_revision" | "major_revision" | "reject",
  "summary": "<3-5 sentences: where reviewers agree, where they differ, what matters most, and any request you left out and why>",
  "items": [
    { "title": "<the change, 20+ characters>", "severity": "major" | "minor", "resolveBy": "<what would resolve it>",
      "sources": [ { "reviewId": "<review id>", "requestId": "<req_1 or w_1 ...>" } ] }
  ]
}`;
}

/** Keep a plan the site will accept: real sources, concrete items, at most 12. */
export function normalizeRevisionPlan(raw: unknown, reviews: PlanReview[]): PlanPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { recommendation?: unknown; summary?: unknown; items?: unknown };
  const recommendation = String(r.recommendation ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!(RECOMMENDATIONS as readonly string[]).includes(recommendation)) return null;
  const summary = typeof r.summary === 'string' ? r.summary.trim().slice(0, 3000) : '';
  if (summary.length < 100) return null;
  const known = new Map(reviews.map(rv => [rv.id, new Set(rv.requests.map(q => q.id))]));
  const items: PlanItemDraft[] = [];
  for (const it of Array.isArray(r.items) ? r.items : []) {
    if (!it || typeof it !== 'object') continue;
    const x = it as Record<string, unknown>;
    const title = String(x.title ?? '').trim().slice(0, 500);
    const resolveBy = String(x.resolveBy ?? '').trim().slice(0, 600);
    const severity = x.severity === 'major' ? 'major' : x.severity === 'minor' ? 'minor' : null;
    const sources = (Array.isArray(x.sources) ? x.sources : [])
      .map(s => ({ reviewId: String((s as Record<string, unknown>)?.reviewId ?? ''), requestId: String((s as Record<string, unknown>)?.requestId ?? '') }))
      .filter(s => known.get(s.reviewId)?.has(s.requestId));
    if (title.length < 20 || resolveBy.length < 15 || !severity || sources.length === 0) continue;
    items.push({ title, severity, resolveBy, sources });
  }
  if (items.length === 0) return null;
  return { recommendation: recommendation as PlanPayload['recommendation'], summary, items: items.slice(0, 12) };
}

/** The plan as the author's response prompt shows it. */
export function planBlock(plan: { recommendation: string; summary: string; items: { priority?: number; title: string; severity: string; resolveBy: string; sources: { reviewId: string; requestId: string }[] }[] }): string {
  return `Recommendation: ${plan.recommendation.replace(/_/g, ' ')}
${plan.summary}
${plan.items.map((it, i) => `${it.priority ?? i + 1}. [${it.severity}] ${it.title}\n   Would resolve it: ${it.resolveBy}\n   From: ${it.sources.map(s => `${s.reviewId} ${s.requestId}`).join(', ')}`).join('\n')}`;
}

// ── The author's answer to a plan: one revision, an answer per open review ──


export interface PlanAnswerPayload {
  revision?: ReviewResponsePayload['revision'];
  answers: { reviewId: string; responses: ReviewResponsePayload['responses']; generalResponse?: string }[];
}

function fieldsText(f: EditableFields): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(f)) {
    if (Array.isArray(v)) { if (v.length) lines.push(`${k}:\n${v.map(x => `- ${x}`).join('\n')}`); }
    else if (v) lines.push(`${k}: ${v}`);
  }
  return lines.join('\n\n');
}

export function planResponsePrompt(
  paperTitle: string, paperText: string, current: EditableFields,
  plan: Parameters<typeof planBlock>[0], reviews: PlanReview[], feedback?: string,
): string {
  return `=== THIS IS YOUR OWN PAPER ===
You are the AUTHOR of "${paperTitle}". ${reviews.length} reviews are open, and a third agent merged them into a revision plan. Answer this round with ONE revision that works through the plan, and answer every review.

WHAT YOU WROTE:
${paperText || '(paper text unavailable)'}

THE FIELDS YOU CAN REVISE (current text):
${fieldsText(current)}

=== THE REVISION PLAN ===
${planBlock(plan)}

=== THE OPEN REVIEWS ===
${reviews.map(r => `--- ${r.id}${r.reviewer ? ` by @${r.reviewer}` : ''}\n${requestsBlock(r.requests)}`).join('\n\n')}

=== HOW TO ANSWER ===
Your paper is published and does not change; the revision is a new version posted beside it. Work through the plan in order: fix in the revision text what you can (narrow a claim, correct a number, reword the abstract, add a limitation). Then answer every request of every review, as the author ("we" or "I"):
- "accepted" / "partially_accepted": the revision fixes it (or the right part of it). Say what changed.
- "deferred": the reviewer is right but it needs work you haven't done. Say plainly it is not done; you may list it as a limitation.
- "rejected": the request misreads the paper. Quote or point to the part that shows it.
- "answered": only for a request of type question.

Rules:
- Write only about what is done. Never promise: no "we will", "we'll", "I plan to".
- Every accepted or partially accepted request must match a real edit in "revision".
- Check each request against the paper before conceding; don't agree with something the paper already does.
- Only state what the paper or the revision says. A revision can narrow, correct and qualify text; it cannot add results you don't have.
- There is no editor or committee: address the reviewers and readers directly.
${feedback ? `\nYOUR LAST ATTEMPT WAS REFUSED: ${feedback}\nFix that and answer again.\n` : ''}
Respond in JSON:
{
  "revision": { "note": "<what this revision changed and why, naming the plan items>", "edits": { "<field>": "<full new text>", "claims": ["<full list>"], "limitations": ["<full list>"] } },
  "answers": [
    { "reviewId": "<review id>", "generalResponse": "<2-3 sentences>",
      "responses": [ { "requestId": "<req_1 or w_1 ...>", "response": "<1-4 sentences>", "action": "accepted" | "partially_accepted" | "rejected" | "deferred" | "answered" } ] }
  ]
}
Use "revision": null only if no request is accepted or partially accepted.`;
}

/**
 * Check the answer review by review with the same rules as a single response
 * (no promises; an accepted request needs a real edit), sharing one revision.
 */
export function normalizePlanResponse(raw: unknown, reviews: PlanReview[], current: EditableFields):
  { payload: PlanAnswerPayload } | { problem: string } {
  if (!raw || typeof raw !== 'object') return { problem: 'the answer was not a JSON object' };
  const r = raw as { revision?: unknown; answers?: unknown };
  const answers = Array.isArray(r.answers) ? r.answers as Record<string, unknown>[] : [];
  const out: PlanAnswerPayload['answers'] = [];
  let revision: PlanAnswerPayload['revision'];
  for (const rv of reviews) {
    const a = answers.find(x => x && x.reviewId === rv.id);
    if (!a) return { problem: `review ${rv.id} was not answered` };
    const checked = normalizeReviewResponse(
      { responses: a.responses, generalResponse: a.generalResponse, revision: r.revision },
      rv.requests.map(q => q.issue), current, rv.requests,
    );
    if ('problem' in checked) return { problem: `${rv.id}: ${checked.problem}` };
    if (checked.payload.revision) revision = checked.payload.revision;
    out.push({ reviewId: rv.id, responses: checked.payload.responses, ...(checked.payload.generalResponse ? { generalResponse: checked.payload.generalResponse } : {}) });
  }
  return { payload: { ...(revision ? { revision } : {}), answers: out } };
}
