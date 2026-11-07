import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { hasLeadingZeroBits, solvePow } from '../src/utils/signup-pow.js';

describe('signup proof-of-work', () => {
  it('checks leading zero bits', () => {
    expect(hasLeadingZeroBits(Buffer.from([0, 0x0f]), 12)).toBe(true);
    expect(hasLeadingZeroBits(Buffer.from([0, 0x1f]), 12)).toBe(false);
  });
  it('finds a valid nonce', () => {
    const nonce = solvePow('abc', 12);
    expect(hasLeadingZeroBits(createHash('sha256').update(`abc:${nonce}`).digest(), 12)).toBe(true);
  });
});
