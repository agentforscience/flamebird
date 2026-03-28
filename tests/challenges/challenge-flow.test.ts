/**
 * Integration tests for the challenge attempt flow.
 * Tests the actual API calls against the live API (GET only, safe).
 * Verifies the data shapes match what the proactive engine expects.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Agent4ScienceClient } from '../../src/api/agent4science-client.js';
import type { Agent4ScienceChallenge, Agent4ScienceSubmission } from '../../src/types.js';

const BASE_URL = process.env.A4S_BASE_URL || 'https://agent4science.org';
const API_KEY = process.env.A4S_API_KEY || '';

const describeWithApi = API_KEY ? describe : describe.skip;

let client: Agent4ScienceClient;

beforeAll(() => {
  client = new Agent4ScienceClient({ baseUrl: BASE_URL, timeout: 15000 });
});

describeWithApi('Challenge Discovery Flow (real API)', () => {
  let challenges: Agent4ScienceChallenge[];

  it('getChallenges returns data in the shape FeedSnapshot expects', async () => {
    const result = await client.getChallenges(API_KEY, { status: 'open', limit: 10 });
    expect(result.success).toBe(true);
    challenges = result.data || [];
    expect(Array.isArray(challenges)).toBe(true);

    for (const ch of challenges) {
      // These fields are required by scoreChallenge() and queueChallengeAttempt()
      expect(ch.id).toMatch(/^ch_/);
      expect(typeof ch.title).toBe('string');
      expect(typeof ch.description).toBe('string');
      expect(Array.isArray(ch.tags)).toBe(true);
      expect(typeof ch.submissionCount).toBe('number');
      expect(ch.status).toBe('open');
      expect(ch.closesAt).toBeTruthy();
      expect(ch.createdAt).toBeTruthy();
    }
  }, 20000);

  it('challenge descriptions contain LaTeX delimiters for math rendering', async () => {
    if (!challenges || challenges.length === 0) return;

    // At least some challenges should have $...$ or $$...$$ for KaTeX
    const hasLatex = challenges.some(ch =>
      ch.description.includes('$') || ch.description.includes('\\\\')
    );
    expect(hasLatex).toBe(true);
  });

  it('getChallengeSubmissions returns valid submission data', async () => {
    if (!challenges || challenges.length === 0) return;

    // Find a challenge with submissions
    const withSubs = challenges.find(c => c.submissionCount > 0);
    if (!withSubs) return; // No submissions yet, skip

    const result = await client.getChallengeSubmissions(withSubs.id, API_KEY, { sort: 'top', limit: 5 });
    expect(result.success).toBe(true);

    const subs: Agent4ScienceSubmission[] = result.data || [];
    expect(Array.isArray(subs)).toBe(true);

    for (const sub of subs) {
      // These fields are required by queueChallengeAttempt() and queueCommentOnSubmission()
      expect(sub.id).toMatch(/^sub_/);
      expect(sub.challengeId).toBe(withSubs.id);
      expect(typeof sub.title).toBe('string');
      expect(typeof sub.body).toBe('string');
      expect(typeof sub.approach).toBe('string');
      expect(typeof sub.score).toBe('number');
      expect(typeof sub.version).toBe('number');
      expect(typeof sub.agentId).toBe('string');
    }
  }, 20000);
});

describe('Challenge Data Compatibility (no API needed)', () => {
  it('Agent4ScienceChallenge type has required scoring fields', () => {
    // Verify the type shape matches what scoreChallenge() uses
    const mockChallenge: Agent4ScienceChallenge = {
      id: 'ch_test',
      title: 'Test Challenge',
      description: 'Test description with $x^2$ math',
      agentId: 'agent_test',
      tags: ['mathematics', 'test'],
      sciencesub: 'mathematics',
      status: 'open',
      closesAt: new Date(Date.now() + 86400000).toISOString(),
      submissionCount: 0,
      createdAt: new Date().toISOString(),
    };

    // scoreChallenge accesses these
    expect(mockChallenge.tags).toBeDefined();
    expect(mockChallenge.createdAt).toBeDefined();
    expect(mockChallenge.submissionCount).toBeDefined();
    expect(mockChallenge.closesAt).toBeDefined();
  });

  it('Agent4ScienceSubmission type has required fields for LLM', () => {
    const mockSubmission: Agent4ScienceSubmission = {
      id: 'sub_test',
      challengeId: 'ch_test',
      agentId: 'agent_test',
      title: 'Test Solution',
      body: 'Full solution body',
      approach: 'Approach summary',
      improvesUpon: null,
      delta: null,
      declaredScore: null,
      score: 0,
      version: 1,
      commentCount: 0,
      createdAt: new Date().toISOString(),
    };

    // decideChallenge() maps submissions to { title, approach, agentId }
    expect(mockSubmission.title).toBeDefined();
    expect(mockSubmission.approach).toBeDefined();
    expect(mockSubmission.agentId).toBeDefined();

    // generateSolution() needs { title, approach, body }
    expect(mockSubmission.body).toBeDefined();

    // improvesUpon chain
    expect('improvesUpon' in mockSubmission).toBe(true);
    expect('delta' in mockSubmission).toBe(true);
  });
});
