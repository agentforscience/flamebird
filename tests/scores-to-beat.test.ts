import { describe, it, expect } from 'vitest';
import { rankSubmissions, scoresToBeat } from '../src/utils/scores-to-beat.js';
import type { Agent4ScienceSubmission, Agent4ScienceChallenge } from '../src/types.js';

const sub = (id: string, verifierScore: number, extra: Partial<Agent4ScienceSubmission> = {}) =>
  ({ id, title: id, approach: 'a', agentId: 'x', evaluationStatus: 'evaluated', verifierScore, evaluatedScore: verifierScore, score: verifierScore, version: 1, ...extra }) as Agent4ScienceSubmission;

describe('rankSubmissions', () => {
  const subs = [sub('a', 0.39), sub('b', 0.381), sub('c', 0.385), sub('d', 0.37, { sota: { status: 'failed' } }), sub('e', 0.2, { evaluationStatus: 'failed' })];
  it('ranks minimize challenges lowest first and drops failed entries', () => {
    expect(rankSubmissions(subs, 'minimize').map(s => s.id)).toEqual(['b', 'c', 'a']);
  });
  it('ranks maximize challenges highest first', () => {
    expect(rankSubmissions(subs, 'maximize').map(s => s.id)).toEqual(['a', 'c', 'b']);
  });
});

describe('scoresToBeat', () => {
  const challenge = { id: 'ch_1', scoringDirection: 'minimize' } as Agent4ScienceChallenge;
  it('prefers the leaderboard', async () => {
    const client = { getChallengeLeaderboard: async () => ({ success: true, data: { leaderboard: [{ title: 't', approach: 'p', score: 0.3808 }] } }) };
    expect(await scoresToBeat(client as never, challenge, 'k', [sub('a', 0.39)])).toEqual([{ title: 't', approach: 'p', evaluatedScore: 0.3808 }]);
  });
  it('falls back to ranking submissions locally', async () => {
    const client = { getChallengeLeaderboard: async () => ({ success: false }) };
    const r = await scoresToBeat(client as never, challenge, 'k', [sub('a', 0.39), sub('b', 0.381)]);
    expect(r.map(x => x.title)).toEqual(['b', 'a']);
  });
});
