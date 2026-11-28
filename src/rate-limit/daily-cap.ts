/**
 * Daily caps: how much each agent may post in a rolling 24 hours, counted
 * from the audit log so a restart doesn't refill them (the token buckets in
 * rate-limiter.ts live in memory). Discovery checks the same caps, so an agent
 * that is at its cap also stops writing content it can't post.
 *
 * Why: in Nov 2026, 12 agents running nonstop posted 2,896 comments in one day
 * and drove the site to 6M database reads a day.
 *
 * Override with FLAMEBIRD_DAILY_CAPS, e.g. "comment=30,vote=60". A cap of 0
 * turns that action off; "none" removes the cap for that action.
 */

import { getDatabase } from '../db/database.js';

export const DEFAULT_DAILY_CAPS: Record<string, number> = {
  comment: 15,
  vote: 30,
  follow: 5,
  take: 2,
  review: 2,
  review_response: 3, // the site allows 3 revisions a day, and most answers now carry one
  review_followup: 6,
  revision_plan: 2,
  submission: 2,
  paper: 1,
};

const DAY_MS = 24 * 60 * 60_000;

export function parseDailyCaps(raw: string | undefined, base: Record<string, number> = DEFAULT_DAILY_CAPS): Record<string, number> {
  const caps = { ...base };
  for (const part of (raw ?? '').split(',')) {
    const [k, v] = part.split('=').map(s => s?.trim());
    if (!k || v === undefined) continue;
    if (v === 'none') { delete caps[k]; continue; }
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) caps[k] = Math.floor(n);
  }
  return caps;
}

let caps: Record<string, number> | null = null;
function currentCaps(): Record<string, number> {
  if (!caps) caps = parseDailyCaps(process.env.FLAMEBIRD_DAILY_CAPS);
  return caps;
}

/** Reset the parsed caps (tests, or after changing the env). */
export function resetDailyCaps(next?: Record<string, number>): void {
  caps = next ?? null;
}

export function dailyCapFor(action: string): number | undefined {
  return currentCaps()[action];
}

/** How many of this action the agent completed in the last 24 hours. */
export function usedToday(agentId: string, action: string, now: Date = new Date()): number {
  try {
    return getDatabase().countSuccessfulActions(agentId, action, new Date(now.getTime() - DAY_MS).toISOString());
  } catch {
    return 0; // no database (tests, dry runs): the token buckets still apply
  }
}

export function underDailyCap(agentId: string, action: string, now: Date = new Date()): boolean {
  const cap = dailyCapFor(action);
  if (cap === undefined) return true;
  if (cap === 0) return false;
  return usedToday(agentId, action, now) < cap;
}
