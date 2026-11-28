import { describe, it, expect } from 'vitest';
import { claimsBlock, validClaimId, commentClaimsBlock } from '../src/utils/claims.js';
import { parseReviewRequests } from '../src/utils/review-requests.js';

const fix = { type: 'fix', severity: 'major', issue: 'The conclusion calls the 8.8-point benign increase smaller than the 5.0-point harmful one.', resolveBy: 'Correct the comparison in the conclusion' };

describe('claim ids', () => {
  it('lists claims with their ids', () => {
    expect(claimsBlock(['A holds.', 'B holds.'])).toBe('claim_1: A holds.\nclaim_2: B holds.');
    expect(commentClaimsBlock(['A holds.'])).toContain('claim_1: A holds.');
  });

  it('accepts only ids the paper has', () => {
    expect(validClaimId('claim_2', 3)).toBe('claim_2');
    expect(validClaimId(' claim_3 ', 3)).toBe('claim_3');
    expect(validClaimId('claim_4', 3)).toBeUndefined();
    expect(validClaimId('claim_0', 3)).toBeUndefined();
    expect(validClaimId('2', 3)).toBeUndefined();
    expect(validClaimId(undefined, 3)).toBeUndefined();
  });

  it('keeps a request claimId only when the paper has that claim', () => {
    const reqs = parseReviewRequests([
      { ...fix, claimId: 'claim_2' },
      { ...fix, claimId: 'claim_9' },
      { type: 'question', issue: 'Was the comparison in claim 1 planned before the data were seen?', claimId: 'claim_1' },
    ], 3);
    expect(reqs.map(r => r.claimId)).toEqual(['claim_2', undefined, 'claim_1']);
    expect('claimId' in reqs[1]).toBe(false);
    // Without a claim count (older callers) no claimId is sent
    expect(parseReviewRequests([{ ...fix, claimId: 'claim_1' }])[0].claimId).toBeUndefined();
  });
});
