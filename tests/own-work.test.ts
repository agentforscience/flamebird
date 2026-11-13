import { describe, it, expect, beforeEach } from 'vitest';
import { findOwnWork, ownWorkBlock, rootTypeOf, resetOwnWorkCache, type OwnWorkClient } from '../src/utils/own-work.js';
import { normalizeReviewResponse, reviewResponsePrompt } from '../src/utils/review-response.js';

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

  it('keeps valid answers with the reviewer wording', () => {
    const out = normalizeReviewResponse({
      responses: [
        { weakness: 'seeds', response: 'Right: we ran one seed. We would rerun with five.', action: 'accepted' },
        { weakness: 'size', response: 'The limitations section already says this; the claim is scoped to 125M.', action: 'Rejected' },
      ],
      generalResponse: 'We accept the seed concern and would rerun with five seeds; the size limit is already stated in the paper.',
    }, weaknesses);
    expect(out?.responses.map(r => r.weakness)).toEqual(weaknesses);
    expect(out?.responses[1].action).toBe('rejected');
    expect(out?.generalResponse).toBeDefined();
  });

  it('rejects unusable answers', () => {
    expect(normalizeReviewResponse(null, weaknesses)).toBeNull();
    expect(normalizeReviewResponse({ responses: [{ weakness: 'a', response: 'ok', action: 'accepted' }] }, weaknesses)).toBeNull();
    expect(normalizeReviewResponse({ responses: [
      { weakness: 'a', response: 'A long enough answer here.', action: 'maybe' },
      { weakness: 'b', response: 'A long enough answer here.', action: 'accepted' },
    ] }, weaknesses)).toBeNull();
  });

  it("uses the model's own wording when answers don't line up", () => {
    const out = normalizeReviewResponse({ responses: [
      { weakness: 'Only one model size', response: 'Scoped to 125M in the limitations section.', action: 'rejected' },
    ] }, ['Only one model size']);
    expect(out?.responses[0].weakness).toBe('Only one model size');
  });

  it('puts the paper and every weakness in the prompt', () => {
    const p = reviewResponsePrompt('T', 'Claims: x', { id: 'r', summary: 's', strengths: [], weaknesses });
    expect(p).toContain('YOUR OWN PAPER');
    expect(p).toContain('1. No seeds reported');
    expect(p).toContain('2. Only one model size');
    expect(p).toContain('Never claim experiments');
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
    expect(p).toContain('A promise to run an analysis does not resolve');
    expect(p).toContain('You are the reviewer, not the author');
  });
});
