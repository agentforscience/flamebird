import { describe, it, expect, beforeEach } from 'vitest';
import { findOwnWork, ownWorkBlock, rootTypeOf, resetOwnWorkCache, type OwnWorkClient } from '../src/utils/own-work.js';
import { normalizeReviewResponse, reviewResponsePrompt, needsAuthorAnswer, needsReviewerFollowUp } from '../src/utils/review-response.js';

const paper = { id: 'paper_1', agentId: 'me', title: 'Warmup and loss spikes', abstract: 'We show warmup removes spikes.', claims: ['Warmup removes 90% of spikes'], limitations: ['One model size'] };
const client: OwnWorkClient = {
  async getPaper(id) { return id === 'paper_1' ? { success: true, data: paper as never } : { success: false }; },
  async getTake(id) {
    if (id === 'take_mine') return { success: true, data: { id, agentId: 'me', title: 'My take', hotTake: 'Spikes are optimizer noise' } as never };
    if (id === 'take_other') return { success: true, data: { id, agentId: 'other', title: 'Their take', paperId: 'paper_1' } as never };
    return { success: false };
  },
  async getReview(id) {
    return id === 'review_1'
      ? { success: true, data: { review: { id, reviewerAgentId: 'rev', paperId: 'paper_1', summary: 's', strengths: [], weaknesses: ['No seeds'] } } }
      : { success: false };
  },
};

describe('own work', () => {
  beforeEach(() => resetOwnWorkCache());

  it('finds the root type from the hint or the id', () => {
    expect(rootTypeOf('paper_x')).toBe('paper');
    expect(rootTypeOf('xyz', 'takes')).toBe('take');
    expect(rootTypeOf('xyz')).toBeNull();
  });

  it("recognizes the agent's own paper and includes what it wrote", async () => {
    const own = await findOwnWork(client, 'me', 'paper_1');
    expect(own?.kind).toBe('paper');
    expect(own?.text).toContain('Warmup removes 90% of spikes');
    expect(await findOwnWork(client, 'someone_else', 'paper_1')).toBeNull();
  });

  it('recognizes takes and reviews about its own paper', async () => {
    expect((await findOwnWork(client, 'me', 'take_mine'))?.kind).toBe('take');
    expect((await findOwnWork(client, 'me', 'take_other'))?.kind).toBe('take_on_my_paper');
    const r = await findOwnWork(client, 'me', 'review_1');
    expect(r?.kind).toBe('review_of_my_paper');
    expect(r?.title).toBe('Warmup and loss spikes');
    expect(await findOwnWork(client, 'rev', 'review_1').then(x => x?.kind)).toBe('review');
  });

  it('returns null without an agent id or when the root cannot be loaded', async () => {
    expect(await findOwnWork(client, undefined, 'paper_1')).toBeNull();
    expect(await findOwnWork(client, 'me', 'paper_missing')).toBeNull();
  });

  it('tells the agent to write as the author and not invent', () => {
    const block = ownWorkBlock({ kind: 'paper', id: 'paper_1', title: 'T', text: 'Claims: x' });
    expect(block).toContain('YOUR OWN paper');
    expect(block).toContain('Never call yourself "the authors"');
    expect(block).toContain("Don't invent experiments");
    expect(block).toContain('Claims: x');
  });
});

describe('review response', () => {
  const weaknesses = ['No seeds reported', 'Only one model size'];
  const current = { abstract: 'A'.repeat(120), limitations: ['Small models'] };
  const payloadOf = (out: ReturnType<typeof normalizeReviewResponse>) => ('payload' in out ? out.payload : null);
  const problemOf = (out: ReturnType<typeof normalizeReviewResponse>) => ('problem' in out ? out.problem : null);

  it('keeps valid answers with the reviewer wording, and the revision for accepted points', () => {
    const out = payloadOf(normalizeReviewResponse({
      responses: [
        { weakness: 'seeds', response: 'Right: we ran one seed. Revision v2 says so in the abstract and limitations.', action: 'accepted' },
        { weakness: 'size', response: 'The limitations section already says this; the claim is scoped to 125M.', action: 'Rejected' },
      ],
      generalResponse: 'v2 states the single seed in the abstract and limitations; the size limit was already stated in the paper.',
      revision: { note: 'States that every result comes from a single seed, in the abstract and as a limitation.', edits: {
        abstract: 'B'.repeat(120), limitations: ['Small models', 'Single seed'], score: 5 } },
    }, weaknesses, current));
    expect(out?.responses.map(r => r.weakness)).toEqual(weaknesses);
    expect(out?.responses[1].action).toBe('rejected');
    expect(Object.keys(out?.revision?.edits ?? {}).sort()).toEqual(['abstract', 'limitations']);
  });

  it('refuses an accepted point without a real edit', () => {
    const answers = [
      { weakness: 'a', response: 'Right, the seed count is missing from the paper.', action: 'accepted' },
      { weakness: 'b', response: 'Not done: needs a second model size we have not trained.', action: 'deferred' },
    ];
    expect(problemOf(normalizeReviewResponse({ responses: answers }, weaknesses, current))).toMatch(/revision changes no text/);
    // An "edit" identical to the current text is no edit
    expect(problemOf(normalizeReviewResponse({ responses: answers, revision: { note: 'n'.repeat(60), edits: { limitations: ['Small models'] } } }, weaknesses, current))).toMatch(/revision changes no text/);
  });

  it('refuses promises anywhere', () => {
    expect(problemOf(normalizeReviewResponse({ responses: [
      { weakness: 'a', response: 'We will rerun with five seeds next month.', action: 'deferred' },
      { weakness: 'b', response: 'Not done: needs a second model size we have not trained.', action: 'deferred' },
    ] }, weaknesses, current))).toMatch(/promises future work/);
    expect(problemOf(normalizeReviewResponse({ responses: [
      { weakness: 'a', response: 'Not done: the paper reports a single seed only.', action: 'deferred' },
      { weakness: 'b', response: 'Not done: needs a second model size we have not trained.', action: 'deferred' },
    ], generalResponse: "Thanks for the review. We'll address both points in a later version." }, weaknesses, current))).toMatch(/promises future work/);
  });

  it('accepts honest "not done" answers without a revision', () => {
    const out = payloadOf(normalizeReviewResponse({ responses: [
      { weakness: 'a', response: 'Not done: the paper reports a single seed only.', action: 'deferred' },
      { weakness: 'b', response: 'Not done: needs a second model size we have not trained.', action: 'deferred' },
    ], revision: null }, weaknesses, current));
    expect(out?.revision).toBeUndefined();
  });

  it('rejects unusable answers', () => {
    expect(problemOf(normalizeReviewResponse(null, weaknesses))).toBeTruthy();
    expect(problemOf(normalizeReviewResponse({ responses: [{ weakness: 'a', response: 'ok', action: 'accepted' }] }, weaknesses))).toBeTruthy();
    expect(problemOf(normalizeReviewResponse({ responses: [
      { weakness: 'a', response: 'A long enough answer here.', action: 'maybe' },
      { weakness: 'b', response: 'A long enough answer here.', action: 'rejected' },
    ] }, weaknesses))).toBeTruthy();
  });

  it("uses the model's own wording when answers don't line up", () => {
    const out = payloadOf(normalizeReviewResponse({ responses: [
      { weakness: 'Only one model size', response: 'Scoped to 125M in the limitations section.', action: 'rejected' },
    ] }, ['Only one model size']));
    expect(out?.responses[0].weakness).toBe('Only one model size');
  });

  it('puts the paper, the revisable fields and every weakness in the prompt', () => {
    const p = reviewResponsePrompt('T', 'Claims: x', { id: 'r', summary: 's', strengths: [], weaknesses, previousAnswer: '(accepted) We would rerun.' }, current, 'point 1 promises future work');
    expect(p).toContain('YOUR OWN PAPER');
    expect(p).toContain('1. No seeds reported');
    expect(p).toContain('2. Only one model size');
    expect(p).toContain('Never claim experiments');
    expect(p).toContain('THE FIELDS YOU CAN REVISE');
    expect(p).toContain('YOUR EARLIER ANSWER');
    expect(p).toContain('YOUR LAST ATTEMPT WAS REFUSED: point 1 promises future work');
  });
});

describe('which reviews need whom', () => {
  it('finds new reviews and answers that accepted without changing anything', () => {
    expect(needsAuthorAnswer({ reviewerAgentId: 'r', weaknesses: ['w'] }, 'me')).toBe('new');
    expect(needsAuthorAnswer({ reviewerAgentId: 'r', weaknesses: ['w'], authorResponse: { responses: [{ action: 'accepted' }] } }, 'me')).toBe('reanswer');
    expect(needsAuthorAnswer({ reviewerAgentId: 'r', weaknesses: ['w'], authorResponse: { responses: [{ action: 'accepted' }], revision: { paperId: 'p' } } }, 'me')).toBeNull();
    expect(needsAuthorAnswer({ reviewerAgentId: 'r', weaknesses: ['w'], authorResponse: { responses: [{ action: 'deferred' }] } }, 'me')).toBeNull();
    expect(needsAuthorAnswer({ reviewerAgentId: 'me', weaknesses: ['w'] }, 'me')).toBeNull();
  });

  it('asks the reviewer again when the author answered after the follow-up', () => {
    expect(needsReviewerFollowUp({ reviewerAgentId: 'me', authorResponse: { createdAt: '2026-11-20' } }, 'me')).toBe(true);
    expect(needsReviewerFollowUp({ reviewerAgentId: 'me', authorResponse: { createdAt: '2026-11-21' }, reviewerFollowUp: { createdAt: '2026-11-20' } }, 'me')).toBe(true);
    expect(needsReviewerFollowUp({ reviewerAgentId: 'me', authorResponse: { createdAt: '2026-11-19' }, reviewerFollowUp: { createdAt: '2026-11-20' } }, 'me')).toBe(false);
    expect(needsReviewerFollowUp({ reviewerAgentId: 'other', authorResponse: { createdAt: '2026-11-20' } }, 'me')).toBe(false);
  });
});

describe('reviewer follow-up', () => {
  const weaknesses = ['No interaction test', 'Spike metric untested'];
  it('keeps a grounded follow-up', async () => {
    const { normalizeFollowUp, followUpPrompt } = await import('../src/utils/review-response.js');
    const out = normalizeFollowUp({
      stance: 'Revised', verdict: 'weak accept',
      notes: 'The interaction estimate answers my first concern; the detector concern is only promised, so it stays open.',
      points: [{ weakness: 'x', status: 'resolved' }, { weakness: 'y', status: 'unresolved', note: 'Only promised.' }],
    }, weaknesses);
    expect(out?.stance).toBe('revised');
    expect(out?.verdict).toBe('weak_accept');
    expect(out?.points.map(p => p.weakness)).toEqual(weaknesses);
    expect(normalizeFollowUp({ stance: 'maintained', notes: 'too short' }, weaknesses)).toBeNull();
    expect(normalizeFollowUp({ stance: 'agree', notes: 'x'.repeat(80) }, weaknesses)).toBeNull();
    const p = followUpPrompt('T', 'Claims: x', { id: 'r', summary: 's', strengths: [], weaknesses },
      { generalResponse: 'We accept.', responses: [{ weakness: 'No interaction test', response: 'We will add it.', action: 'accepted' }] });
    expect(p).toContain('WHAT THE AUTHOR CHANGED');
    expect(p).toContain('The author posted no revision: the paper is unchanged.');
    expect(p).toContain('Judge "accepted" points by the AFTER text');
    expect(p).toContain('You are the reviewer, not the author');
  });
});
