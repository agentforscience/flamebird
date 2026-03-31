/**
 * Tests for challenge/submission API client methods
 * GET tests hit real API (read-only, safe) — skipped without A4S_API_KEY.
 * Method signature tests run without API access.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Agent4ScienceClient } from '../../src/api/agent4science-client.js';

const BASE_URL = process.env.A4S_BASE_URL || 'https://agent4science.org';
const API_KEY = process.env.A4S_API_KEY || '';

// Skip API tests if no API key is provided
const describeWithApi = API_KEY ? describe : describe.skip;

let client: Agent4ScienceClient;

beforeAll(() => {
  client = new Agent4ScienceClient({ baseUrl: BASE_URL, timeout: 15000 });
});

describeWithApi('Challenge API Client — GET (real API)', () => {
  it('getChallenges returns challenges array', async () => {
    const result = await client.getChallenges(API_KEY, { status: 'open', limit: 5 });
    expect(result.success).toBe(true);
    if (result.data) {
      expect(Array.isArray(result.data)).toBe(true);
      for (const ch of result.data) {
        expect(ch.id).toMatch(/^ch_/);
        expect(ch.title).toBeTruthy();
        expect(ch.status).toBe('open');
        expect(ch.tags).toBeInstanceOf(Array);
        expect(typeof ch.submissionCount).toBe('number');
      }
    }
  }, 20000);

  it('getChallenges with sort=closed returns closed challenges', async () => {
    const result = await client.getChallenges(API_KEY, { sort: 'closed', status: 'closed', limit: 5 });
    expect(result.success).toBe(true);
    if (result.data && result.data.length > 0) {
      for (const ch of result.data) {
        expect(['closed', 'archived']).toContain(ch.status);
      }
    }
  }, 20000);

  it('getChallenge returns a single challenge', async () => {
    const listResult = await client.getChallenges(API_KEY, { limit: 1 });
    if (!listResult.success || !listResult.data || listResult.data.length === 0) {
      return; // No challenges to test with
    }

    const challengeId = listResult.data[0].id;
    const result = await client.getChallenge(challengeId, API_KEY);
    expect(result.success).toBe(true);
    expect(result.data?.id).toBe(challengeId);
    expect(result.data?.title).toBeTruthy();
    expect(result.data?.description).toBeTruthy();
  }, 20000);

  it('getChallengeSubmissions returns submissions array', async () => {
    const listResult = await client.getChallenges(API_KEY, { limit: 1 });
    if (!listResult.success || !listResult.data || listResult.data.length === 0) {
      return;
    }

    const challengeId = listResult.data[0].id;
    const result = await client.getChallengeSubmissions(challengeId, API_KEY, { sort: 'top', limit: 10 });
    expect(result.success).toBe(true);
    if (result.data) {
      expect(Array.isArray(result.data)).toBe(true);
      for (const sub of result.data) {
        expect(sub.id).toMatch(/^sub_/);
        expect(sub.challengeId).toBe(challengeId);
        expect(sub.title).toBeTruthy();
        expect(typeof sub.score).toBe('number');
        expect(typeof sub.version).toBe('number');
      }
    }
  }, 20000);
});

describe('Challenge API Client — method signatures', () => {
  it('client has getChallenges method', () => {
    expect(typeof client.getChallenges).toBe('function');
  });

  it('client has getChallenge method', () => {
    expect(typeof client.getChallenge).toBe('function');
  });

  it('client has getChallengeSubmissions method', () => {
    expect(typeof client.getChallengeSubmissions).toBe('function');
  });

  it('client has createSubmission method', () => {
    expect(typeof client.createSubmission).toBe('function');
  });

  it('client has getSubmission method', () => {
    expect(typeof client.getSubmission).toBe('function');
  });

  it('client has voteSubmission method', () => {
    expect(typeof client.voteSubmission).toBe('function');
  });

  it('client has getSubmissionComments method', () => {
    expect(typeof client.getSubmissionComments).toBe('function');
  });

  it('client has commentOnSubmission method', () => {
    expect(typeof client.commentOnSubmission).toBe('function');
  });

  // getChallengeComments / commentOnChallenge not yet implemented —
  // challenge-level comments go through submission comment endpoints.
});
