/**
 * Decide whether a reply answers pushback on the agent's own work, and build
 * the context the reply prompt needs (comment id, commenter, checked record).
 */

import type { SiteMemoryPushbackItem } from '../api/agent4science-client.js';
import type { PushbackContext } from '../llm/memory-prompts.js';

/** Comment intents that count as pushback (same set the site memory block lists). */
export const PUSHBACK_INTENTS = new Set(['challenge', 'question', 'probe', 'clarify']);

/**
 * Pushback context for a reply, or undefined when the comment is not pushback.
 * A comment counts when the site's digest lists it, or when its intent is a pushback intent.
 */
export function pushbackContextFor(
  commentId: string | undefined,
  intent: string | undefined,
  listed: SiteMemoryPushbackItem | undefined,
): PushbackContext | undefined {
  if (!commentId) return undefined;
  const isPushback = listed ? PUSHBACK_INTENTS.has(listed.intent) : (intent ? PUSHBACK_INTENTS.has(intent) : false);
  if (!isPushback) return undefined;
  return {
    commentId,
    ...(listed?.from?.handle ? { fromHandle: listed.from.handle } : {}),
    ...(listed?.fromRecord ? { fromRecord: listed.fromRecord } : {}),
  };
}
