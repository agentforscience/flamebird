/**
 * Agent Working Memory Updater
 * Extracts structured memory entries from successfully executed actions.
 * No LLM calls — pure parsing of action payloads.
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'fs';
import { join } from 'path';
import type {
  AgentWorkingMemory,
  AgentMemoryPosition,
  AgentMemoryActivity,
  AgentThreadMemory,
  QueuedAction,
  ActionResult,
  CommentIntent,
} from '../types.js';
import { getDatabase } from '../db/database.js';
import { createLogger } from '../logging/logger.js';
import { getFlamebirdHome } from '../config/config.js';

const logger = createLogger('memory');

/** Max entries to keep in each memory category. */
const MAX_POSITIONS = 8;
const MAX_ACTIVITIES = 10;
const MAX_RELATIONSHIPS = 15;
const MAX_THREADS = 5;
const MAX_THREAD_COMMENTS = 4;
const MAX_THREAD_KEY_POINTS = 3;
const MAX_RELATIONSHIP_EXCHANGES = 3;

/** Map comment intents to readable stance labels. */
const INTENT_TO_STANCE: Record<string, string> = {
  challenge: 'skeptical',
  support: 'supportive',
  clarify: 'seeking clarity',
  connect: 'drawing connections',
  question: 'questioning',
  extend: 'building on',
  probe: 'probing',
  synthesize: 'synthesizing',
};

/**
 * Extract a rough topic from the content being discussed.
 * Uses rootTitle if available, otherwise first ~60 chars of target content.
 */
function extractTopic(action: QueuedAction): string {
  const payload = action.payload as Record<string, unknown>;
  // Prefer rootTitle stashed by event-loop's generateResponse
  const rootTitle = payload.rootTitle as string | undefined;
  if (rootTitle) return rootTitle.slice(0, 80);

  // For takes, use the take title
  const title = payload.title as string | undefined;
  if (title) return title.slice(0, 80);

  // Fallback: target type + ID suffix
  return `${action.targetType}:${action.targetId.slice(-8)}`;
}

/**
 * Extract a short summary of what the agent said, from the action payload.
 * Truncates to keep memory compact.
 */
function extractSummary(action: QueuedAction): string {
  const payload = action.payload as Record<string, unknown>;
  const body = (payload.body as string) || '';
  const intent = (payload.intent as string) || action.type;

  // First sentence or first 120 chars, whichever is shorter
  const firstSentence = body.split(/[.!?]\s/)[0];
  const short = firstSentence.length > 120 ? firstSentence.slice(0, 117) + '...' : firstSentence;

  return short || `${intent} on ${action.targetType}`;
}

/**
 * Derive a tone label from the interaction.
 */
function deriveTone(intent: string | undefined): string {
  switch (intent) {
    case 'challenge': return 'disagreement';
    case 'support': return 'agreement';
    case 'clarify': return 'clarification';
    case 'question': case 'probe': return 'inquiry';
    case 'synthesize': return 'synthesis';
    case 'connect': case 'extend': return 'collaborative';
    default: return 'exchange';
  }
}

/** Patterns that indicate a fallback/low-value comment not worth memorizing. */
const LOW_VALUE_PATTERNS = [
  /^interesting point/i,
  /^let me think about/i,
  /^thanks for sharing/i,
  /^great (work|point|paper)/i,
  /^I appreciate/i,
];

/**
 * Deterministic pre-filter: skip recording memory for low-value interactions.
 * Returns true if the action should be skipped (not worth memorizing).
 */
function shouldSkipMemoryWrite(action: QueuedAction): boolean {
  const payload = action.payload as Record<string, unknown>;
  const body = (payload.body as string) || '';
  const confidence = (payload.confidence as number) ?? 0.5;

  // Skip very short comments (acknowledgements, one-liners)
  if (action.type === 'comment' && body.length < 30) return true;

  // Skip low-confidence fallback responses
  if (confidence < 0.3) return true;

  // Skip known fallback patterns
  if (LOW_VALUE_PATTERNS.some(p => p.test(body.trim()))) return true;

  return false;
}

/**
 * Extract a rootId for thread tracking.
 * The rootId is the paper/take/review/submission that anchors the thread.
 */
function extractRootId(action: QueuedAction): string | undefined {
  const payload = action.payload as Record<string, unknown>;
  // rootId is stashed by event-loop or proactive-engine
  const rootId = payload.rootId as string | undefined;
  if (rootId) return rootId;
  // For top-level comments on papers/takes, the targetId IS the root
  if (['paper', 'take', 'review', 'submission'].includes(action.targetType)) {
    return action.targetId;
  }
  return undefined;
}

/**
 * Update agent working memory after a successful action.
 * Called from action-executor after result.success.
 * Retries once on version conflict.
 */
export function updateAgentMemory(
  agentId: string,
  action: QueuedAction,
  result: ActionResult,
): void {
  const db = getDatabase();
  const payload = action.payload as Record<string, unknown>;

  // Only record content-producing actions (comment, take, review, submission)
  if (!['comment', 'take', 'review', 'submission'].includes(action.type)) {
    return;
  }

  // Deterministic pre-filter: skip low-value interactions
  if (shouldSkipMemoryWrite(action)) {
    logger.debug({ agentId, actionId: action.id }, 'Skipping memory write (low-value content)');
    return;
  }

  const sourceContentId = result.responseId || action.id;
  const now = new Date().toISOString();

  // Track entries that get pruned from rolling memory for consolidation
  const graduated: { positions: AgentMemoryPosition[]; threads: AgentThreadMemory[] } = {
    positions: [],
    threads: [],
  };

  const updater = (current: AgentWorkingMemory): AgentWorkingMemory => {
    const mem = {
      positions: [...current.positions],
      relationships: { ...current.relationships },
      recentActivity: [...current.recentActivity],
      threads: { ...(current.threads || {}) },
    };

    const topic = extractTopic(action);
    const summary = extractSummary(action);
    const intent = payload.intent as CommentIntent | undefined;
    const stance = intent ? (INTENT_TO_STANCE[intent] || intent) : 'commented';

    // 1. Record position (for comments with clear intent)
    if (action.type === 'comment' || action.type === 'review') {
      const confidence = (payload.confidence as number) ?? 0.5;

      const newPosition: AgentMemoryPosition = {
        topic,
        stance,
        summary,
        sourceContentId,
        confidence,
        updatedAt: now,
      };

      // Deduplicate: if we already have a position on the same topic, update it
      const existingIdx = mem.positions.findIndex(p => p.topic === topic);
      if (existingIdx >= 0) {
        mem.positions[existingIdx] = newPosition;
      } else {
        mem.positions.push(newPosition);
      }

      // Prune oldest if over limit — graduate high-confidence ones to persistent memory
      if (mem.positions.length > MAX_POSITIONS) {
        const pruned = mem.positions.slice(0, mem.positions.length - MAX_POSITIONS);
        graduated.positions.push(...pruned.filter(p => p.confidence >= 0.5));
        mem.positions = mem.positions.slice(-MAX_POSITIONS);
      }
    }

    // 2. Update relationship with the other agent (enriched with exchange summaries)
    const fromAgent = (payload.fromAgent as string) ||
      (payload.notificationType === 'reply' || payload.notificationType === 'mention'
        ? `agent:${action.targetId.slice(-8)}`
        : undefined);

    if (fromAgent && fromAgent !== agentId) {
      const handle = fromAgent.startsWith('@') ? fromAgent : `@${fromAgent}`;
      const existing = mem.relationships[handle];

      // Build enriched exchange entry
      const exchangeEntry = {
        topic,
        myStance: stance,
        theirPoint: (payload.targetContent as string)?.slice(0, 80),
        at: now,
      };

      const prevExchanges = existing?.recentExchanges || [];
      const updatedExchanges = [...prevExchanges, exchangeEntry].slice(-MAX_RELATIONSHIP_EXCHANGES);

      mem.relationships[handle] = {
        exchanges: (existing?.exchanges || 0) + 1,
        tone: deriveTone(intent as string | undefined),
        lastTopic: topic,
        lastAt: now,
        recentExchanges: updatedExchanges,
      };

      // Prune least-recent relationships if over limit
      const entries = Object.entries(mem.relationships);
      if (entries.length > MAX_RELATIONSHIPS) {
        entries.sort((a, b) => a[1].lastAt.localeCompare(b[1].lastAt));
        const keep = entries.slice(-MAX_RELATIONSHIPS);
        mem.relationships = Object.fromEntries(keep);
      }
    }

    // 3. Record activity
    const activitySummary = buildActivitySummary(action);
    const newActivity: AgentMemoryActivity = {
      summary: activitySummary,
      sourceContentId,
      at: now,
    };
    mem.recentActivity.push(newActivity);
    if (mem.recentActivity.length > MAX_ACTIVITIES) {
      mem.recentActivity = mem.recentActivity.slice(-MAX_ACTIVITIES);
    }

    // 4. Update thread memory (per-thread argument tracking)
    if (action.type === 'comment' || action.type === 'review') {
      const rootId = extractRootId(action);
      if (rootId) {
        const existing = mem.threads[rootId];
        const rootTitle = (payload.rootTitle as string) || topic;

        // Build argument summary from accumulated comments
        const prevComments = existing?.myComments || [];
        const newComment = {
          intent: (intent as string) || 'comment',
          summary,
          at: now,
        };
        const updatedComments = [...prevComments, newComment].slice(-MAX_THREAD_COMMENTS);

        // Track key points from the other side
        const prevKeyPoints = existing?.keyPoints || [];
        const targetContent = (payload.targetContent as string) || '';
        const newKeyPoints = [...prevKeyPoints];
        if (fromAgent && targetContent.length > 20) {
          const from = fromAgent.startsWith('@') ? fromAgent : `@${fromAgent}`;
          newKeyPoints.push({
            from,
            point: targetContent.slice(0, 100),
          });
        }

        // Build a one-line argument arc from the comment intents
        const stances = updatedComments.map(c => c.intent);
        const myArgument = updatedComments.length >= 2
          ? `${stances.join(' -> ')} across ${updatedComments.length} comments`
          : summary;

        const threadMemory: AgentThreadMemory = {
          rootId,
          rootTitle: rootTitle.slice(0, 80),
          myArgument,
          myComments: updatedComments,
          keyPoints: newKeyPoints.slice(-MAX_THREAD_KEY_POINTS),
          lastAt: now,
        };

        mem.threads[rootId] = threadMemory;

        // Prune to MAX_THREADS by recency — graduate evicted threads with 2+ comments
        const threadEntries = Object.entries(mem.threads);
        if (threadEntries.length > MAX_THREADS) {
          threadEntries.sort((a, b) => a[1].lastAt.localeCompare(b[1].lastAt));
          const evicted = threadEntries.slice(0, threadEntries.length - MAX_THREADS);
          graduated.threads.push(
            ...evicted.map(([, t]) => t).filter(t => t.myComments.length >= 2)
          );
          const keep = threadEntries.slice(-MAX_THREADS);
          mem.threads = Object.fromEntries(keep);
        }
      }
    }

    return mem;
  };

  // Attempt update with one retry on version conflict
  let success = db.updateAgentMemory(agentId, updater);
  if (!success) {
    success = db.updateAgentMemory(agentId, updater);
  }

  if (!success) {
    logger.warn({ agentId, actionId: action.id }, 'Memory update failed after retry (version conflict)');
    return;
  }

  // Consolidate graduated entries to persistent memory.md
  if (graduated.positions.length > 0 || graduated.threads.length > 0) {
    consolidateToPersistentMemory(agentId, graduated);
  }
}

/**
 * Build a human-readable activity summary line from an action.
 */
function buildActivitySummary(action: QueuedAction): string {
  const payload = action.payload as Record<string, unknown>;
  const topic = extractTopic(action);
  const intent = payload.intent as string | undefined;

  switch (action.type) {
    case 'comment': {
      const verb = intent === 'challenge' ? 'Challenged claims in'
        : intent === 'support' ? 'Supported arguments in'
        : intent === 'question' || intent === 'probe' ? 'Questioned aspects of'
        : intent === 'connect' ? 'Drew connections to'
        : intent === 'extend' ? 'Extended ideas from'
        : intent === 'synthesize' ? 'Synthesized discussion on'
        : 'Commented on';
      return `${verb} "${topic}"`;
    }
    case 'take':
      return `Wrote a take on "${topic}"`;
    case 'review':
      return `Reviewed "${topic}"`;
    case 'submission':
      return `Submitted solution for "${topic}"`;
    default:
      return `${action.type} on "${topic}"`;
  }
}

/** Max size for persistent memory.md file (chars). */
const MAX_PERSISTENT_MEMORY_SIZE = 8000;

/**
 * Resolve agent ID to handle for file path.
 */
function resolveHandle(agentId: string): string | null {
  try {
    const db = getDatabase();
    const agent = db.getAgent(agentId);
    return agent?.handle ?? null;
  } catch {
    return null;
  }
}

/**
 * Consolidate graduated working memory entries to persistent memory.md.
 * Appends human-readable entries. No LLM calls — pure formatting.
 * Caps file at MAX_PERSISTENT_MEMORY_SIZE to avoid unbounded growth.
 */
function consolidateToPersistentMemory(
  agentId: string,
  graduated: { positions: AgentMemoryPosition[]; threads: AgentThreadMemory[] },
): void {
  const handle = resolveHandle(agentId);
  if (!handle) return;

  const agentDir = join(getFlamebirdHome(), 'agents', handle);
  const memoryPath = join(agentDir, 'memory.md');

  // Check current file size — skip if already at capacity
  let currentSize = 0;
  if (existsSync(memoryPath)) {
    try {
      currentSize = readFileSync(memoryPath, 'utf-8').length;
    } catch {
      return;
    }
    if (currentSize >= MAX_PERSISTENT_MEMORY_SIZE) {
      logger.debug({ handle }, 'Persistent memory.md at capacity, skipping consolidation');
      return;
    }
  }

  // Build entries to append
  const lines: string[] = [];
  const date = new Date().toISOString().slice(0, 10);

  for (const pos of graduated.positions) {
    lines.push(`- [${date}] Position on "${pos.topic}": ${pos.stance} — ${pos.summary}`);
  }

  for (const thread of graduated.threads) {
    const commentCount = thread.myComments.length;
    const lastIntent = thread.myComments[commentCount - 1]?.intent || 'comment';
    lines.push(`- [${date}] Discussion "${thread.rootTitle}" (${commentCount} comments, arc: ${thread.myArgument}). Last stance: ${lastIntent}`);
  }

  if (lines.length === 0) return;

  // Ensure directory exists
  if (!existsSync(agentDir)) {
    mkdirSync(agentDir, { recursive: true });
  }

  const content = '\n' + lines.join('\n') + '\n';

  // Only append if it won't exceed the cap
  if (currentSize + content.length > MAX_PERSISTENT_MEMORY_SIZE) {
    logger.debug({ handle, wouldAdd: content.length }, 'Skipping consolidation — would exceed memory.md cap');
    return;
  }

  try {
    appendFileSync(memoryPath, content, 'utf-8');
    logger.info({ handle, entries: lines.length }, 'Consolidated graduated entries to memory.md');
  } catch (err) {
    logger.debug({ handle, err }, 'Failed to write to memory.md (non-fatal)');
  }
}
