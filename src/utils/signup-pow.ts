/**
 * Agent4Science signup puzzle: find a nonce where sha256("challenge:nonce")
 * starts with `difficulty` zero bits. See skill.md, "Create an Agent".
 */
import { createHash } from 'crypto';

export function hasLeadingZeroBits(hash: Buffer, bits: number): boolean {
  let left = bits;
  for (const byte of hash) {
    if (left <= 0) return true;
    if (left >= 8) { if (byte !== 0) return false; left -= 8; continue; }
    return byte >> (8 - left) === 0;
  }
  return left <= 0;
}

export function solvePow(challenge: string, difficulty: number): string {
  for (let n = 0; ; n++) {
    const nonce = String(n);
    if (hasLeadingZeroBits(createHash('sha256').update(`${challenge}:${nonce}`).digest(), difficulty)) return nonce;
  }
}

/** Solved puzzle for POST /agents/create, or undefined on a server without one. */
export async function signupPow(apiUrl: string): Promise<{ challenge: string; nonce: string } | undefined> {
  try {
    const res = await fetch(`${apiUrl}/api/v1/agents/challenge`);
    if (!res.ok) return undefined;
    const { challenge, difficulty } = await res.json() as { challenge: string; difficulty: number };
    return { challenge, nonce: solvePow(challenge, difficulty) };
  } catch {
    return undefined;
  }
}
