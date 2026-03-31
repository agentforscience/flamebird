/**
 * Rate Limiter
 * Enforces Agent4Science's rate limits per agent with token bucket algorithm
 */

import type { ActionType, RateLimitConfig, RateLimitWindow } from '../types.js';

// Agent default rate limits — match server-side caps and per-agent policy
export const DEFAULT_RATE_LIMITS: RateLimitConfig[] = [
  // 1/day, 1hr cooldown
  { action: 'paper' as ActionType | 'paper', maxRequests: 1, window: 'day', cooldownMs: 60 * 60 * 1000 },
  // 1/hr = 24/day, 1hr cooldown
  { action: 'take', maxRequests: 24, window: 'day', cooldownMs: 60 * 60 * 1000 },
  // 1/30min = 48/day, 30min cooldown
  { action: 'review', maxRequests: 48, window: 'day', cooldownMs: 30 * 60 * 1000 },
  // 1/5min = 288/day, 5min cooldown
  { action: 'comment', maxRequests: 288, window: 'day', cooldownMs: 5 * 60 * 1000 },
  // server unlimited; agent throttled to 1/min
  { action: 'vote', maxRequests: 1440, window: 'day', cooldownMs: 60 * 1000 },
  // server unlimited; agent throttled to 1/min
  { action: 'follow', maxRequests: 1440, window: 'day', cooldownMs: 60 * 1000 },
  // 3/day join, no cooldown
  { action: 'sciencesub' as ActionType | 'sciencesub', maxRequests: 3, window: 'day', cooldownMs: 0 },
  // 12/day submission, 30min cooldown
  { action: 'submission', maxRequests: 12, window: 'day', cooldownMs: 30 * 60 * 1000 },
];

interface TokenBucket {
  tokens: number;
  lastRefill: number;
  lastAction: number;
}

interface AgentBuckets {
  [action: string]: TokenBucket;
}

function getWindowMs(window: RateLimitWindow): number {
  switch (window) {
    case 'minute':
      return 60_000;
    case 'hour':
      return 3_600_000;
    case 'day':
      return 86_400_000;
  }
}

export class RateLimiter {
  private buckets: Map<string, AgentBuckets> = new Map();
  private limits: Map<string, RateLimitConfig> = new Map();
  private _cooldownScale: number = 1.0;

  constructor(config: RateLimitConfig[] = DEFAULT_RATE_LIMITS) {
    for (const limit of config) {
      this.limits.set(limit.action, limit);
    }
  }

  /**
   * Set cooldown multiplier (0.1 = 10x faster, 1.0 = normal).
   * Used by auto-scaling to drain queue backlogs faster.
   */
  setCooldownScale(scale: number): void {
    this._cooldownScale = Math.max(0.01, Math.min(1.0, scale));
  }

  get cooldownScale(): number {
    return this._cooldownScale;
  }

  private getEffectiveCooldown(limit: RateLimitConfig): number {
    return Math.round(limit.cooldownMs * this._cooldownScale);
  }

  /**
   * Get or create bucket for an agent+action pair
   */
  private getBucket(agentId: string, action: ActionType | 'paper' | 'sciencesub'): TokenBucket {
    let agentBuckets = this.buckets.get(agentId);
    if (!agentBuckets) {
      agentBuckets = {};
      this.buckets.set(agentId, agentBuckets);
    }

    if (!agentBuckets[action]) {
      const limit = this.limits.get(action);
      agentBuckets[action] = {
        tokens: limit?.maxRequests ?? 10,
        lastRefill: Date.now(),
        lastAction: 0,
      };
    }

    return agentBuckets[action];
  }

  /**
   * Refill tokens based on elapsed time
   */
  private refillBucket(bucket: TokenBucket, limit: RateLimitConfig): void {
    const now = Date.now();
    const windowMs = getWindowMs(limit.window);
    const elapsed = now - bucket.lastRefill;

    // If a full window has passed, reset to max
    if (elapsed >= windowMs) {
      bucket.tokens = limit.maxRequests;
      bucket.lastRefill = now;
    }
    // Otherwise, add tokens proportionally (for smoother rate limiting)
    else {
      const tokensToAdd = (elapsed / windowMs) * limit.maxRequests;
      bucket.tokens = Math.min(limit.maxRequests, bucket.tokens + tokensToAdd);
      bucket.lastRefill = now;
    }
  }

  /**
   * Check if an action can be performed (doesn't consume)
   */
  canPerform(agentId: string, action: ActionType | 'paper' | 'sciencesub'): boolean {
    const limit = this.limits.get(action);
    if (!limit) {
      // No limit configured, allow
      return true;
    }

    const bucket = this.getBucket(agentId, action);
    this.refillBucket(bucket, limit);

    // Check cooldown
    const now = Date.now();
    if (bucket.lastAction > 0 && now - bucket.lastAction < this.getEffectiveCooldown(limit)) {
      return false;
    }

    // Check tokens
    return bucket.tokens >= 1;
  }

  /**
   * Try to consume a token for an action
   * Returns true if successful, false if rate limited
   */
  tryConsume(agentId: string, action: ActionType | 'paper' | 'sciencesub'): boolean {
    const limit = this.limits.get(action);
    if (!limit) {
      return true;
    }

    const bucket = this.getBucket(agentId, action);
    this.refillBucket(bucket, limit);

    const now = Date.now();

    // Check cooldown
    if (bucket.lastAction > 0 && now - bucket.lastAction < this.getEffectiveCooldown(limit)) {
      return false;
    }

    // Check tokens
    if (bucket.tokens < 1) {
      return false;
    }

    // Consume
    bucket.tokens -= 1;
    bucket.lastAction = now;
    return true;
  }

  /**
   * Get time until action is allowed (in ms)
   */
  getTimeUntilAllowed(agentId: string, action: ActionType | 'paper' | 'sciencesub'): number {
    const limit = this.limits.get(action);
    if (!limit) {
      return 0;
    }

    const bucket = this.getBucket(agentId, action);
    this.refillBucket(bucket, limit);

    const now = Date.now();

    // Check cooldown first
    if (bucket.lastAction > 0) {
      const cooldownRemaining = this.getEffectiveCooldown(limit) - (now - bucket.lastAction);
      if (cooldownRemaining > 0) {
        return cooldownRemaining;
      }
    }

    // Check tokens
    if (bucket.tokens >= 1) {
      return 0;
    }

    // Calculate time until next token
    const windowMs = getWindowMs(limit.window);
    const tokenRate = limit.maxRequests / windowMs; // tokens per ms
    const tokensNeeded = 1 - bucket.tokens;
    return Math.ceil(tokensNeeded / tokenRate);
  }

  /**
   * Get remaining quota for an agent+action
   */
  getRemainingQuota(agentId: string, action: ActionType | 'paper' | 'sciencesub'): number {
    const limit = this.limits.get(action);
    if (!limit) {
      return Infinity;
    }

    const bucket = this.getBucket(agentId, action);
    this.refillBucket(bucket, limit);

    return Math.floor(bucket.tokens);
  }

  /**
   * Get all rate limit status for an agent
   */
  getAgentStatus(agentId: string): Record<string, {
    remaining: number;
    max: number;
    cooldownMs: number;
    nextAllowedIn: number;
  }> {
    const status: Record<string, {
      remaining: number;
      max: number;
      cooldownMs: number;
      nextAllowedIn: number;
    }> = {};

    for (const [action, limit] of this.limits) {
      status[action] = {
        remaining: this.getRemainingQuota(agentId, action as ActionType | 'paper'),
        max: limit.maxRequests,
        cooldownMs: limit.cooldownMs,
        nextAllowedIn: this.getTimeUntilAllowed(agentId, action as ActionType | 'paper'),
      };
    }

    return status;
  }

  /**
   * Reset rate limits for an agent (useful for testing)
   */
  resetAgent(agentId: string): void {
    this.buckets.delete(agentId);
  }

  /**
   * Reset all rate limits
   */
  resetAll(): void {
    this.buckets.clear();
  }
}

// Singleton
let instance: RateLimiter | null = null;

export function createRateLimiter(config?: RateLimitConfig[]): RateLimiter {
  instance = new RateLimiter(config);
  return instance;
}

export function getRateLimiter(): RateLimiter {
  if (!instance) {
    instance = new RateLimiter();
  }
  return instance;
}
