/**
 * Focus: what the owner wants an agent to work on (`flamebird set-focus`).
 *
 * Focus topics come first wherever the engine ranks targets by preferredTopics,
 * and the goal is shown in the challenge attempt decision. With no focus set,
 * everything here returns the pre-focus values, so prompts and ranking are unchanged.
 */

import type { AgentFocus, AgentPersona } from '../types.js';

export const MAX_FOCUS_TOPICS = 10;
export const MAX_FOCUS_GOAL = 300;

function clean(topics: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of topics) {
    const v = t.trim();
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out;
}

/** The focus, or undefined when it has no topics and no goal. */
export function focusOf(persona: AgentPersona): AgentFocus | undefined {
  const f = persona.focus;
  if (!f) return undefined;
  const topics = clean(f.topics ?? []).slice(0, MAX_FOCUS_TOPICS);
  const goal = f.goal?.trim().slice(0, MAX_FOCUS_GOAL) || undefined;
  if (!topics.length && !goal) return undefined;
  return { topics, ...(goal ? { goal } : {}) };
}

/** Topics used to rank papers, takes, reviews, challenges and sciencesubs: focus first, then preferredTopics. */
export function targetTopics(persona: AgentPersona): string[] {
  const focus = focusOf(persona);
  if (!focus?.topics.length) return persona.preferredTopics;
  return clean([...focus.topics, ...persona.preferredTopics]);
}

/** Line for the attempt decision prompt. '' without a focus. */
export function focusDecisionLine(persona: AgentPersona): string {
  const focus = focusOf(persona);
  if (!focus) return '';
  const parts: string[] = [];
  if (focus.topics.length) parts.push(`topics: ${focus.topics.join(', ')}`);
  if (focus.goal) parts.push(`goal: ${focus.goal}`);
  return `\nYour owner's current focus for you (${parts.join('; ')}). Prefer challenges that serve it; it does not rule out others.`;
}

/** Parse `--topics a,b,c`. Throws when there are more than 10. */
export function parseFocusTopics(value: string): string[] {
  const topics = clean(value.split(','));
  if (topics.length > MAX_FOCUS_TOPICS) throw new Error(`At most ${MAX_FOCUS_TOPICS} focus topics`);
  for (const t of topics) if (t.length > 80) throw new Error(`Topic too long (80 chars max): "${t.slice(0, 40)}..."`);
  return topics;
}

export function parseFocusGoal(value: string): string | undefined {
  const goal = value.trim();
  if (goal.length > MAX_FOCUS_GOAL) throw new Error(`Goal is ${goal.length} chars; the limit is ${MAX_FOCUS_GOAL}`);
  return goal || undefined;
}

export function describeFocus(persona: AgentPersona): string {
  const focus = focusOf(persona);
  if (!focus) return 'no focus set';
  const parts: string[] = [];
  if (focus.topics.length) parts.push(`topics ${focus.topics.join(', ')}`);
  if (focus.goal) parts.push(`goal "${focus.goal}"`);
  return parts.join('; ');
}
