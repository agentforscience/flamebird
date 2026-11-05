/**
 * Prompt pieces for site notes, positions and trust weighting. Pure, no I/O.
 *
 * Each block returns '' when there is nothing relevant (no positions from the
 * site, no record for the commenter), so default-agent prompts stay
 * byte-identical (tests/work-style-prompts.test.ts and tests/memory.test.ts).
 */

import type { AgentPersona, SitePosition } from '../types.js';
import type { FromRecord } from '../api/agent4science-client.js';

export const MAX_ACTIVE_POSITIONS = 50;
export const CLAIM_MIN = 10;
export const CLAIM_MAX = 300;
export const REASON_MIN = 20;
export const REASON_MAX = 500;
const MAX_POSITIONS_SHOWN = 8;
const MAX_NOTES_BLOCK = 1500;

export const TRUST_LINE = 'Weigh a track record as evidence, not authority, and judge the argument itself.';

/** The pushback a reply answers: which comment, who wrote it, and their record if the site sent one. */
export interface PushbackContext {
  commentId: string;
  fromHandle?: string;
  fromRecord?: FromRecord;
}

export interface PositionProposal {
  claim: string;
  confidence: number;
}

export interface PositionUpdate {
  positionId: string;
  confidence: number;
  reason: string;
}

function oneLine(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

function clamp01(n: unknown): number | undefined {
  const v = typeof n === 'string' ? parseFloat(n) : n;
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.min(1, Math.max(0, v));
}

/** "blind rounds 72%, citations found 9/10", or '' when the record has nothing checked. */
export function formatFromRecord(rec: FromRecord | undefined | null): string {
  if (!rec) return '';
  const parts: string[] = [];
  if (typeof rec.blindAccuracy === 'number' && Number.isFinite(rec.blindAccuracy)) {
    const pct = rec.blindAccuracy <= 1 ? rec.blindAccuracy * 100 : rec.blindAccuracy;
    parts.push(`blind rounds ${Math.round(pct)}%`);
  }
  if (Number.isFinite(rec.citationsTotal) && rec.citationsTotal > 0) {
    parts.push(`citations found ${rec.citationsFound}/${rec.citationsTotal}`);
  }
  return parts.join(', ');
}

/** Active positions, or [] when the site sent none. */
export function activePositions(persona: AgentPersona): SitePosition[] {
  return (persona.sitePositions ?? []).filter(p => p.status !== 'retracted');
}

/**
 * Extra JSON field for take and review prompts. Only when the site returned a
 * positions list (it supports them) and the agent is under the active cap.
 */
export function positionFieldLine(persona: AgentPersona, kind: 'take' | 'review'): string {
  if (persona.sitePositions === undefined) return '';
  if (activePositions(persona).length >= MAX_ACTIVE_POSITIONS) return '';
  return `
- position: optional object { "claim": string (${CLAIM_MIN}-${CLAIM_MAX} chars, one specific claim from this ${kind} that you would defend in public), "confidence": number 0-1 (how likely you think the claim is true) }. Include it only when the ${kind} makes a clear, checkable claim. It is published on your profile as a position you can later revise.`;
}

/**
 * Block appended to a reply to pushback on the agent's own work: the commenter's
 * record (if any) and the agent's active positions (if any), with the optional
 * positionUpdate field. '' when neither exists.
 */
export function pushbackPromptBlock(persona: AgentPersona, pushback: PushbackContext | undefined, rootId?: string): string {
  if (!pushback) return '';
  const parts: string[] = [];

  const record = formatFromRecord(pushback.fromRecord);
  if (record) {
    const who = pushback.fromHandle ? `@${pushback.fromHandle.replace(/^@/, '')}` : 'commenter';
    parts.push(`COMMENTER'S RECORD (${who}: ${record}). ${TRUST_LINE}`);
  }

  const active = activePositions(persona);
  if (active.length) {
    const ordered = [
      ...active.filter(p => rootId && p.about?.id === rootId),
      ...active.filter(p => !(rootId && p.about?.id === rootId)),
    ].slice(0, MAX_POSITIONS_SHOWN);
    const lines = ordered.map(p => `- ${p.id} (confidence ${p.confidence.toFixed(2)}): "${oneLine(p.claim, 200)}"`);
    parts.push(`YOUR ACTIVE POSITIONS (public; confidence is how likely you think the claim is true):
${lines.join('\n')}
If this comment makes you accept or partly accept a point that bears on one of these positions, add this optional field to your JSON:
"positionUpdate": { "positionId": "<id from the list>", "confidence": <new value 0-1>, "reason": "<${REASON_MIN}-${REASON_MAX} chars: what in their comment changed your mind>" }
Leave it out when you reject the point or when none of these positions is affected.`);
  }

  return parts.length ? `\n\n${parts.join('\n\n')}` : '';
}

/** Validate a `position` field from a take or review. undefined when absent or unusable. */
export function parsePositionProposal(raw: unknown): PositionProposal | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.claim !== 'string') return undefined;
  const claim = oneLine(r.claim, CLAIM_MAX);
  const confidence = clamp01(r.confidence);
  if (claim.length < CLAIM_MIN || confidence === undefined) return undefined;
  return { claim, confidence };
}

/**
 * Validate a `positionUpdate` from a reply. The id must be one of the agent's
 * active positions and the confidence must actually change.
 */
export function parsePositionUpdate(raw: unknown, active: SitePosition[]): PositionUpdate | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const positionId = typeof r.positionId === 'string' ? r.positionId.trim() : '';
  const current = active.find(p => p.id === positionId);
  if (!current) return undefined;
  const confidence = clamp01(r.confidence);
  if (confidence === undefined || Math.abs(confidence - current.confidence) < 0.005) return undefined;
  if (typeof r.reason !== 'string') return undefined;
  const reason = oneLine(r.reason, REASON_MAX);
  if (reason.length < REASON_MIN) return undefined;
  return { positionId, confidence, reason };
}

/** Site notes for the persona prompt, next to memory.md. '' when empty. */
export function formatSiteNotes(text: string | undefined | null): string {
  const t = (text ?? '').trim();
  if (!t) return '';
  const body = t.length > MAX_NOTES_BLOCK ? `${t.slice(0, MAX_NOTES_BLOCK)}\n[...truncated]` : t;
  return `YOUR NOTES (private notes on agent4science, kept across machines and harnesses):\n${body}`;
}
