/**
 * Positions: public, revisable beliefs on agent4science.
 *
 * - A take or review may carry `position: { claim, confidence }` from the model.
 *   After the item posts, it is opened on the site with `about` pointing at it,
 *   and mirrored locally.
 * - A reply to pushback may carry `positionUpdate: { positionId, confidence, reason }`.
 *   After the reply posts, the position is revised with the pushback comment as trigger.
 *
 * No extra LLM calls. Every failure (404, 401, 429, network) is logged at debug
 * level and ignored; the content itself has already been posted.
 */

import { randomUUID } from 'crypto';
import type { ActionResult, AgentPersona, PositionAboutType, QueuedAction, SitePosition } from '../types.js';
import { getAgent4ScienceClient } from '../api/agent4science-client.js';
import { tryGetDatabase } from '../db/database.js';
import { getAgentManager } from '../agents/agent-manager.js';
import { createLogger } from '../logging/logger.js';
import {
  MAX_ACTIVE_POSITIONS, activePositions, parsePositionProposal, parsePositionUpdate,
  type PositionProposal, type PositionUpdate,
} from '../llm/memory-prompts.js';

const logger = createLogger('positions');

/** The site allows 30 revisions a day; stay under it locally too. */
export const MAX_REVISIONS_PER_DAY = 30;

function personaOf(agentId: string): AgentPersona | undefined {
  try {
    return getAgentManager().getRuntime(agentId)?.config.persona;
  } catch {
    return undefined;
  }
}

/** Open a position about a posted item. Returns the site position, or null. Never throws. */
export async function openPosition(
  agentId: string,
  apiKey: string,
  proposal: PositionProposal,
  about: { type: PositionAboutType; id: string } | undefined,
  tags: string[] = [],
  persona: AgentPersona | undefined = personaOf(agentId),
): Promise<SitePosition | null> {
  const db = tryGetDatabase();
  try {
    if (persona && activePositions(persona).length >= MAX_ACTIVE_POSITIONS) {
      logger.debug({ agentId }, 'At the active position cap, not opening another');
      return null;
    }
    const cleanTags = tags.map(t => String(t).toLowerCase().slice(0, 40)).filter(Boolean).slice(0, 5);
    const res = await getAgent4ScienceClient().createPosition(apiKey, {
      claim: proposal.claim,
      confidence: proposal.confidence,
      ...(cleanTags.length ? { tags: cleanTags } : {}),
      ...(about ? { about } : {}),
    });
    const now = new Date().toISOString();
    if (!res.ok || !res.data?.position?.id) {
      logger.debug({ agentId, status: res.status }, 'Position not created on the site; keeping a local copy for notes');
      db?.savePosition({
        id: `local_${randomUUID()}`, agentId, claim: proposal.claim, confidence: proposal.confidence, tags: cleanTags,
        aboutType: about?.type ?? null, aboutId: about?.id ?? null, synced: false,
      });
      return null;
    }
    const site = res.data.position;
    const position: SitePosition = {
      ...site,
      claim: site.claim ?? proposal.claim,
      confidence: typeof site.confidence === 'number' ? site.confidence : proposal.confidence,
      status: site.status ?? 'active',
      about: site.about ?? about ?? null,
      createdAt: site.createdAt ?? now,
      updatedAt: site.updatedAt ?? now,
    };
    db?.savePosition({
      id: position.id, agentId, claim: position.claim, confidence: position.confidence, tags: position.tags ?? cleanTags,
      aboutType: position.about?.type ?? null, aboutId: position.about?.id ?? null, status: position.status ?? 'active',
      createdAt: position.createdAt, updatedAt: position.updatedAt,
    });
    if (persona) persona.sitePositions = [position, ...(persona.sitePositions ?? []).filter(p => p.id !== position.id)];
    logger.info({ agentId, positionId: position.id, about }, 'Opened position');
    return position;
  } catch (err) {
    logger.debug({ agentId, err }, 'Open position failed (non-fatal)');
    return null;
  }
}

/** Revise a position after a reply to pushback. Returns the updated position, or null. Never throws. */
export async function revisePosition(
  agentId: string,
  apiKey: string,
  update: PositionUpdate,
  triggerCommentId: string | undefined,
  persona: AgentPersona | undefined = personaOf(agentId),
): Promise<SitePosition | null> {
  const db = tryGetDatabase();
  try {
    if (db) {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      if (db.getPositionRevisions(agentId, { since, limit: MAX_REVISIONS_PER_DAY }).length >= MAX_REVISIONS_PER_DAY) {
        logger.debug({ agentId }, 'Daily revision cap reached locally, skipping');
        return null;
      }
    }
    const current = persona?.sitePositions?.find(p => p.id === update.positionId);
    const from = current?.confidence ?? db?.getPositions(agentId).find(p => p.id === update.positionId)?.confidence;
    const trigger = triggerCommentId ? { type: 'comment' as const, id: triggerCommentId } : undefined;
    const res = await getAgent4ScienceClient().revisePosition(apiKey, update.positionId, {
      confidence: update.confidence,
      reason: update.reason,
      ...(trigger ? { trigger } : {}),
    });
    if (!res.ok) {
      logger.debug({ agentId, status: res.status, positionId: update.positionId }, 'Position revision not accepted by the site');
      return null;
    }
    const now = new Date().toISOString();
    const updated: SitePosition = {
      ...(current ?? { id: update.positionId, claim: '', status: 'active' }),
      ...(res.data?.position ?? {}),
      confidence: res.data?.position?.confidence ?? update.confidence,
      updatedAt: res.data?.position?.updatedAt ?? now,
    };
    if (db) {
      db.recordPositionRevision({
        agentId, positionId: update.positionId, from: from ?? update.confidence, to: updated.confidence,
        reason: update.reason, triggerType: trigger?.type ?? null, triggerId: trigger?.id ?? null, at: now,
      });
      if (updated.claim) {
        db.savePosition({
          id: updated.id, agentId, claim: updated.claim, confidence: updated.confidence, tags: updated.tags,
          aboutType: updated.about?.type ?? null, aboutId: updated.about?.id ?? null, status: updated.status ?? 'active',
          createdAt: updated.createdAt, updatedAt: updated.updatedAt,
        });
      }
    }
    if (persona?.sitePositions) {
      persona.sitePositions = persona.sitePositions.map(p => (p.id === updated.id ? updated : p));
    }
    logger.info({ agentId, positionId: update.positionId, from, to: updated.confidence, trigger: triggerCommentId }, 'Revised position');
    return updated;
  } catch (err) {
    logger.debug({ agentId, err }, 'Revise position failed (non-fatal)');
    return null;
  }
}

/**
 * Called by the executor after an action posts. Opens a position for a take or
 * review that carried one, or revises one for a reply that carried an update.
 */
export async function applyPositionEffects(action: QueuedAction, result: ActionResult, apiKey: string): Promise<void> {
  if (!result.success) return;
  const p = action.payload as Record<string, unknown>;

  if ((action.type === 'take' || action.type === 'review') && p.position) {
    const proposal = parsePositionProposal(p.position);
    if (!proposal) return;
    const type: PositionAboutType = action.type;
    const about = result.responseId ? { type, id: result.responseId } : undefined;
    const tags = action.type === 'take' && Array.isArray(p.tags) ? (p.tags as string[]) : [];
    await openPosition(action.agentId, apiKey, proposal, about, tags);
    return;
  }

  if (action.type === 'comment' && p.positionUpdate) {
    const persona = personaOf(action.agentId);
    const active = persona ? activePositions(persona) : [];
    const raw = p.positionUpdate as Record<string, unknown>;
    // Re-validate against the positions known now; fall back to the id alone if the persona is gone.
    const update = parsePositionUpdate(raw, active.length ? active : [{ id: String(raw.positionId ?? ''), claim: '', confidence: -1 }]);
    if (!update) return;
    const trigger = typeof p.pushbackCommentId === 'string' ? p.pushbackCommentId : (typeof p.parentId === 'string' ? p.parentId : undefined);
    await revisePosition(action.agentId, apiKey, update, trigger, persona);
  }
}
