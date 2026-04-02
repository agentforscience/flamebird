/**
 * Integration test for the HypogenicAI backend idea generator.
 *
 * This test makes REAL HTTP calls to the deployed backend service.
 * Run with: npm run test:idea-generator
 */

import { describe, it, expect } from 'vitest';
import { generateIdea, buildResearchPrompt, type IdeaGeneratorContext } from '../src/tools/idea-generator.js';

// Realistic sample data that mirrors what Agent4Science feed looks like
const SAMPLE_CONTEXT: IdeaGeneratorContext = {
  recentPapers: [
    { title: 'Topological Persistence Analysis of Neural Architecture Scaling Laws', tags: ['machine-learning', 'scaling-laws'] },
    { title: 'Emergent Reasoning in Large Language Models via Chain-of-Thought', tags: ['nlp', 'reasoning'] },
    { title: 'Diffusion Models for Protein Structure Prediction', tags: ['computational-biology', 'generative-models'] },
  ],
  recentTakes: [
    { title: 'Scaling Laws Are Misleading', hotTake: 'Current scaling law research ignores architecture-specific effects and creates a false sense of predictability.' },
    { title: 'LLM Reasoning is Just Pattern Matching', hotTake: 'Chain-of-thought prompting does not produce genuine reasoning — it exploits training data patterns.' },
  ],
  preferredTopics: ['machine learning', 'deep learning'],
  domain: 'artificial_intelligence',
};

describe('buildResearchPrompt', () => {
  it('should construct a prompt from context', () => {
    const prompt = buildResearchPrompt(SAMPLE_CONTEXT);

    // Should include research interests
    expect(prompt).toContain('machine learning');
    expect(prompt).toContain('deep learning');

    // Should include domain
    expect(prompt).toContain('artificial_intelligence');

    // Should include paper titles
    expect(prompt).toContain('Topological Persistence Analysis');
    expect(prompt).toContain('Emergent Reasoning');

    // Should include take content
    expect(prompt).toContain('Scaling Laws Are Misleading');

    // Should end with the generation instruction
    expect(prompt).toContain('Generate an innovative research idea');
  });

  it('should handle empty context gracefully', () => {
    const prompt = buildResearchPrompt({
      recentPapers: [],
      recentTakes: [],
      preferredTopics: [],
    });

    expect(prompt).toContain('Generate an innovative research idea');
    expect(prompt.length).toBeGreaterThan(0);
  });
});

describe('generateIdea (integration)', () => {
  it('should call the backend and return a structured idea', async () => {
    const idea = await generateIdea(SAMPLE_CONTEXT);

    // Verify structure
    expect(idea).toHaveProperty('title');
    expect(idea).toHaveProperty('tldr');
    expect(idea).toHaveProperty('description');

    // Verify non-empty
    expect(idea.title.length).toBeGreaterThan(0);
    expect(idea.tldr.length).toBeGreaterThan(0);
    expect(idea.description.length).toBeGreaterThan(0);

    console.log('Generated idea:', {
      title: idea.title,
      tldr: idea.tldr.slice(0, 100),
      descriptionLength: idea.description.length,
    });
  }, 120_000); // 2 minute timeout — backend can be slow
});
