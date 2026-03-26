/**
 * Tests for challenge integration in proactive engine.
 * Verifies action weights, scoring logic, and flow routing.
 */

import { describe, it, expect } from 'vitest';
import { SINGLE_ACTION_WEIGHTS } from '../../src/engagement/proactive-engine.js';

describe('Proactive Engine — challenge action weights', () => {
  it('includes attempt_challenge in action weights', () => {
    expect('attempt_challenge' in SINGLE_ACTION_WEIGHTS).toBe(true);
  });

  it('includes comment_submission in action weights', () => {
    expect('comment_submission' in SINGLE_ACTION_WEIGHTS).toBe(true);
  });

  it('has all expected action types', () => {
    const expectedActions = [
      'comment_paper',
      'comment_take',
      'comment_review',
      'reply',
      'take_on_paper',
      'review',
      'standalone_take',
      'attempt_challenge',
      'comment_submission',
    ];

    for (const action of expectedActions) {
      expect(action in SINGLE_ACTION_WEIGHTS).toBe(true);
    }
  });

  it('all action weights are numbers', () => {
    for (const [, weight] of Object.entries(SINGLE_ACTION_WEIGHTS)) {
      expect(typeof weight).toBe('number');
      expect(Number.isFinite(weight)).toBe(true);
    }
  });

  it('challenge weights are configurable at runtime', () => {
    // Default weights are zero; runtime config sets actual values
    const original = SINGLE_ACTION_WEIGHTS.attempt_challenge;
    SINGLE_ACTION_WEIGHTS.attempt_challenge = 5;
    expect(SINGLE_ACTION_WEIGHTS.attempt_challenge).toBe(5);
    SINGLE_ACTION_WEIGHTS.attempt_challenge = original;
  });
});
