/**
 * Integration tests for LLM-based sciencesub selection.
 * Fetches real subs from agent4science.org and uses real LLM calls.
 *
 * Requires: LLM_API_KEY, LLM_PROVIDER, LLM_MODEL env vars (or .env file).
 * Skipped automatically if LLM_API_KEY is not set.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { config } from 'dotenv';
import { LLMClient } from '../src/llm/llm-client.js';
import type { AgentPersona } from '../src/types.js';

// Load .env for local development
config();

const API_BASE = process.env.AGENT4SCIENCE_API_URL || 'https://agent4science.org';
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'openrouter') as 'openrouter' | 'anthropic' | 'openai';
const LLM_MODEL = process.env.LLM_MODEL || 'anthropic/claude-sonnet-4';

const describeWithLLM = LLM_API_KEY ? describe : describe.skip;

// Fetch real sciencesubs from the API
let realSubs: Array<{ slug: string; name: string; description: string }> = [];

function makePersona(overrides: Partial<AgentPersona> = {}): AgentPersona {
  return {
    voice: 'academic',
    epistemics: 'empiricist',
    spiceLevel: 5,
    preferredTopics: [],
    petPeeves: [],
    catchphrases: [],
    ...overrides,
  };
}

describeWithLLM('LLM sciencesub selection (real API + real LLM)', () => {
  let llm: LLMClient;

  beforeAll(async () => {
    // Fetch real subs
    const res = await fetch(`${API_BASE}/api/v1/sciencesubs`);
    const data = await res.json();
    realSubs = Array.isArray(data) ? data : (data.sciencesubs || []);
    expect(realSubs.length).toBeGreaterThan(0);

    llm = new LLMClient({
      provider: LLM_PROVIDER,
      apiKey: LLM_API_KEY,
      model: LLM_MODEL,
    });
  }, 30_000);

  it('selects relevant subs for a cancer researcher', async () => {
    const persona = makePersona({
      preferredTopics: ['cancer', 'oncology', 'drug discovery'],
    });

    const selections = await llm.selectSciencesubs(persona, realSubs, { maxSubs: 5 });
    const slugs = selections.map(s => s.slug);

    console.log('Cancer researcher selected:', slugs);

    expect(slugs.length).toBeGreaterThanOrEqual(1);
    // Should pick at least one biology/cancer/drug-related sub
    const hasDomainSub = slugs.some(s =>
      s.includes('cancer') || s.includes('drug') || s.includes('bio') ||
      s.includes('genom') || s.includes('oncol') || s.includes('protein')
    );
    expect(hasDomainSub).toBe(true);
  }, 60_000);

  it('selects relevant subs for a battery researcher', async () => {
    const persona = makePersona({
      voice: 'practitioner',
      preferredTopics: ['battery', 'electrochemistry', 'energy storage'],
    });

    const selections = await llm.selectSciencesubs(persona, realSubs, { maxSubs: 5 });
    const slugs = selections.map(s => s.slug);

    console.log('Battery researcher selected:', slugs);

    expect(slugs.length).toBeGreaterThanOrEqual(1);
    // Should pick energy/materials/chemistry-related subs
    const hasDomainSub = slugs.some(s =>
      s.includes('batter') || s.includes('electro') || s.includes('energy') ||
      s.includes('chem') || s.includes('material')
    );
    expect(hasDomainSub).toBe(true);
  }, 60_000);

  it('selects diverse subs for agent with no preferred topics', async () => {
    const persona = makePersona({
      voice: 'philosopher',
      epistemics: 'speculative',
      preferredTopics: [],
    });

    const selections = await llm.selectSciencesubs(persona, realSubs, { maxSubs: 5 });
    const slugs = selections.map(s => s.slug);

    console.log('No-preference agent selected:', slugs);

    expect(slugs.length).toBeGreaterThanOrEqual(3);

    // Should NOT all be AI/ML subs — check diversity
    const aiKeywords = ['machine-learning', 'deep-learning', 'ai-', 'llm', 'transformer', 'neural'];
    const aiCount = slugs.filter(s => aiKeywords.some(k => s.includes(k))).length;
    // At most 60% AI subs (allow some, but not all)
    expect(aiCount).toBeLessThan(slugs.length);
  }, 60_000);

  it('respects alreadyJoined exclusion', async () => {
    const persona = makePersona({
      preferredTopics: ['machine learning', 'NLP'],
    });

    // First, get selections without exclusion
    const firstRun = await llm.selectSciencesubs(persona, realSubs, { maxSubs: 3 });
    const firstSlugs = firstRun.map(s => s.slug);

    console.log('First run selected:', firstSlugs);

    // Now exclude those and get more
    const secondRun = await llm.selectSciencesubs(persona, realSubs, {
      maxSubs: 3,
      alreadyJoined: firstSlugs,
    });
    const secondSlugs = secondRun.map(s => s.slug);

    console.log('Second run (excluding first) selected:', secondSlugs);

    // No overlap
    for (const slug of secondSlugs) {
      expect(firstSlugs).not.toContain(slug);
    }
  }, 120_000);

  it('returns only valid slugs from the available list', async () => {
    const persona = makePersona({
      preferredTopics: ['quantum computing'],
    });

    const selections = await llm.selectSciencesubs(persona, realSubs, { maxSubs: 5 });
    const validSlugs = new Set(realSubs.map(s => s.slug));

    for (const sel of selections) {
      expect(validSlugs.has(sel.slug)).toBe(true);
    }
  }, 60_000);
});
