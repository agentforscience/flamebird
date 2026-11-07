import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LLMClient, createLLMClient, type LLMMessage } from '../src/llm/llm-client.js';
import { RuntimeDatabase, createDatabase } from '../src/db/database.js';
import { ARCHETYPES, archetypeCard, cardBlock, validateCard } from '../src/personas/archetypes.js';
import { OPENING_TYPES, pickVariation, repetitionProblem, setVarietyRng, varietyBlock, openingOf } from '../src/personas/variety.js';
import { bioWithAttribution, draftMethodCard, nameClash, parseSource, checkSource, BIO_PREFIX } from '../src/personas/method-of.js';
import type { AgentPersona, PersonaCard, RecentOpening } from '../src/types.js';

const persona = (extra: Partial<AgentPersona> = {}): AgentPersona => ({
  voice: 'mentor', epistemics: 'pragmatist', spiceLevel: 2, petPeeves: [], preferredTopics: ['synthesis'],
  catchphrases: ['Building on this...', 'Integrating perspectives...'], ...extra,
});
const opening = (text: string, extra: Partial<RecentOpening> = {}): RecentOpening => ({ text, kind: 'comment', at: '2026-11-06T00:00:00Z', ...extra });

function client() {
  createLLMClient({ provider: 'openrouter', apiKey: 'test', model: 'stub' });
  return new LLMClient({ provider: 'openrouter', apiKey: 'test', model: 'stub' });
}

/** Stub complete(): returns the given comment bodies in order, records prompts. */
function stub(bodies: string[]) {
  const calls: LLMMessage[][] = [];
  vi.spyOn(LLMClient.prototype, 'complete').mockImplementation(async (messages: LLMMessage[]) => {
    calls.push(messages.map(m => ({ ...m })));
    const body = bodies[Math.min(calls.length - 1, bodies.length - 1)];
    return { content: JSON.stringify({ intent: 'challenge', body, confidence: 0.6 }), model: 'stub', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  });
  return calls;
}

const longBody = (start: string) => `${start} the reported 2.75x speedup only holds on the CIFAR CNN, and the MLP shows the opposite sign, so the general claim needs a third architecture before it stands.`;

beforeEach(() => { vi.restoreAllMocks(); setVarietyRng(() => 0); delete process.env.FLAMEBIRD_VARIETY; });

describe('archetypes', () => {
  it('has 8 valid cards with no stock phrases', () => {
    expect(ARCHETYPES).toHaveLength(8);
    for (const a of ARCHETYPES) {
      const v = validateCard(archetypeCard(a.id));
      expect('card' in v, a.id).toBe(true);
    }
  });

  it('card block describes method; method-of block forbids impersonation', () => {
    const block = cardBlock(archetypeCard('grinder'));
    expect(block).toContain('HOW YOU WORK (Grinder)');
    expect(block).toContain('recompute one reported number');
    const m = cardBlock({ ...archetypeCard('grinder')!, kind: 'method_of', name: 'Method of George Pólya', basedOn: { scientist: 'George Pólya', died: 1985, sources: [{ title: 'How to Solve It', year: 1945 }] } });
    expect(m).toContain('You are NOT George Pólya');
    expect(m).toContain('[1] How to Solve It (1945)');
  });

  it('method-of cards need a source on every check and move', () => {
    const base = { kind: 'method_of', name: 'Method of X', approach: 'Tries special cases before generalizing.', style: 'Plain.',
      basedOn: { scientist: 'X Y', died: 1900, sources: [{ title: 'A book' }] } };
    expect(validateCard({ ...base, alwaysChecks: ['a [1]', 'b [1]'], moves: ['c [1]', 'd [1]', 'e [1]'] })).toHaveProperty('card');
    expect(validateCard({ ...base, alwaysChecks: ['a [1]', 'b'], moves: ['c [1]', 'd [1]', 'e [1]'] })).toHaveProperty('error');
    expect(validateCard({ ...base, alwaysChecks: ['a [1]', 'b [2]'], moves: ['c [1]', 'd [1]', 'e [1]'] })).toHaveProperty('error');
  });
});

describe('repetition check', () => {
  it('flags stock site openings, catchphrase openings and the agent\'s own recent openings', () => {
    expect(repetitionProblem('The claim that warmup helps is too broad.', persona())).toMatch(/stock phrase/);
    expect(repetitionProblem('Building on this, the result is narrow.', persona())).toMatch(/stock phrase|expression/);
    const p = persona({ recentOpenings: [opening('Warmup slows early progress at a fixed rate.')] });
    expect(repetitionProblem('Warmup slows early progress in 9 of 10 cells.', p)).toMatch(/recent post/);
    expect(repetitionProblem('Nine of ten cells show slower early progress.', p)).toBeNull();
  });

  it('allows a catchphrase mid-text only when none was used in the last 4 posts', () => {
    const text = 'Two runs disagree. Integrating perspectives from both, the effect is small.';
    expect(repetitionProblem(text, persona({ recentOpenings: [opening('A', { usedCatchphrase: false })] }))).toBeNull();
    expect(repetitionProblem(text, persona({ recentOpenings: [opening('A', { usedCatchphrase: true })] }))).toMatch(/again/);
  });

  it('picks an opening type not used in the last 3 posts', () => {
    const recent = OPENING_TYPES.slice(0, 3).map(t => opening('x', { openingType: t.id }));
    const v = pickVariation(persona({ recentOpenings: recent }), 'comment');
    expect(OPENING_TYPES.slice(0, 3).map(t => t.id)).not.toContain(v.opening.id);
  });

  it('uses the card\'s moves, without source markers', () => {
    const card = { ...archetypeCard('grinder')!, moves: ['try a special case [1]'] } as PersonaCard;
    expect(pickVariation(persona({ card }), 'review').move).toBe('try a special case');
  });

  it('openingOf keeps the first sentence', () => {
    expect(openingOf('First one. Second one.')).toBe('First one.');
  });
});

describe('generation', () => {
  it('rewrites once when the draft opens with a stock phrase, and records the opening', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-persona-'));
    const db = createDatabase(join(dir, 'db.sqlite'));
    const calls = stub([longBody('The claim that'), longBody('Nine of ten cells say otherwise:')]);
    const p = persona({ runtimeAgentId: 'agent_1' });
    const r = await client().generateComment(p, { targetType: 'paper', targetContent: 'Paper text', triggerType: 'new_content' });
    expect(calls).toHaveLength(2);
    expect(r.body.startsWith('Nine of ten')).toBe(true);
    expect(calls[1][0].content).toContain('stock phrase');
    expect(db.getRecentOpenings('agent_1')[0].text).toMatch(/^Nine of ten cells say otherwise/);
    expect(p.recentOpenings?.[0].text).toMatch(/^Nine of ten/);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the first draft when the rewrite also repeats', async () => {
    const calls = stub([longBody('The claim that'), longBody('The framing of')]);
    const r = await client().generateComment(persona(), { targetType: 'paper', targetContent: 'Paper text', triggerType: 'new_content' });
    expect(calls).toHaveLength(2);
    expect(r.body.startsWith('The claim that')).toBe(true);
  });

  it('one call when the draft is fresh; variety only in discourse prompts; card in every prompt', async () => {
    const calls = stub([longBody('Nine of ten cells say otherwise:')]);
    const p = persona({ card: archetypeCard('experimentalist') });
    await client().generateComment(p, { targetType: 'paper', targetContent: 'Paper text', triggerType: 'new_content' });
    expect(calls).toHaveLength(1);
    expect(calls[0][0].content).toContain('FOR THIS POST:');
    expect(calls[0][0].content).toContain('HOW YOU WORK (Experimentalist)');
    expect(calls[0][0].content).toContain('Occasional expressions (rare flavor only');
    expect(varietyBlock(p)).toBe('');
  });

  it('FLAMEBIRD_VARIETY=0 turns it off', async () => {
    process.env.FLAMEBIRD_VARIETY = '0';
    const calls = stub([longBody('The claim that')]);
    await client().generateComment(persona(), { targetType: 'paper', targetContent: 'Paper text', triggerType: 'new_content' });
    expect(calls).toHaveLength(1);
    expect(calls[0][0].content).not.toContain('FOR THIS POST:');
  });

  it('stores the card but not runtime fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-persona-'));
    const db = new RuntimeDatabase(join(dir, 'db.sqlite'));
    const card = archetypeCard('grinder')!;
    db.addAgent({ id: 'a1', handle: 'h1', displayName: 'H1', persona: persona(), enabled: true } as never, 'enc');
    db.updateAgentPersona('a1', persona({ card, recentOpenings: [opening('x')], runtimeAgentId: 'a1', openingRetryNote: 'n', postVariation: pickVariation(persona(), 'comment') }));
    const stored = db.getAgent('a1')!.persona;
    expect(stored.card).toEqual(card);
    for (const k of ['recentOpenings', 'runtimeAgentId', 'openingRetryNote', 'postVariation']) expect(stored).not.toHaveProperty(k);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('method-of cards', () => {
  const sources = [parseSource('How to Solve It (1945)')];
  const llm = (json: object) => ({ complete: vi.fn(async () => ({ content: JSON.stringify(json), model: 's', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } })) });
  const good = {
    died: 1985, approach: 'Understands the problem, devises a plan from related problems, carries it out, looks back.',
    alwaysChecks: ['what the unknown is [1]', 'whether every condition was used [1]', 'whether the result can be checked [1]'],
    moves: ['solve a special case first [1]', 'find a related solved problem [1]', 'work backwards from the goal [1]', 'drop a condition and see what changes [1]'],
    blindSpots: ['less suited to problems with no related precedent'], style: 'Plain, step by step.',
  };

  it('drafts a valid card from the given sources', async () => {
    const r = await draftMethodCard(llm(good), 'George Pólya', sources);
    expect(r).toHaveProperty('card');
    const card = (r as { card: PersonaCard }).card;
    expect(card.kind).toBe('method_of');
    expect(card.basedOn).toMatchObject({ scientist: 'George Pólya', died: 1985 });
  });

  it('refuses living or unconfirmed scientists', async () => {
    expect(await draftMethodCard(llm({ ...good, died: null }), 'Someone Alive', sources)).toHaveProperty('error');
    expect(await draftMethodCard(llm({ ...good, died: 2999 }), 'Someone', sources)).toHaveProperty('error');
  });

  it('refuses habits without a source', async () => {
    expect(await draftMethodCard(llm({ ...good, moves: ['a', 'b', 'c'] }), 'George Pólya', sources)).toHaveProperty('error');
  });

  it('blocks handles that use the scientist\'s name', () => {
    expect(nameClash('George Pólya', 'polya_bot', 'Problem Solver')).toBe('polya');
    expect(nameClash('George Pólya', 'special_case_first', 'Special Case First')).toBeNull();
  });

  it('parses sources and checks DOIs and arXiv IDs', async () => {
    expect(parseSource('The Design of Experiments (1935)')).toEqual({ title: 'The Design of Experiments', year: 1935 });
    expect(parseSource('doi:10.1000/xyz123.')).toMatchObject({ doi: '10.1000/xyz123' });
    expect(parseSource('arXiv:2401.01234')).toMatchObject({ arxiv: '2401.01234' });
    const fake = (body: object) => (async () => ({ json: async () => body, text: async () => '' })) as unknown as typeof fetch;
    expect(await checkSource({ title: 't', doi: '10.1/x' }, fake({ responseCode: 1 }))).toBe('resolves');
    expect(await checkSource({ title: 't', doi: '10.1/x' }, fake({ responseCode: 100 }))).toBe('no_record');
    expect(await checkSource({ title: 'A book' })).toBe('unchecked');
  });

  it('bio attribution fits 500 chars and is removed with the card', () => {
    const card = { ...archetypeCard('grinder')!, kind: 'method_of', basedOn: { scientist: 'George Pólya', died: 1985, sources } } as PersonaCard;
    const bio = bioWithAttribution('x'.repeat(600), card);
    expect(bio.length).toBeLessThanOrEqual(500);
    expect(bio).toContain(`${BIO_PREFIX} George Pólya (1 source)`);
    expect(bioWithAttribution(`Hi.\n\n${BIO_PREFIX} George Pólya (1 source). Not affiliated with them.`, undefined)).toBe('Hi.');
  });
});
