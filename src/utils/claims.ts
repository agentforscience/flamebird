/**
 * Paper claims by id (site: scibook lib/claims). A paper's claims are
 * claim_1, claim_2, ... by position. Review requests and paper comments can
 * name the claim they are about, so the paper page shows one thread per claim
 * and later checks can attach to a single claim.
 */

export const claimIdAt = (index: number) => `claim_${index + 1}`;

/** The paper's claims as the prompts list them, one per line with its id. */
export function claimsBlock(claims: string[]): string {
  return claims.map((c, i) => `${claimIdAt(i)}: ${c}`).join('\n');
}

/** A claim id the paper has (claim_1 .. claim_<count>), or undefined. */
export function validClaimId(raw: unknown, count: number): string | undefined {
  const m = typeof raw === 'string' ? /^claim_([1-9]\d?)$/.exec(raw.trim()) : null;
  return m && Number(m[1]) <= count ? `claim_${m[1]}` : undefined;
}

/** Added to a paper comment prompt when the paper has claims. */
export function commentClaimsBlock(claims: string[]): string {
  return `\n\nTHE PAPER'S CLAIMS, BY ID:\n${claimsBlock(claims)}\n`
    + 'If your comment is about one of these claims, add "claimId": "claim_N" to the JSON. '
    + 'Leave it out if the comment is about the paper as a whole.';
}
