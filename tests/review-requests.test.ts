import { describe, it, expect } from 'vitest';
import { parseReviewRequests, parseReviewScores, weaknessesFromRequests, requestsBlock, type ReviewRequest } from '../src/utils/review-requests.js';
import { normalizeReviewResponse, normalizeFollowUp, reviewResponsePrompt, followUpPrompt } from '../src/utils/review-response.js';

const fixIssue = 'Intervals are computed over autocorrelated checkpoints rather than over independent runs.';
const sugIssue = 'The abstract frames the effect as multiplicative although the reported numbers contradict that.';
const question = 'Was the per-architecture split planned before the data were examined?';

describe('parsing a review into requests', () => {
  it('keeps requests the site accepts and drops vague ones', () => {
    const reqs = parseReviewRequests([
      { type: 'fix', severity: 'major', issue: fixIssue, resolveBy: 'Report run-level bootstrap intervals' },
      { type: 'suggestion', issue: sugIssue, resolveBy: 'Drop the multiplicative framing' },
      { type: 'question', issue: question },
      { type: 'fix', issue: 'Statistics are weak overall and need work in general here.', resolveBy: '' }, // no resolveBy
      { type: 'fix', issue: 'too short', resolveBy: 'Do something specific about it' },
      { type: 'rant', issue: fixIssue, resolveBy: 'x'.repeat(20) },
    ]);
    expect(reqs.map(r => r.type)).toEqual(['fix', 'suggestion', 'question']);
    expect(reqs[1].severity).toBe('minor');
    expect(weaknessesFromRequests(reqs)).toEqual([fixIssue, sugIssue]);
  });

  it('keeps only in-range integer scores', () => {
    expect(parseReviewScores({ soundness: 2, overall: 6, confidence: 9, presentation: 2.5 })).toEqual({ soundness: 2, overall: 6 });
    expect(parseReviewScores('high')).toBeUndefined();
  });
});

const requests: ReviewRequest[] = [
  { id: 'req_1', type: 'fix', severity: 'major', issue: fixIssue, resolveBy: 'Report run-level bootstrap intervals' },
  { id: 'req_2', type: 'suggestion', severity: 'minor', issue: sugIssue, resolveBy: 'Drop the multiplicative framing' },
  { id: 'req_3', type: 'question', issue: question },
];
const current = { abstract: 'A'.repeat(150), limitations: ['Small models'] };

describe('author answers by request id', () => {
  it('maps answers to requests, uses the request wording, and allows "answered" only for questions', () => {
    const out = normalizeReviewResponse({
      responses: [
        { requestId: 'req_3', response: 'Yes: the split appears in the preregistration, section 2.', action: 'answered' },
        { requestId: 'req_1', response: 'Not done: run-level resampling needs a reanalysis we have not run.', action: 'deferred' },
        { requestId: 'req_2', response: 'Correct. v2 drops the multiplicative framing from the abstract.', action: 'accepted' },
      ],
      revision: { note: 'Drops the multiplicative framing from the abstract, as review req_2 asked.', edits: { abstract: 'B'.repeat(150) } },
    }, [], current, requests);
    expect('payload' in out).toBe(true);
    const p = (out as { payload: { responses: { requestId?: string; weakness: string; action: string }[] } }).payload;
    expect(p.responses.map(r => r.requestId)).toEqual(['req_3', 'req_1', 'req_2']);
    expect(p.responses[0].weakness).toBe(question);
  });

  it('does not let "answered" stand in for a fix', () => {
    const out = normalizeReviewResponse({
      responses: [
        { requestId: 'req_1', response: 'We think the intervals are fine as reported here.', action: 'answered' },
        { requestId: 'req_2', response: 'Not done: the framing stays in this version for now.', action: 'deferred' },
        { requestId: 'req_3', response: 'Yes, it was planned in the preregistration document.', action: 'answered' },
      ],
    }, [], current, requests);
    // req_1's answer is dropped, so not every request is answered: refused, and retried with that reason
    expect('problem' in out && out.problem).toMatch(/not every weakness was answered/);
  });

  it('lists the requests in the prompt with their ids', () => {
    const p = reviewResponsePrompt('T', 'text', { id: 'r', summary: 's', strengths: [], weaknesses: [], requests }, current);
    expect(p).toContain('Requests (answer each one by its id)');
    expect(p).toContain('req_1 [fix, major]');
    expect(p).toContain('"answered": only for a request of type question');
    expect(requestsBlock(requests)).toContain('Would resolve it: Report run-level bootstrap intervals');
  });
});

describe('reviewer follow-up by request id', () => {
  it('maps points to requests and keeps updated scores', () => {
    const out = normalizeFollowUp({
      stance: 'revised',
      notes: 'The framing fix is real; the interval problem is disclosed but not fixed, so soundness stays low.',
      points: [
        { requestId: 'req_2', status: 'resolved' },
        { requestId: 'req_1', status: 'unresolved', note: 'Deferred, not done.' },
        { requestId: 'req_9', status: 'resolved' },
      ],
      scores: { soundness: 2, overall: 6 },
    }, [], requests);
    expect(out?.points.map(p => p.requestId)).toEqual(['req_2', 'req_1']);
    expect(out?.points[0].weakness).toBe(sugIssue);
    expect(out?.scores).toEqual({ soundness: 2, overall: 6 });
  });

  it('shows the reviewer its own requests and scores', () => {
    const p = followUpPrompt('T', 'text', { id: 'r', summary: 's', strengths: [], weaknesses: [], requests, scores: { overall: 4 } }, { responses: [], generalResponse: null, revision: null });
    expect(p).toContain('Your requests:');
    expect(p).toContain('Your scores: {"overall":4}');
    expect(p).toContain('Give one point per request, with its requestId.');
  });
});
