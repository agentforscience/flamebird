import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDatabase } from '../src/db/database.js';
import { parseDailyCaps, underDailyCap, resetDailyCaps, DEFAULT_DAILY_CAPS } from '../src/rate-limit/daily-cap.js';
import { RateLimiter } from '../src/rate-limit/rate-limiter.js';
import { SiteBackoff } from '../src/api/backoff.js';

describe('daily caps', () => {
  afterEach(() => resetDailyCaps());

  it('parses overrides, zero and none', () => {
    const caps = parseDailyCaps('comment=40, vote=0, follow=none, junk, take=abc');
    expect(caps.comment).toBe(40);
    expect(caps.vote).toBe(0);
    expect('follow' in caps).toBe(false);
    expect(caps.take).toBe(DEFAULT_DAILY_CAPS.take);
  });

  it('counts successful posts from the audit log, so a restart does not refill them', () => {
    const db = createDatabase(join(mkdtempSync(join(tmpdir(), 'fb-cap-')), 'db.sqlite'));
    (db as unknown as { db: { pragma: (s: string) => void } }).db.pragma('foreign_keys = OFF');
    resetDailyCaps({ comment: 2 });
    expect(underDailyCap('a1', 'comment')).toBe(true);
    db.logAction('a1', 'comment', 't1', 'paper', true);
    db.logAction('a1', 'comment', 't2', 'paper', false); // failures don't count
    expect(underDailyCap('a1', 'comment')).toBe(true);
    db.logAction('a1', 'comment', 't3', 'paper', true);
    expect(underDailyCap('a1', 'comment')).toBe(false);
    expect(underDailyCap('a2', 'comment')).toBe(true); // per agent
    // A fresh rate limiter (a restart) still sees the cap
    const rl = new RateLimiter();
    expect(rl.canPerform('a1', 'comment')).toBe(false);
    expect(rl.tryConsume('a1', 'comment')).toBe(false);
    expect(rl.getTimeUntilAllowed('a1', 'comment')).toBeGreaterThan(0);
  });
});

describe('site back-off', () => {
  it('pauses after repeated failures in the window and resumes after the pause', () => {
    const b = new SiteBackoff({ threshold: 3, windowMs: 60_000, pauseMs: 600_000 });
    const t = 1_000_000;
    expect(b.recordFailure(t)).toBe(false);
    expect(b.recordFailure(t + 1000)).toBe(false);
    expect(b.paused(t + 1000)).toBe(false);
    expect(b.recordFailure(t + 2000)).toBe(true);
    expect(b.paused(t + 3000)).toBe(true);
    expect(b.paused(t + 2000 + 600_000)).toBe(false);
  });

  it('forgets failures older than the window', () => {
    const b = new SiteBackoff({ threshold: 3, windowMs: 60_000, pauseMs: 600_000 });
    b.recordFailure(0);
    b.recordFailure(1000);
    expect(b.recordFailure(120_000)).toBe(false);
    expect(b.paused(120_001)).toBe(false);
  });
});
