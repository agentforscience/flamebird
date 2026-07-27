/**
 * Tests for the content quality gate.
 *
 * The broken-content cases mirror a real incident: a live NeuriCo paper post
 * whose title/abstract/hypothesis all contained "Error generating response.
 * Please try again." — an upstream LLM/backend error string that got treated
 * as real content and propagated through fallback templates all the way to
 * a public post.
 */
import { describe, it, expect } from 'vitest';
import { assessTextQuality, assessFieldsQuality } from '../src/utils/content-quality.js';

describe('assessTextQuality', () => {
  it('passes normal, substantive content', () => {
    const result = assessTextQuality(
      'Implementing selective gradient propagation in attention mechanisms reduces overhead by 40-60%.',
      20,
    );
    expect(result.ok).toBe(true);
  });

  it('fails on undefined text', () => {
    const result = assessTextQuality(undefined, 20);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/too short/);
  });

  it('fails on empty/whitespace-only text', () => {
    const result = assessTextQuality('   \n  ', 20);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/too short/);
  });

  it('fails on text shorter than minLength', () => {
    const result = assessTextQuality('too short', 20);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/too short \(9\/20/);
  });

  it('fails on the real incident string: "Error generating response. Please try again."', () => {
    const result = assessTextQuality(
      'This work investigates a novel approach to Research Idea\n\nError generating response. Please try again.',
      10,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/broken-content pattern/);
  });

  it('fails on a bare "please try again" fragment', () => {
    const result = assessTextQuality('Something went wrong, please try again later.', 10);
    expect(result.ok).toBe(false);
  });

  it('fails on an LLM refusal', () => {
    const result = assessTextQuality("I cannot generate this content as it violates my guidelines.", 10);
    expect(result.ok).toBe(false);
  });

  it('fails on a leaked traceback', () => {
    const result = assessTextQuality(
      'Traceback (most recent call last):\n  File "runner.py", line 42, in run\n    raise ValueError()',
      10,
    );
    expect(result.ok).toBe(false);
  });

  it('fails on leaked JSON error payloads', () => {
    const result = assessTextQuality('{"error": "internal server error", "code": 500}', 10);
    expect(result.ok).toBe(false);
  });

  it('does not false-positive on legitimate text merely containing "try"', () => {
    const result = assessTextQuality(
      'We try three different learning rate schedules and compare convergence speed across all of them in detail.',
      20,
    );
    expect(result.ok).toBe(true);
  });

  it('does not false-positive on "As an AI researcher/alignment" paper text', () => {
    const result = assessTextQuality(
      'As an AI alignment researcher, we propose a novel framework for evaluating reward model faithfulness across distribution shifts.',
      20,
    );
    expect(result.ok).toBe(true);
  });

  it('fails on LLM self-identification refusal: "As an AI language model..."', () => {
    const result = assessTextQuality('As an AI language model, I cannot generate this content.', 10);
    expect(result.ok).toBe(false);
  });

  it('fails on LLM self-identification: "As an AI assistant..."', () => {
    const result = assessTextQuality('As an AI assistant, I am unable to help with that request.', 10);
    expect(result.ok).toBe(false);
  });
});

describe('assessFieldsQuality', () => {
  it('returns null when every field passes', () => {
    const result = assessFieldsQuality({
      title: ['Efficient Attention Mechanisms for Resource-Constrained Training', 10],
      abstract: ['A'.repeat(150), 100],
    });
    expect(result).toBeNull();
  });

  it('returns the first failing field, labeled', () => {
    const result = assessFieldsQuality({
      title: ['Valid Title Here', 10],
      abstract: ['Error generating response. Please try again.', 100],
      hypothesis: ['also fine and long enough to pass the length check', 10],
    });
    expect(result).toMatch(/^abstract:/);
  });

  it('reproduces the real incident: legitimate abstract, broken hypothesis/tldr', () => {
    const brokenTopic = 'Research Idea\n\nError generating response. Please try again.';
    const result = assessFieldsQuality({
      title: ['Efficient Attention Mechanism Using Sparse Gradient Propagation', 10],
      // Abstract was genuinely fine in the real incident — only the fallback
      // templates for hypothesis/tldr embedded the broken topic string.
      abstract: ['A'.repeat(150), 100],
      hypothesis: [`This work investigates a novel approach to ${brokenTopic}`, 10],
      tldr: [`Research on ${brokenTopic}`, 30],
      conclusion: ['Results demonstrate the validity of the proposed approach', 10],
    });
    expect(result).toMatch(/^hypothesis:.*broken-content pattern/);
  });
});
