import { describe, it, expect } from 'vitest';
import { ensureFirstTagIsSciencesub } from './proactive-engine.js';

describe('ensureFirstTagIsSciencesub', () => {
  const sciencesubs = [
    { slug: 'machine-learning' },
    { slug: 'neuroscience' },
    { slug: 'quantum-computing' },
    { slug: 'ai-safety' },
  ];

  it('returns tags as-is when first tag is already a valid sciencesub', () => {
    const tags = ['machine-learning', 'deep-learning', 'transformers'];
    const result = ensureFirstTagIsSciencesub(tags, sciencesubs);
    expect(result).toEqual(tags);
  });

  it('moves a valid sciencesub slug to front if found later in tags', () => {
    const tags = ['deep-learning', 'neuroscience', 'transformers'];
    const result = ensureFirstTagIsSciencesub(tags, sciencesubs);
    expect(result[0]).toBe('neuroscience');
    expect(result).toContain('deep-learning'); // kept in the list
    expect(result).toContain('transformers');
  });

  it('uses contextTags as fallback when no tag matches a sciencesub', () => {
    const tags = ['deep-learning', 'transformers'];
    const contextTags = ['ai-safety', 'alignment'];
    const result = ensureFirstTagIsSciencesub(tags, sciencesubs, contextTags);
    expect(result[0]).toBe('ai-safety');
    expect(result.slice(1)).toEqual(tags);
  });

  it('falls back to first available sciencesub as last resort', () => {
    const tags = ['some-obscure-topic', 'another-topic'];
    const result = ensureFirstTagIsSciencesub(tags, sciencesubs);
    // Should prepend the first available sciencesub slug
    expect(sciencesubs.map(s => s.slug)).toContain(result[0]);
  });

  it('returns tags as-is when sciencesubs list is empty', () => {
    const tags = ['deep-learning', 'transformers'];
    const result = ensureFirstTagIsSciencesub(tags, []);
    expect(result).toEqual(tags);
  });

  it('returns tags as-is when sciencesubs list is empty even with contextTags', () => {
    const tags = ['deep-learning', 'transformers'];
    const result = ensureFirstTagIsSciencesub(tags, [], ['ai-safety']);
    expect(result).toEqual(tags);
  });
});

describe('play.ts actionWeights mapping', () => {
  // Simulate the play.ts weight mapping logic
  function buildActionWeights(commentWeight: number, takeWeight: number) {
    const raw: Record<string, number> = {
      comment_paper:   commentWeight * 0.22,
      comment_take:    commentWeight * 0.22,
      comment_review:  commentWeight * 0.16,
      reply:           commentWeight * 0.40,
      take_on_paper:   takeWeight * 0.42,
      standalone_take: takeWeight * 0.58,
      review: 10,
    };
    const total = Object.values(raw).reduce((a, b) => a + b, 0);
    const actionWeights: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) actionWeights[k] = total > 0 ? v / total : 0;
    return actionWeights;
  }

  const SINGLE_ACTION_WEIGHTS: Record<string, number> = {
    comment_paper:   0.14,
    comment_take:    0.14,
    comment_review:  0.10,
    reply:           0.26,
    take_on_paper:   0.10,
    review:          0.12,
    standalone_take: 0.14,
  };

  it('all actionWeight keys match SINGLE_ACTION_WEIGHTS keys', () => {
    const weights = buildActionWeights(25, 10);
    const validKeys = new Set(Object.keys(SINGLE_ACTION_WEIGHTS));
    for (const key of Object.keys(weights)) {
      expect(validKeys.has(key)).toBe(true);
    }
  });

  it('standalone_take gets a non-zero weight', () => {
    const weights = buildActionWeights(25, 10);
    expect(weights['standalone_take']).toBeGreaterThan(0);
  });

  it('take_on_paper gets a non-zero weight', () => {
    const weights = buildActionWeights(25, 10);
    expect(weights['take_on_paper']).toBeGreaterThan(0);
  });

  it('standalone_take weight is larger than take_on_paper weight', () => {
    const weights = buildActionWeights(25, 10);
    expect(weights['standalone_take']).toBeGreaterThan(weights['take_on_paper']);
  });

  it('merged weights have no phantom keys', () => {
    const actionWeights = buildActionWeights(25, 10);
    const merged = { ...SINGLE_ACTION_WEIGHTS, ...actionWeights };
    const validKeys = new Set(Object.keys(SINGLE_ACTION_WEIGHTS));
    for (const key of Object.keys(merged)) {
      expect(validKeys.has(key)).toBe(true);
    }
  });

  it('no rolls are wasted on invalid action types', () => {
    // Simulate the weighted random selection used by pickSingleAction
    const actionWeights = buildActionWeights(25, 10);
    const merged = { ...SINGLE_ACTION_WEIGHTS, ...actionWeights };

    const validCases = new Set([
      'comment_paper', 'comment_take', 'comment_review',
      'reply', 'take_on_paper', 'review', 'standalone_take',
    ]);

    // Every key in merged should be a valid switch case
    for (const key of Object.keys(merged)) {
      expect(validCases.has(key)).toBe(true);
    }
  });
});
