import { describe, it, expect } from 'vitest';
import { recommendationFromReviews, normalizeRevisionPlan, normalizePlanResponse, revisionPlanPrompt, planResponsePrompt, requestsFor, type PlanReview } from '../src/utils/revision-plan.js';

const fixA = 'Intervals are computed over autocorrelated checkpoints rather than independent runs.';
const reviews: PlanReview[] = [
  { id: 'rA', reviewer: 'dr_falsify', summary: 'Stats problems.', requests: [
    { id: 'req_1', type: 'fix', severity: 'major', issue: fixA, resolveBy: 'Report run-level bootstrap intervals' },
    { id: 'req_2', type: 'question', issue: 'Was the per-architecture split planned before the data were examined?' },
  ] },
  { id: 'rB', reviewer: 'wild_hypothesis', summary: 'Scale.', requests: requestsFor({ weaknesses: ['The confidence intervals ignore correlation between checkpoints of a run.', 'Only two small models are tested, so the scale claim is unsupported.'] }) },
];

describe('revision plan', () => {
  it('keeps items whose sources are real and drops invented ones', () => {
    const plan = normalizeRevisionPlan({
      recommendation: 'Major revision',
      summary: 'Both reviewers raise the same interval problem, which decides clause 4; scale is secondary and can be fixed in the text.',
      items: [
        { title: 'Recompute every interval at the run level', severity: 'major', resolveBy: 'Report run-level bootstrap intervals',
          sources: [{ reviewId: 'rA', requestId: 'req_1' }, { reviewId: 'rB', requestId: 'w_1' }, { reviewId: 'rB', requestId: 'w_9' }] },
        { title: 'An item that no reviewer asked for at all', severity: 'minor', resolveBy: 'Do something unrelated here',
          sources: [{ reviewId: 'rZ', requestId: 'req_1' }] },
      ],
    }, reviews);
    // No reviewer judged the paper flawed, so the plan can't call for major revision
    expect(plan?.recommendation).toBe('minor_revision');
    expect(plan?.items).toHaveLength(1);
    expect(plan?.items[0].sources).toEqual([{ reviewId: 'rA', requestId: 'req_1' }, { reviewId: 'rB', requestId: 'w_1' }]);
  });

  it('shows each reviewer\'s judgment and defines the recommendations', () => {
    const p = revisionPlanPrompt('T', 'text', [{ ...reviews[0], soundness: 'sound', soundnessConfidence: 0.8 }, reviews[1]]);
    expect(p).toContain("Reviewer's judgment: sound (confidence 0.8)");
    expect(p).toContain("Reviewer's judgment: not given");
    expect(p).toContain("Don't give a verdict");
  });

  it('gives the planner every review and its request ids', () => {
    const p = revisionPlanPrompt('T', 'text', reviews);
    expect(p).toContain('neither the author');
    expect(p).toContain('req_1 [fix, major]');
    expect(p).toContain('w_2 [fix]');
  });
});

describe('recommendation follows the reviewers', () => {
  it('is minor when all judged sound, major when any judged flawed, reject when most did', () => {
    expect(recommendationFromReviews([{ soundness: 'sound' }, { soundness: 'sound' }, {}])).toBe('minor_revision');
    expect(recommendationFromReviews([{ soundness: 'sound' }, { soundness: 'flawed' }, { soundness: 'sound' }])).toBe('major_revision');
    expect(recommendationFromReviews([{ soundness: 'flawed' }, { soundness: 'flawed' }, { soundness: 'sound' }])).toBe('reject');
    expect(recommendationFromReviews([{}, {}])).toBe('minor_revision');
  });
});

describe('answering a plan with one revision', () => {
  const plan = { recommendation: 'major_revision', summary: 'S'.repeat(120), items: [
    { title: 'Recompute every interval at the run level', severity: 'major', resolveBy: 'Report run-level intervals', sources: [{ reviewId: 'rA', requestId: 'req_1' }] },
  ] };
  const current = { abstract: 'A'.repeat(150), limitations: ['Small models'] };

  it('accepts one shared revision and an answer per review', () => {
    const out = normalizePlanResponse({
      revision: { note: 'States the checkpoint-level intervals and the two-model scope as limitations, per plan items 1-2.', edits: { limitations: ['Small models', 'Intervals are checkpoint-level', 'Two models only'] } },
      answers: [
        { reviewId: 'rA', responses: [
          { requestId: 'req_1', action: 'partially_accepted', response: 'v2 labels the intervals checkpoint-level; run-level resampling is not done.' },
          { requestId: 'req_2', action: 'answered', response: 'No: the split was chosen after looking at the pooled result.' },
        ] },
        { reviewId: 'rB', responses: [
          { requestId: 'w_1', action: 'partially_accepted', response: 'v2 states this limitation; the reanalysis itself is not done.' },
          { requestId: 'w_2', action: 'accepted', response: 'v2 lists the two-model scope as a limitation and narrows the claim.' },
        ] },
      ],
    }, reviews, current);
    expect('payload' in out).toBe(true);
    const p = (out as { payload: { revision?: { edits: Record<string, unknown> }; answers: { reviewId: string }[] } }).payload;
    expect(p.answers.map(a => a.reviewId)).toEqual(['rA', 'rB']);
    expect(p.revision?.edits.limitations).toBeDefined();
  });

  it('refuses a round that skips a review or promises', () => {
    expect(normalizePlanResponse({ revision: null, answers: [] }, reviews, current)).toMatchObject({ problem: expect.stringMatching(/rA was not answered/) });
    const promised = normalizePlanResponse({ revision: null, answers: [
      { reviewId: 'rA', responses: [
        { requestId: 'req_1', action: 'deferred', response: 'We will rerun the analysis at the run level later.' },
        { requestId: 'req_2', action: 'answered', response: 'No: the split was chosen after the pooled result.' },
      ] },
      { reviewId: 'rB', responses: [] },
    ] }, reviews, current);
    expect(promised).toMatchObject({ problem: expect.stringMatching(/rA: .*promises future work/) });
  });

  it('shows the author the plan and every open review', () => {
    const p = planResponsePrompt('T', 'text', current, plan, reviews);
    expect(p).toContain('ONE revision');
    expect(p).toContain('1. [major] Recompute every interval');
    expect(p).toContain('--- rB by @wild_hypothesis');
  });
});
