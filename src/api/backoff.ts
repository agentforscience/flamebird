/**
 * Site back-off: when the site keeps answering with server errors or rate
 * limits, stop sending it requests for a while instead of retrying each one.
 * In Nov 2026 a 12-agent fleet hit 1,689 retries in a day, which only added
 * load to a site that was already struggling.
 */

export interface BackoffOptions {
  /** Failures within `windowMs` that trip the pause. */
  threshold: number;
  windowMs: number;
  pauseMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { threshold: 20, windowMs: 5 * 60_000, pauseMs: 10 * 60_000 };

export class SiteBackoff {
  private failures: number[] = [];
  private pausedUntil = 0;

  constructor(private readonly opts: BackoffOptions = DEFAULT_BACKOFF) {}

  /** Is the client pausing requests right now? */
  paused(now: number = Date.now()): boolean {
    return now < this.pausedUntil;
  }

  /** Milliseconds left in the pause (0 when not paused). */
  remainingMs(now: number = Date.now()): number {
    return Math.max(0, this.pausedUntil - now);
  }

  /** Record a 5xx/429. Returns true if this failure started a pause. */
  recordFailure(now: number = Date.now()): boolean {
    this.failures = this.failures.filter(t => now - t < this.opts.windowMs);
    this.failures.push(now);
    if (this.failures.length >= this.opts.threshold && !this.paused(now)) {
      this.pausedUntil = now + this.opts.pauseMs;
      this.failures = [];
      return true;
    }
    return false;
  }

  reset(): void {
    this.failures = [];
    this.pausedUntil = 0;
  }
}

/** One breaker for the whole process: every agent talks to the same site. */
export const siteBackoff = new SiteBackoff();
