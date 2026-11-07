/**
 * Method-of cards: a persona card built from a historical scientist's
 * published working methods.
 *
 * Rules (also in the card's prompt block):
 * - historical scientists only, for now: the drafter must give a year of death,
 *   and the owner confirms it;
 * - every check and move cites one of the owner's sources as [n]; the drafter
 *   may not add sources;
 * - the agent never claims to be the person, quotes them, or says what they
 *   would think;
 * - the agent's handle and display name may not contain the scientist's name.
 */

import type { CardSource, PersonaCard } from '../types.js';
import type { LLMClient } from '../llm/llm-client.js';
import { validateCard } from './archetypes.js';

export const BIO_PREFIX = 'Working method based on the published work of';

/** "Title (1945)", "doi:10.1000/x", "10.1000/x", "arXiv:2401.01234" or a URL with either. */
export function parseSource(raw: string): CardSource {
  const s = raw.trim();
  const doi = s.match(/\b(10\.\d{4,9}\/[^\s"<>]+)/)?.[1]?.replace(/[.,;)]+$/, '');
  const arxiv = s.match(/arxiv(?:\.org\/abs\/|:)\s*([0-9]{4}\.[0-9]{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})/i)?.[1];
  const year = Number(s.match(/\((\d{4})\)/)?.[1]) || undefined;
  const title = s.replace(/\s*\(\d{4}\)\s*/, ' ').trim().slice(0, 200);
  return { title, ...(year ? { year } : {}), ...(doi ? { doi } : {}), ...(arxiv ? { arxiv } : {}) };
}

/** Check a DOI or arXiv ID exists. Works without either are 'unchecked' (the owner confirms them). */
export async function checkSource(src: CardSource, fetchFn: typeof fetch = fetch): Promise<CardSource['check']> {
  try {
    if (src.doi) {
      const r = await fetchFn(`https://doi.org/api/handles/${encodeURIComponent(src.doi)}`, { signal: AbortSignal.timeout(10_000) });
      const body = await r.json().catch(() => ({})) as { responseCode?: number };
      return body.responseCode === 1 ? 'resolves' : body.responseCode === 100 ? 'no_record' : 'unchecked';
    }
    if (src.arxiv) {
      const r = await fetchFn(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(src.arxiv)}`, { signal: AbortSignal.timeout(10_000) });
      const text = await r.text();
      return /<entry>[\s\S]*<id>http/.test(text) && !/<title>Error<\/title>/.test(text) ? 'resolves' : 'no_record';
    }
  } catch { /* network: leave unchecked */ }
  return 'unchecked';
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');

/** The agent's handle or display name contains the scientist's name (any name part of 4+ letters). */
export function nameClash(scientist: string, handle: string, displayName: string): string | null {
  const parts = scientist.split(/[\s-]+/).map(norm).filter(p => p.length >= 4);
  const hay = `${norm(handle)} ${norm(displayName)}`;
  const hit = parts.find(p => hay.includes(p));
  return hit ? hit : null;
}

const DRAFT_SYSTEM = `You write "method cards": short descriptions of how a historical scientist worked, taken only from their published work.

Rules:
- Use ONLY the numbered sources the user lists. Cite each check and move with the source number in brackets, e.g. "[1]". Do not add other sources.
- Describe documented working methods: how they attacked problems, what they checked, how they argued. Not biography, not opinions, not personality.
- Never quote the scientist and never state what they believed about any topic.
- Blind spots are limits of the METHOD (what it tends to miss), not criticism of the person.
- If you are not confident the scientist has died, set "died" to null.

Respond with JSON only:
{
  "died": integer year of death, or null,
  "approach": "1-2 sentences: how this method attacks a problem",
  "alwaysChecks": ["3-5 things this method always checks, each ending with [n]"],
  "moves": ["4-6 typical moves in an argument or review, each ending with [n]"],
  "blindSpots": ["1-3 limits of the method"],
  "style": "1 sentence: writing style that fits the method (plain, no imitation of the person's voice)"
}`;

export async function draftMethodCard(llm: Pick<LLMClient, 'complete'>, scientist: string, sources: CardSource[]):
  Promise<{ card: PersonaCard } | { error: string }> {
  if (!sources.length) return { error: 'give at least one --source: a work by the scientist that documents their method' };
  const list = sources.map((s, i) => `[${i + 1}] ${s.title}${s.year ? ` (${s.year})` : ''}${s.doi ? ` doi:${s.doi}` : ''}${s.arxiv ? ` arXiv:${s.arxiv}` : ''}`).join('\n');
  const res = await llm.complete([
    { role: 'system', content: DRAFT_SYSTEM },
    { role: 'user', content: `Scientist: ${scientist}\nSources:\n${list}` },
  ], 1500);
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(res.content.match(/\{[\s\S]*\}/)?.[0] ?? '');
  } catch {
    return { error: 'the draft was not valid JSON; try again' };
  }
  const died = data.died;
  const year = new Date().getFullYear();
  if (!Number.isInteger(died) || (died as number) < 1 || (died as number) > year) {
    return { error: `only historical scientists are supported for now, and ${scientist} could not be confirmed as one` };
  }
  const slug = norm(scientist).slice(0, 40) || 'scientist';
  return validateCard({
    kind: 'method_of', id: `method-of-${slug}`, name: `Method of ${scientist}`,
    approach: data.approach, alwaysChecks: data.alwaysChecks, moves: data.moves, blindSpots: data.blindSpots ?? [], style: data.style,
    basedOn: { scientist, died, sources },
  });
}

/** Bio with the attribution line set (or removed when card is not method_of). Fits the site's 500-char limit. */
export function bioWithAttribution(bio: string | undefined, card: PersonaCard | undefined): string {
  const kept = (bio ?? '').split('\n').filter(l => !l.startsWith(BIO_PREFIX)).join('\n').trim();
  if (card?.kind !== 'method_of' || !card.basedOn) return kept;
  const n = card.basedOn.sources.length;
  const line = `${BIO_PREFIX} ${card.basedOn.scientist} (${n} source${n === 1 ? '' : 's'}). Not affiliated with them.`;
  const room = 500 - line.length - 2;
  return kept ? `${kept.slice(0, Math.max(0, room))}\n\n${line}` : line;
}
