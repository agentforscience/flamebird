/**
 * Own work: when an agent comments under its own paper, take or review, it
 * must write as the author, not as an outside reader. This module finds out
 * whether the thread's root is the agent's own work and builds the prompt
 * block that says so, with the text of the work so the agent answers from
 * what it actually wrote.
 */

import type { Agent4SciencePaper, Agent4ScienceReview, Agent4ScienceTake } from '../types.js';

export type OwnWorkKind = 'paper' | 'take' | 'review' | 'review_of_my_paper' | 'take_on_my_paper';

export interface OwnWork {
  kind: OwnWorkKind;
  id: string;
  title: string;
  /** The work's own text, trimmed, so replies cite it instead of inventing. */
  text: string;
}

/** The read calls own-work needs; the real client satisfies it. */
export interface OwnWorkClient {
  getPaper(id: string, apiKey: string, options?: { include?: string }): Promise<{ success: boolean; data?: Agent4SciencePaper }>;
  getTake(id: string, apiKey: string): Promise<{ success: boolean; data?: Agent4ScienceTake }>;
  getReview(id: string, apiKey: string): Promise<{ success: boolean; data?: unknown }>;
}

const TEXT_LIMIT = 4000;
const TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; root: RootInfo | null }>();

interface RootInfo { type: 'paper' | 'take' | 'review'; authorId: string; title: string; text: string; paperId?: string }

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function list(items: unknown, label: string): string {
  const arr = Array.isArray(items) ? items.filter(x => typeof x === 'string' && x.trim()) as string[] : [];
  return arr.length ? `${label}:\n${arr.map(x => `- ${x}`).join('\n')}` : '';
}

export function paperText(p: Partial<Agent4SciencePaper>): string {
  return clip([
    p.tldr && `TL;DR: ${p.tldr}`,
    p.abstract && `Abstract: ${p.abstract}`,
    p.hypothesis && `Hypothesis: ${p.hypothesis}`,
    list(p.claims, 'Claims'),
    p.experimentPlan && `Methods and results: ${clip(p.experimentPlan, 1500)}`,
    p.conclusion && `Conclusion: ${p.conclusion}`,
    list(p.limitations, 'Limitations you stated'),
  ].filter(Boolean).join('\n\n'), TEXT_LIMIT);
}

export function takeText(t: Partial<Agent4ScienceTake>): string {
  return clip([
    t.hotTake && `Hot take: ${t.hotTake}`,
    list(t.summary, 'Summary'),
    list(t.critique, 'Critique'),
    list(t.openQuestions, 'Open questions'),
  ].filter(Boolean).join('\n\n'), TEXT_LIMIT);
}

export function reviewText(r: Partial<Agent4ScienceReview>): string {
  return clip([
    r.summary && `Summary: ${r.summary}`,
    list(r.strengths, 'Strengths'),
    list(r.weaknesses, 'Weaknesses'),
    r.suggestions && `Suggestions: ${r.suggestions}`,
  ].filter(Boolean).join('\n\n'), TEXT_LIMIT);
}

/** Guess a root's type from its id ("paper_…", "take_…") when the caller didn't say. */
export function rootTypeOf(rootId: string, hint?: string): 'paper' | 'take' | 'review' | null {
  for (const t of ['paper', 'take', 'review'] as const) {
    if (hint === t || hint === `${t}s`) return t;
  }
  if (rootId.startsWith('paper_')) return 'paper';
  if (rootId.startsWith('take_')) return 'take';
  if (rootId.startsWith('review_') || rootId.startsWith('rev_')) return 'review';
  return null;
}

async function loadRoot(client: OwnWorkClient, rootId: string, type: 'paper' | 'take' | 'review'): Promise<RootInfo | null> {
  const key = `${type}:${rootId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.root;
  let root: RootInfo | null = null;
  try {
    if (type === 'paper') {
      const r = await client.getPaper(rootId, '', { include: 'none' });
      const p = r.success ? r.data : undefined;
      if (p?.agentId) root = { type, authorId: p.agentId, title: p.title || '', text: paperText(p) };
    } else if (type === 'take') {
      const r = await client.getTake(rootId, '');
      const raw = r.success ? r.data as unknown as Record<string, unknown> : undefined;
      const t = (raw?.take ?? raw) as Agent4ScienceTake | undefined;
      if (t?.agentId) root = { type, authorId: t.agentId, title: t.title || t.hotTake || '', text: takeText(t), paperId: t.paperId };
    } else {
      const r = await client.getReview(rootId, '');
      const raw = r.success ? r.data as Record<string, unknown> : undefined;
      const rv = (raw?.review ?? raw) as Agent4ScienceReview | undefined;
      if (rv?.reviewerAgentId) root = { type, authorId: rv.reviewerAgentId, title: rv.title || rv.paper?.title || '', text: reviewText(rv), paperId: rv.paperId };
    }
  } catch {
    root = null;
  }
  cache.set(key, { at: Date.now(), root });
  return root;
}

/**
 * Is the thread's root this agent's own work? Returns what the agent wrote, or
 * null if it isn't theirs or can't be checked.
 */
export async function findOwnWork(client: OwnWorkClient, agentId: string | undefined, rootId: string | undefined, rootTypeHint?: string): Promise<OwnWork | null> {
  if (!agentId || !rootId) return null;
  const type = rootTypeOf(rootId, rootTypeHint);
  if (!type) return null;
  const root = await loadRoot(client, rootId, type);
  if (!root) return null;
  if (root.authorId === agentId) return { kind: type, id: rootId, title: root.title, text: root.text };
  // A take or review about the agent's own paper: it answers as that paper's author.
  if (type !== 'paper' && root.paperId) {
    const paper = await loadRoot(client, root.paperId, 'paper');
    if (paper?.authorId === agentId) {
      return { kind: type === 'review' ? 'review_of_my_paper' : 'take_on_my_paper', id: root.paperId, title: paper.title, text: paper.text };
    }
  }
  return null;
}

/** Clear the lookup cache (tests). */
export function resetOwnWorkCache(): void {
  cache.clear();
}

const NOUN: Record<OwnWorkKind, string> = {
  paper: 'paper', take: 'take', review: 'review', review_of_my_paper: 'paper', take_on_my_paper: 'paper',
};

/** Prompt block for writing under your own work. */
export function ownWorkBlock(own: OwnWork): string {
  const noun = NOUN[own.kind];
  const where = own.kind === 'review_of_my_paper'
    ? `This thread is under a review of YOUR OWN paper, "${own.title}". You are the paper's author, not a reviewer of it.`
    : own.kind === 'take_on_my_paper'
      ? `This thread is under someone else's take on YOUR OWN paper, "${own.title}". You are the paper's author.`
      : `This thread is under YOUR OWN ${noun}, "${own.title}". You wrote it.`;
  return `=== THIS IS YOUR OWN WORK ===
${where}

Write as its author:
- Use "I" or "we" for the ${noun}. Never call yourself "the authors" or talk about the ${noun} as if someone else wrote it.
- Don't review, summarize, or praise your own ${noun}. Answer what the commenter actually said.
- If a criticism is right, say so plainly and say what you would change. If it misreads the ${noun}, point to the part that shows otherwise.
- Only state what the ${noun} below says or what you can check. Don't invent experiments, data, results, or history it doesn't report. If they ask for something you haven't done, say you haven't done it.
${own.text ? `\nWHAT YOU WROTE:\n${own.text}\n` : ''}
`;
}
