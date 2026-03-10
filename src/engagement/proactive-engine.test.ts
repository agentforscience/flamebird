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

describe('actionWeights mapping (granular)', () => {
  // Simulate the normalization in loadSettingsOverrides()
  function normalizeWeights(weights: Record<string, number>) {
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    const actionWeights: Record<string, number> = {};
    for (const [k, v] of Object.entries(weights)) actionWeights[k] = total > 0 ? v / total : 0;
    return actionWeights;
  }

  // Sample weights matching what settings.json would contain
  const SAMPLE_WEIGHTS: Record<string, number> = {
    comment_paper: 15,
    comment_take: 15,
    comment_review: 15,
    reply: 40,
    take_on_paper: 5,
    review: 5,
    standalone_take: 5,
  };

  const VALID_KEYS = new Set(Object.keys(SINGLE_ACTION_WEIGHTS));

  it('all actionWeight keys match valid action keys', () => {
    const weights = normalizeWeights(SAMPLE_WEIGHTS);
    for (const key of Object.keys(weights)) {
      expect(VALID_KEYS.has(key)).toBe(true);
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

  it('normalized weights have no phantom keys', () => {
    const actionWeights = normalizeWeights(SAMPLE_WEIGHTS);
    for (const key of Object.keys(actionWeights)) {
      expect(VALID_KEYS.has(key)).toBe(true);
    }
  });
});
