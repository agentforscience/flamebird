import { describe, it, expect } from 'vitest';
import { ensureFirstTagIsSciencesub, SINGLE_ACTION_WEIGHTS } from './proactive-engine.js';

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

describe('play.ts actionWeights mapping (granular)', () => {
  // Simulate the new direct-passthrough normalization in loadSettingsOverrides()
  function normalizeWeights(weights: Record<string, number>) {
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    const actionWeights: Record<string, number> = {};
    for (const [k, v] of Object.entries(weights)) actionWeights[k] = total > 0 ? v / total : 0;
    return actionWeights;
  }

  const SAMPLE_WEIGHTS: Record<string, number> = {
    comment_paper: 15, comment_take: 15, comment_review: 10,
    reply: 42, take_on_paper: 7, review: 6, standalone_take: 5,
  };

  it('all actionWeight keys match SINGLE_ACTION_WEIGHTS keys', () => {
    const weights = normalizeWeights(SAMPLE_WEIGHTS);
    const validKeys = new Set(Object.keys(SINGLE_ACTION_WEIGHTS));
    for (const key of Object.keys(weights)) {
      expect(validKeys.has(key)).toBe(true);
    }
  });

  it('weights normalize to sum to 1.0', () => {
    const weights = normalizeWeights(SAMPLE_WEIGHTS);
    const sum = Object.values(weights).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it('standalone_take gets a non-zero weight', () => {
    const weights = normalizeWeights(SAMPLE_WEIGHTS);
    expect(weights['standalone_take']).toBeGreaterThan(0);
  });

  it('take_on_paper gets a non-zero weight', () => {
    const weights = normalizeWeights(SAMPLE_WEIGHTS);
    expect(weights['take_on_paper']).toBeGreaterThan(0);
  });

  it('merged weights have no phantom keys', () => {
    const actionWeights = normalizeWeights(SAMPLE_WEIGHTS);
    const merged = { ...SINGLE_ACTION_WEIGHTS, ...actionWeights };
    const validKeys = new Set(Object.keys(SINGLE_ACTION_WEIGHTS));
    for (const key of Object.keys(merged)) {
      expect(validKeys.has(key)).toBe(true);
    }
  });

  it('no rolls are wasted on invalid action types', () => {
    const actionWeights = normalizeWeights(SAMPLE_WEIGHTS);
    const merged = { ...SINGLE_ACTION_WEIGHTS, ...actionWeights };

    const validCases = new Set([
      'comment_paper', 'comment_take', 'comment_review',
      'reply', 'take_on_paper', 'review', 'standalone_take',
    ]);

    for (const key of Object.keys(merged)) {
      expect(validCases.has(key)).toBe(true);
    }
  });
});

describe('settings migration: 4-key to 7-key activityWeights', () => {
  it('detects old format by presence of "comment" and absence of "reply"', () => {
    const oldFormat = { paper: 5, take: 10, comment: 25, vote: 20 };
    const isOld = 'comment' in oldFormat && !('reply' in oldFormat);
    expect(isOld).toBe(true);
  });

  it('detects new format correctly', () => {
    const newFormat = {
      comment_paper: 15, comment_take: 15, comment_review: 10,
      reply: 42, take_on_paper: 7, review: 6, standalone_take: 5,
    };
    const isOld = 'comment' in newFormat && !('reply' in newFormat);
    expect(isOld).toBe(false);
  });

  it('migrated values produce non-zero weights for all 7 keys', () => {
    const commentWeight = 25;
    const takeWeight = 10;
    const baseWeight = commentWeight + takeWeight;
    const migrated = {
      comment_paper:   Math.round(commentWeight * 0.22) || 1,
      comment_take:    Math.round(commentWeight * 0.22) || 1,
      comment_review:  Math.round(commentWeight * 0.16) || 1,
      reply:           Math.round(commentWeight * 0.40) || 1,
      take_on_paper:   Math.round(takeWeight * 0.42) || 1,
      standalone_take: Math.round(takeWeight * 0.58) || 1,
      review:          Math.round(baseWeight * (6 / 94)) || 1,
    };
    for (const v of Object.values(migrated)) {
      expect(v).toBeGreaterThanOrEqual(1);
    }
    expect(Object.keys(migrated)).toHaveLength(7);
  });
});
