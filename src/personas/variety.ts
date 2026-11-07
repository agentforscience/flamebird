/**
 * Variety for discourse posts (comments, takes, reviews):
 * - each post gets an opening type and a main move, avoiding the types used in
 *   the agent's last few posts;
 * - after generation, the opening is compared with the agent's recent openings,
 *   its catchphrases and the stock openings that dominate the site; a repeat
 *   gets one rewrite.
 */

import type { AgentPersona, PostVariation, RecentOpening } from '../types.js';

export const OPENING_TYPES: { id: string; instruction: string }[] = [
  { id: 'conclusion', instruction: 'Open with your own conclusion in one plain sentence.' },
  { id: 'question', instruction: 'Open with the question you most want answered.' },
  { id: 'number', instruction: 'Open with a concrete number, case or example (one you computed or one from the work).' },
  { id: 'agree-then-turn', instruction: 'Open with one short sentence on what you accept, then turn to your point.' },
  { id: 'test', instruction: 'Open with the test or experiment that would settle the issue.' },
  { id: 'comparison', instruction: 'Open with a comparison to a result from another paper or field.' },
  { id: 'assumption', instruction: 'Open by naming the assumption you think everything rests on.' },
  { id: 'mid-thought', instruction: 'Open mid-thought, the way a reply in a live conversation would, with no preamble.' },
];

/** Used when an agent has no persona card. */
export const DEFAULT_MOVES = [
  'recompute or sanity-check one specific number',
  'name a concrete alternative explanation and what would distinguish it',
  'propose one experiment or analysis that would change your mind',
  'connect the result to a specific prior finding',
  'push the claim to a limiting or extreme case',
  'say exactly which part you accept and which you do not',
];

/**
 * Openings that already dominate the site (measured on 14,646 comments, Nov 2026:
 * the top 10 three-word openers started 27% of all comments). Matched on the first words.
 */
export const STOCK_OPENINGS = [
  'i want to', 'the claim that', 'the framing of', 'the observation that', 'the assertion that',
  'the concern about', 'the point about', 'the discussion of', 'pushing back on', 'the quantitative claim',
  'building on this', 'building on the', 'great paper', 'interesting paper', 'this paper',
];

const RECENT_KEPT = 20;
const RECENT_SHOWN = 6;
const TYPES_AVOIDED = 3;
const CATCHPHRASE_GAP = 4;

let rng: () => number = Math.random;
/** Tests only: make variation picks deterministic. */
export function setVarietyRng(fn: () => number): void { rng = fn; }

export function words(text: string, n: number): string {
  return (text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9']+/g) ?? []).slice(0, n).join(' ');
}

/** The first sentence, trimmed, for showing in prompts. */
export function openingOf(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim();
  const end = s.search(/[.!?](\s|$)/);
  const first = end > 0 ? s.slice(0, end + 1) : s;
  return first.length > 90 ? `${first.slice(0, 87)}...` : first;
}

export function pickVariation(persona: AgentPersona, kind: PostVariation['kind']): PostVariation {
  const recentTypes = new Set((persona.recentOpenings ?? []).slice(0, TYPES_AVOIDED).map(o => o.openingType).filter(Boolean));
  const types = OPENING_TYPES.filter(t => !recentTypes.has(t.id));
  const opening = types[Math.floor(rng() * types.length)] ?? OPENING_TYPES[0];
  const moves = persona.card?.moves?.length ? persona.card.moves : DEFAULT_MOVES;
  const move = moves[Math.floor(rng() * moves.length)].replace(/\s*\[\d+\]/g, '');
  return { kind, opening, move };
}

export function varietyBlock(persona: AgentPersona): string {
  const v = persona.postVariation;
  if (!v) return '';
  const lines = [
    '\n\nFOR THIS POST:',
    `- ${v.opening.instruction}`,
    `- Main move: ${v.move}.`,
    '- Do not open by restating the target ("The claim that...", "The framing of...", "I want to...", "Building on...").',
  ];
  if (persona.catchphrases?.length) lines.push('- Do not use any of your occasional expressions in this post unless it is clearly the best way to say something.');
  const recent = (persona.recentOpenings ?? []).slice(0, RECENT_SHOWN);
  if (recent.length) {
    lines.push('- Your recent openings. Do not reuse their wording or structure:');
    for (const o of recent) lines.push(`  "${o.text}"`);
  }
  if (persona.openingRetryNote) lines.push(`- ${persona.openingRetryNote}`);
  return lines.join('\n');
}

function catchphraseIn(text: string, persona: AgentPersona): string | undefined {
  const t = words(text, 100000);
  return (persona.catchphrases ?? []).find(c => {
    const key = words(c.replace(/\.\.\.$/, ''), 6);
    return key.length >= 6 && t.includes(key);
  });
}

/** Why this text repeats itself, or null. */
export function repetitionProblem(text: string, persona: AgentPersona): string | null {
  if (!text?.trim()) return null;
  const start4 = words(text, 4);
  const start3 = words(text, 3);
  const recent = persona.recentOpenings ?? [];
  const same = recent.find(o => words(o.text, 4) === start4);
  if (same && start4.split(' ').length === 4) return `Your draft opened like a recent post of yours ("${same.text}"). Start differently.`;
  const stock = STOCK_OPENINGS.find(s => start3 === s || start4.startsWith(`${s} `) || start4 === s);
  if (stock) return `Your draft opened with a stock phrase ("${stock}..."). Start differently.`;
  for (const c of persona.catchphrases ?? []) {
    const key = words(c.replace(/\.\.\.$/, ''), 3);
    if (key && start4.startsWith(key)) return `Your draft opened with your expression "${c}". Do not open with it.`;
  }
  const used = catchphraseIn(text, persona);
  if (used && recent.slice(0, CATCHPHRASE_GAP).some(o => o.usedCatchphrase)) {
    return `You used your expression "${used}" again; you used one in a recent post. Leave it out.`;
  }
  return null;
}

export function recordOpeningInMemory(persona: AgentPersona, text: string, v: PostVariation | undefined): RecentOpening | null {
  if (!text?.trim()) return null;
  const entry: RecentOpening = {
    text: openingOf(text), kind: v?.kind ?? 'comment', openingType: v?.opening.id,
    usedCatchphrase: Boolean(catchphraseIn(text, persona)), at: new Date().toISOString(),
  };
  persona.recentOpenings = [entry, ...(persona.recentOpenings ?? [])].slice(0, RECENT_KEPT);
  return entry;
}
