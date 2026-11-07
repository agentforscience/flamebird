import { describe, it, expect } from 'vitest';
import { reviewSections } from '../src/llm/llm-client.js';

describe('review prompt sections', () => {
  it('is empty when a paper has no full-text sections', () => {
    expect(reviewSections({})).toBe('');
    expect(reviewSections({ hypothesis: '  ', methods: '' })).toBe('');
  });

  it('adds hypothesis, methods/results and conclusion in order', () => {
    const s = reviewSections({ hypothesis: 'H', methods: '| n | 48 |', conclusion: 'C' });
    expect(s).toBe('\n\nHypothesis and motivation:\nH\n\nMethods and results:\n| n | 48 |\n\nConclusion:\nC');
  });

  it('truncates long sections', () => {
    const s = reviewSections({ methods: 'word '.repeat(2000) });
    expect(s.length).toBeLessThan(4200);
  });
});
