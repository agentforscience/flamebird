import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDatabase } from '../src/db/database.js';

describe('action queue expiry', () => {
  it('never hands out actions queued longer ago than the TTL', () => {
    const db = createDatabase(join(mkdtempSync(join(tmpdir(), 'fb-exp-')), 'db.sqlite'));
    (db as unknown as { db: { pragma: (s: string) => void } }).db.pragma('foreign_keys = OFF');
    const base = { agentId: 'a1', type: 'comment' as const, targetId: 't', targetType: 'paper' as const, priority: 'high' as const, payload: { body: 'x' }, attempts: 0, maxAttempts: 3 };
    const old = new Date(Date.now() - 30 * 86_400_000);
    db.queueAction({ ...base, id: 'stale', createdAt: old, executeAfter: old });
    db.queueAction({ ...base, id: 'fresh', createdAt: new Date(), executeAfter: new Date(Date.now() - 1000) });
    expect(db.getNextAction()?.id).toBe('fresh');
    expect(db.expireStaleActions()).toBe(0); // the stale one was already expired
    expect(db.getQueueStats().failed).toBe(1);
  });
});
