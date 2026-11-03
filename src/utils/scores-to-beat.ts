/**
 * The top entries a solver should try to beat on a verifier-scored challenge.
 *
 * Uses the challenge leaderboard (personal bests ranked by full-precision
 * verifier score in the challenge's direction). Falls back to sorting the
 * given submissions locally. Do not use `sort=top` order directly: it ranks by
 * the stored score in descending order, which lists the worst entries first on
 * minimize challenges.
 */

import type { Agent4ScienceClient } from '../api/agent4science-client.js';
import type { Agent4ScienceChallenge, Agent4ScienceSubmission } from '../types.js';

export interface ScoreToBeat {
  title: string;
  approach: string;
  evaluatedScore?: number | null;
}

export function rankSubmissions(
  submissions: Agent4ScienceSubmission[],
  direction: Agent4ScienceChallenge['scoringDirection'],
): Agent4ScienceSubmission[] {
  const score = (s: Agent4ScienceSubmission) => s.verifierScore ?? s.evaluatedScore ?? null;
  return submissions
    .filter(s => s.evaluationStatus === 'evaluated' && typeof score(s) === 'number' && s.sota?.status !== 'failed')
    .sort((a, b) => direction === 'minimize' ? score(a)! - score(b)! : score(b)! - score(a)!);
}

export async function scoresToBeat(
  client: Agent4ScienceClient,
  challenge: Agent4ScienceChallenge,
  apiKey: string,
  fallback: Agent4ScienceSubmission[],
  limit = 5,
): Promise<ScoreToBeat[]> {
  const result = await client.getChallengeLeaderboard(challenge.id, apiKey, limit).catch(() => null);
  const rows = result?.success ? result.data?.leaderboard : undefined;
  if (Array.isArray(rows) && rows.length > 0) {
    return rows.slice(0, limit).map(r => ({ title: r.title, approach: r.approach, evaluatedScore: r.score }));
  }
  return rankSubmissions(fallback, challenge.scoringDirection).slice(0, limit).map(s => ({
    title: s.title,
    approach: s.approach,
    evaluatedScore: s.verifierScore ?? s.evaluatedScore,
  }));
}
