/**
 * Tests for challenge/submission rate limiting
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimiter, DEFAULT_RATE_LIMITS } from '../../src/rate-limit/rate-limiter.js';

describe('RateLimiter — submission limits', () => {
  let limiter: RateLimiter;
  const agentId = 'test-agent-123';

  beforeEach(() => {
    limiter = new RateLimiter(DEFAULT_RATE_LIMITS);
  });

  it('has submission rate limit configured', () => {
    const status = limiter.getAgentStatus(agentId);
    expect(status['submission']).toBeDefined();
    expect(status['submission'].max).toBe(12);
    expect(status['submission'].cooldownMs).toBe(30 * 60 * 1000); // 30 minutes
  });

  it('allows first submission', () => {
    expect(limiter.canPerform(agentId, 'submission')).toBe(true);
    expect(limiter.tryConsume(agentId, 'submission')).toBe(true);
  });

  it('enforces cooldown after submission', () => {
    limiter.tryConsume(agentId, 'submission');
    // Should be blocked by 2hr cooldown
    expect(limiter.canPerform(agentId, 'submission')).toBe(false);
  });

  it('reports correct remaining quota', () => {
    expect(limiter.getRemainingQuota(agentId, 'submission')).toBe(12);
    limiter.tryConsume(agentId, 'submission');
    expect(limiter.getRemainingQuota(agentId, 'submission')).toBe(11);
  });

  it('getTimeUntilAllowed returns positive after consumption', () => {
    limiter.tryConsume(agentId, 'submission');
    const waitTime = limiter.getTimeUntilAllowed(agentId, 'submission');
    expect(waitTime).toBeGreaterThan(0);
    // Should be close to 2 hours (allow for timing)
    expect(waitTime).toBeLessThanOrEqual(2 * 60 * 60 * 1000);
  });

  it('cooldown scaling affects submission cooldown', () => {
    limiter.setCooldownScale(0.1); // 10x faster
    limiter.tryConsume(agentId, 'submission');
    const waitTime = limiter.getTimeUntilAllowed(agentId, 'submission');
    // Should be ~12 minutes instead of 2 hours
    expect(waitTime).toBeLessThanOrEqual(12 * 60 * 1000 + 1000);
  });

  it('reset clears submission state', () => {
    limiter.tryConsume(agentId, 'submission');
    expect(limiter.canPerform(agentId, 'submission')).toBe(false);
    limiter.resetAgent(agentId);
    expect(limiter.canPerform(agentId, 'submission')).toBe(true);
  });
});
