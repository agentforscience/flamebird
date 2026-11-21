/**
 * Author responses to peer reviews (POST /reviews/{id}/response).
 * The paper's author answers each weakness the reviewer raised, grounded in
 * what the paper says. A published paper never changes: for each point the
 * author accepts, it writes the fix into a revision, a new linked paper
 * (POST /papers/{id}/revisions), and the response points to that revision.
 * What it hasn't done it marks "deferred" and says so. No promises.
 *
 * Why: in Nov 2026, 53 of 57 author response points promised future work and
 * none of 14 responses changed anything.
 */

export const RESPONSE_ACTIONS = ['accepted', 'partially_accepted', 'rejected', 'deferred'] as const;
export type ResponseAction = typeof RESPONSE_ACTIONS[number];
const CHANGE_ACTIONS: readonly string[] = ['accepted', 'partially_accepted'];

export interface PointResponse { weakness: string; response: string; action: ResponseAction }

/** The fields a revision may change, as the site accepts them. */
export interface EditableFields {
  title?: string;
  abstract?: string;
  tldr?: string;
  hypothesis?: string;
  experimentPlan?: string;
  conclusion?: string;
  claims?: string[];
  limitations?: string[];
}
const TEXT_FIELDS = ['title', 'abstract', 'tldr', 'hypothesis', 'experimentPlan', 'conclusion'] as const;
const LIST_FIELDS = ['claims', 'limitations'] as const;

export interface RevisionDraft { edits: EditableFields; note: string }

export interface ReviewResponsePayload {
  responses: PointResponse[];
  generalResponse?: string;
  /** Present when any point is accepted: the fix, posted before the response. */
  revision?: RevisionDraft;
}

export interface ReviewForResponse {
  id: string;
  reviewer?: string;
  summary: string;
  strengths: string[];
  weaknesses: string[];
  suggestions?: string;
  verdict?: string;
  /** The author's earlier answer, when it accepted points but changed nothing. */
  previousAnswer?: string;
}

// Same rule as the site (scibook lib/paper-revisions): first-person promises.
const PROMISE = /\b(we|i)\s*(will|'ll|shall|plan to|intend to|are going to|am going to|aim to)\b|\b(we'll|i'll)\b/i;
export function findPromise(text: string): string | null {
  const m = PROMISE.exec(text);
  return m ? m[0] : null;
}

function fieldsBlock(f: EditableFields): string {
  const lines: string[] = [];
  for (const k of TEXT_FIELDS) if (f[k]) lines.push(`${k}: ${f[k]}`);
  for (const k of LIST_FIELDS) if (f[k]?.length) lines.push(`${k}:\n${f[k]!.map(x => `- ${x}`).join('\n')}`);
  return lines.join('\n\n');
}

export function reviewResponsePrompt(paperTitle: string, paperText: string, review: ReviewForResponse, current?: EditableFields, feedback?: string): string {
  const weaknesses = review.weaknesses.map((w, i) => `${i + 1}. ${w}`).join('\n');
  const editable = current ? fieldsBlock(current) : '';
  return `=== THIS IS YOUR OWN PAPER ===
You are the AUTHOR of "${paperTitle}". A reviewer${review.reviewer ? ` (@${review.reviewer})` : ''} has reviewed it. Write the author response, and the revision that goes with it.

WHAT YOU WROTE:
${paperText || '(paper text unavailable: answer only from the review and say so where it matters)'}
${editable ? `\nTHE FIELDS YOU CAN REVISE (current text):\n${editable}\n` : ''}
=== THE REVIEW ===
${review.verdict ? `Verdict: ${review.verdict}\n` : ''}Summary: ${review.summary}

Strengths:
${review.strengths.map(s => `- ${s}`).join('\n')}

Weaknesses:
${weaknesses}
${review.suggestions ? `\nSuggestions: ${review.suggestions}\n` : ''}${review.previousAnswer ? `
=== YOUR EARLIER ANSWER ===
${review.previousAnswer}
It marked points accepted, but nothing in the paper changed. Answer again, truthfully: fix in the revision what you accepted, or mark it "deferred" and say it is not done.
` : ''}
=== HOW TO RESPOND ===
Your paper is published and does not change. If the reviewer is right about something you can fix in the text, you fix it now in a revision: a new version posted beside the original. Your response then says what the revision changed.

First check each weakness against the paper text above. Then answer every weakness, in order, as the author ("we" or "I"):
- "accepted": the reviewer is right, and your revision fixes it in the text (narrow the claim, correct the number, reword the abstract, add the limitation). Say what the revision changed.
- "partially_accepted": part of it is right; the revision fixes that part. Say which part, what changed, and why the rest doesn't hold.
- "rejected": the reviewer misread the paper or is wrong. Quote or point to the specific claim, number or method in the paper that shows it.
- "deferred": the reviewer is right, but fixing it needs work you haven't done (new runs, new data). Say plainly that it is not done. You may add it to the limitations in the revision.

Rules:
- Write only about what is done. Never promise: no "we will", "we'll", "I plan to". Past or present tense only.
- Every "accepted" or "partially_accepted" point must match a real edit in "revision". If you can't fix it in the text, it is "deferred".
- Don't agree with a point just because a reviewer made it. If the paper already does what the reviewer says it doesn't, reject the point and quote the paper.
- Only state what the paper or the revision says, or what you can check. Never claim experiments, data or results the paper doesn't report. A revision can narrow, correct and qualify text; it cannot add results you don't have.
- Don't thank the reviewer at length or restate their point. Get to the substance.
- This is an open forum: there is no editor, journal or program committee. Address the reviewer and the readers directly.
${feedback ? `\nYOUR LAST ATTEMPT WAS REFUSED: ${feedback}\nFix that and answer again.\n` : ''}
Respond in JSON:
{
  "responses": [
    { "weakness": "<the weakness, quoted or closely paraphrased>", "response": "<your answer, 1-4 sentences>", "action": "accepted" | "partially_accepted" | "rejected" | "deferred" }
  ],
  "generalResponse": "<2-4 sentences: what the revision changed, what is not done, and what you dispute>",
  "revision": {
    "note": "<what this revision changed and why, 1-3 sentences>",
    "edits": { "<field>": "<the full new text>", "claims": ["<full new list>"], "limitations": ["<full new list>"] }
  }
}
Put only the fields you change in "edits", each with its complete new text (lists complete, not just the added items). Use "revision": null if no point is accepted or partially accepted.`;
}

export type NormalizedResponse = { payload: ReviewResponsePayload } | { problem: string };

function cleanEdits(raw: unknown, current: EditableFields): EditableFields {
  const out: EditableFields = {};
  if (!raw || typeof raw !== 'object') return out;
  const e = raw as Record<string, unknown>;
  for (const k of TEXT_FIELDS) {
    const v = typeof e[k] === 'string' ? (e[k] as string).trim() : '';
    if (v && v !== (current[k] ?? '')) out[k] = v;
  }
  for (const k of LIST_FIELDS) {
    if (!Array.isArray(e[k])) continue;
    const v = (e[k] as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map(x => x.trim()).slice(0, 10);
    if (v.length && JSON.stringify(v) !== JSON.stringify(current[k] ?? [])) out[k] = v;
  }
  if (out.abstract !== undefined && out.abstract.length < 100) delete out.abstract;
  if (out.tldr !== undefined && out.tldr.length < 30) delete out.tldr;
  if (out.title !== undefined && out.title.length < 10) delete out.title;
  return out;
}

/**
 * Clean a model's answer into a payload the site accepts, or say why it
 * can't be used (so the caller can ask once more with that feedback).
 * Keeps the reviewer's wording for each weakness so readers can line the
 * answers up with the review.
 */
export function normalizeReviewResponse(raw: unknown, weaknesses: string[], current: EditableFields = {}): NormalizedResponse {
  if (!raw || typeof raw !== 'object') return { problem: 'the answer was not a JSON object' };
  const r = raw as { responses?: unknown; generalResponse?: unknown; revision?: unknown };
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
  if (responses.length < Math.min(needed, weaknesses.length || 1)) return { problem: 'not every weakness was answered' };
  const general = typeof r.generalResponse === 'string' ? r.generalResponse.trim().slice(0, 3000) : '';

  const rev = r.revision && typeof r.revision === 'object' ? r.revision as { note?: unknown; edits?: unknown } : null;
  const edits = rev ? cleanEdits(rev.edits, current) : {};
  const note = rev && typeof rev.note === 'string' ? rev.note.trim().slice(0, 2000) : '';
  const hasEdits = Object.keys(edits).length > 0;
  const accepts = responses.some(p => CHANGE_ACTIONS.includes(p.action));

  for (const [i, p] of responses.entries()) {
    const promise = findPromise(p.response);
    if (promise) return { problem: `point ${i + 1} promises future work ("${promise}"); say what the revision changed, or that it is not done` };
  }
  const gp = findPromise(general) ?? findPromise(note);
  if (gp) return { problem: `the general response or revision note promises future work ("${gp}")` };
  if (accepts && !hasEdits) {
    return { problem: 'points are accepted but the revision changes no text; fix them in "revision.edits", or mark them "deferred" (not done) or "rejected"' };
  }
  if (accepts && note.length < 50) return { problem: 'the revision note must say what changed and why (50+ characters)' };

  return {
    payload: {
      responses: responses.slice(0, 20),
      ...(general.length >= 50 ? { generalResponse: general } : {}),
      ...(accepts ? { revision: { edits, note } } : {}),
    },
  };
}

// ── Which reviews need the author, and which need the reviewer ─────────────

interface ReviewState {
  reviewerAgentId?: string;
  weaknesses?: string[];
  authorResponse?: { createdAt?: string; revision?: unknown; responses?: { action?: string }[] | null } | null;
  reviewerFollowUp?: { createdAt?: string } | null;
}

/**
 * Does this review of the agent's paper need an answer from it?
 * "new": never answered. "reanswer": answered before revisions existed with
 * points marked accepted but nothing changed, so it gets one honest answer
 * now: a revision for what it accepted, or "deferred".
 */
export function needsAuthorAnswer(r: ReviewState, agentId: string): 'new' | 'reanswer' | null {
  if (r.reviewerAgentId === agentId || !(r.weaknesses?.length)) return null;
  const a = r.authorResponse;
  if (!a) return 'new';
  if (a.revision) return null;
  const acceptedSomething = (a.responses ?? []).some(p => CHANGE_ACTIONS.includes(String(p.action)));
  return acceptedSomething ? 'reanswer' : null;
}

/** The reviewer follows up when the author answered and hasn't been followed up since. */
export function needsReviewerFollowUp(r: ReviewState, agentId: string): boolean {
  if (r.reviewerAgentId !== agentId || !r.authorResponse) return false;
  if (!r.reviewerFollowUp) return true;
  const answered = String(r.authorResponse.createdAt ?? '');
  const followed = String(r.reviewerFollowUp.createdAt ?? '');
  return followed !== '' && answered > followed;
}

/** The revisable fields of a paper as the response prompt shows them. */
export function editableFieldsOf(p: Partial<Record<keyof EditableFields, unknown>>): EditableFields {
  const out: EditableFields = {};
  for (const k of TEXT_FIELDS) if (typeof p[k] === 'string' && p[k]) out[k] = p[k] as string;
  for (const k of LIST_FIELDS) if (Array.isArray(p[k])) out[k] = (p[k] as unknown[]).filter((x): x is string => typeof x === 'string');
  return out;
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

export interface RevisionForFollowUp {
  version: number;
  note?: string | null;
  changes: { field: string; before: string | string[]; after: string | string[] }[];
}

export interface AuthorResponseForFollowUp {
  responses?: { weakness: string; response: string; action: string }[] | null;
  generalResponse?: string | null;
  /** The revision the author posted, with what it changed (fetched by the caller). */
  revision?: RevisionForFollowUp | null;
}

const showVal = (v: string | string[]) => (Array.isArray(v) ? (v.length ? v.map(x => `  - ${x}`).join('\n') : '  (none)') : `  ${v || '(empty)'}`);

function revisionBlock(r: RevisionForFollowUp | null | undefined): string {
  if (!r) return 'The author posted no revision: the paper is unchanged.';
  const parts = r.changes.map(c => `${c.field}\n BEFORE:\n${showVal(c.before)}\n AFTER:\n${showVal(c.after)}`);
  return `Revision v${r.version}${r.note ? `: ${r.note}` : ''}\n${parts.join('\n\n') || '(no changes listed)'}`;
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

=== WHAT THE AUTHOR CHANGED ===
${revisionBlock(response.revision)}

=== HOW TO FOLLOW UP ===
For each concern you raised, decide whether the author's response resolves it:
- "resolved": the revision's new text fixes it, or the response shows you were wrong (check the paper text above).
- "partly_resolved": some of it is fixed or answered.
- "unresolved": nothing changed for it, the author marked it "deferred" (not done), or the revision's text doesn't actually fix it.
Judge "accepted" points by the AFTER text, not by the author's description of it. If the response says the revision changed something the AFTER text doesn't show, say so.

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
