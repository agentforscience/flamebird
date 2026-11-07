/**
 * Working styles: prompt regression and behavior.
 *
 * __snapshots__/default-prompts.json was captured from the 0.1.39 code before
 * working styles existed. An agent with no workStyle, domain or settings must
 * still send exactly those prompts. The one allowed difference is the
 * soundness request added to reviews, which is stripped before comparing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../src/execution/code-sandbox.js', () => ({
  runSolverCode: vi.fn(async () => ({ success: true, solutionData: { x: [1, 2, 3] }, executionTimeMs: 5 })),
  runVerifierCode: vi.fn(async () => ({ success: true, score: 1 })),
}));

import { LLMClient, createLLMClient, REVIEW_SOUNDNESS_FIELDS, parseSoundness, type LLMMessage } from '../src/llm/llm-client.js';
import { runSolverCode, runVerifierCode } from '../src/execution/code-sandbox.js';
import { WORK_STYLES, WORK_STYLE_NAMES, harnessFor, resolveWorkSettings, parseWorkStyle } from '../src/llm/work-style.js';
import { formatSiteMemory, getSiteMemoryBlock, clearSiteMemoryCache } from '../src/utils/site-memory.js';
import { createAgent4ScienceClient } from '../src/api/agent4science-client.js';
import { RuntimeDatabase } from '../src/db/database.js';
import { buildReviewParams, buildSubmissionParams } from '../src/actions/action-executor.js';
import { workProfileFor } from '../src/llm/work-style.js';
import { applyWorkFields } from '../src/cli/utils/work-style-prompts.js';
import type { AgentPersona, SitePosition } from '../src/types.js';
import { TRUST_LINE, positionFieldLine } from '../src/llm/memory-prompts.js';
import golden from './__snapshots__/default-prompts.json';

const BODY = 'A long enough solution body. '.repeat(20);

let calls: LLMMessage[][] = [];
let verdicts: string[] = [];

function stubComplete() {
  calls = [];
  vi.spyOn(LLMClient.prototype, 'complete').mockImplementation(async (messages: LLMMessage[]) => {
    calls.push(messages.map(m => ({ ...m })));
    const sys = messages[0]?.content ?? '';
    const content = sys.includes('mathematical referee')
      ? JSON.stringify({ verdict: verdicts.shift() ?? 'correct', issues: [] })
      : sys.includes('Python optimization expert')
        ? 'import json\nprint(json.dumps({"x": [1, 2, 3]}))\n# padding padding padding'
        : JSON.stringify({ title: 'A title for this', body: BODY, approach: 'An approach summary here', summary: 'S'.repeat(1300), strengths: ['a', 'b'], weaknesses: ['c', 'd'], intent: 'challenge', confidence: 0.5, shouldAttempt: true, reason: 'r', ...(sys.includes('structured peer review') ? { soundness: 'flawed', soundnessConfidence: 0.7 } : {}) });
    return { content, model: 'stub', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  });
}

const basePersona = (extra: Partial<AgentPersona> = {}): AgentPersona => ({
  voice: 'skeptical',
  epistemics: 'rigorous',
  spiceLevel: 6,
  petPeeves: ['p-hacking'],
  preferredTopics: ['combinatorics', 'statistics'],
  catchphrases: ['Citation needed.'],
  ...extra,
});

const challenge = {
  title: 'Bound the cap set size in F_3^n',
  description: 'Give the best construction you can and prove its size.',
  tags: ['combinatorics'],
};
const subs = [
  { title: 'Greedy lift', approach: 'Lift a small cap set', body: 'Prior body one. '.repeat(10) },
  { title: 'Product construction', approach: 'Take products', body: 'Prior body two. '.repeat(10) },
];
const solverChallenge = { ...challenge, verifier: 'def evaluate(d):\n  return 1.0', solutionSchema: { type: 'object' }, scoringDirection: 'maximize', referenceScore: 2, referenceLabel: 'paper' };
const paper = { id: 'p1', title: 'A paper', abstract: 'Abstract text.', claims: ['c1', 'c2'], limitations: ['l1'], pdfUrl: 'https://x/p.pdf' };

function client() {
  createLLMClient({ provider: 'openrouter', apiKey: 'test', model: 'stub-model' });
  return new LLMClient({ provider: 'openrouter', apiKey: 'test', model: 'stub-model' });
}

/** Run every style-sensitive generator and return the prompts it sent. */
async function capturePrompts(persona: AgentPersona): Promise<Record<string, LLMMessage[][]>> {
  const llm = client();
  const out: Record<string, LLMMessage[][]> = {};

  stubComplete();
  await llm.generateSolution(persona, challenge, subs, { id: 's1', ...subs[0] }, 'skill md text');
  out.solution = calls;

  stubComplete();
  await llm.generateSolverSolution(persona, solverChallenge, [{ title: 'Greedy lift', approach: 'Lift', evaluatedScore: 1.5 }]);
  out.solver = calls;

  stubComplete();
  await llm.generateReview(persona, paper);
  out.review = calls;

  stubComplete();
  await llm.generateSubmissionCritique(persona, challenge, subs[0], subs[1], ['@a [challenge]: earlier point']);
  out.critique = calls;

  stubComplete();
  await llm.decideChallenge(persona, challenge, subs.map(s => ({ ...s, agentId: 'ag' })));
  out.decide = calls;

  stubComplete();
  await llm.generateComment(persona, { targetType: 'paper', targetContent: 'Some paper text', triggerType: 'new_content' });
  out.comment = calls;

  vi.restoreAllMocks();
  return out;
}

function withoutSoundness(prompts: Record<string, LLMMessage[][]>) {
  const copy = JSON.parse(JSON.stringify(prompts)) as Record<string, LLMMessage[][]>;
  for (const m of copy.review.flat()) m.content = m.content.replace(REVIEW_SOUNDNESS_FIELDS, '');
  return copy;
}

const allText = (msgs: LLMMessage[][]) => msgs.flat().map(m => m.content).join('\n');

beforeEach(() => {
  vi.restoreAllMocks();
  verdicts = [];
  vi.mocked(runSolverCode).mockReset().mockResolvedValue({ success: true, solutionData: { x: [1, 2, 3] }, executionTimeMs: 5 });
  vi.mocked(runVerifierCode).mockReset().mockResolvedValue({ success: true, score: 1 });
});

describe('default prompts are unchanged', () => {
  it('matches the 0.1.39 prompts byte for byte when no working style is set', async () => {
    const prompts = await capturePrompts(basePersona());
    expect(prompts.review[0][0].content).toContain(REVIEW_SOUNDNESS_FIELDS);
    expect(withoutSoundness(prompts)).toEqual(golden);
  });

  it('matches them too when settings are spelled out at their defaults', async () => {
    const prompts = await capturePrompts(basePersona({ domain: '  ', workSettings: { attempts: 1, readOthersFirst: true, selfCheck: 'normal' } }));
    expect(withoutSoundness(prompts)).toEqual(golden);
  });
});

describe('memory features keep default prompts unchanged', () => {
  const pos: SitePosition = { id: 'pos_1', claim: 'Greedy lifts never beat product constructions for n > 6', confidence: 0.8, status: 'active', about: { type: 'take', id: 't1' } };
  const record = { blindAccuracy: 0.72, citationsFound: 9, citationsTotal: 10 };

  async function takePrompt(persona: AgentPersona): Promise<string> {
    stubComplete();
    await client().generateTake(persona, paper, [{ slug: 'math', name: 'Math' }]);
    const sys = calls[0][0].content;
    vi.restoreAllMocks();
    return sys;
  }

  async function pushbackReply(persona: AgentPersona, pushback: Parameters<LLMClient['generateComment']>[1]['pushback']): Promise<LLMMessage[][]> {
    stubComplete();
    await client().generateComment(persona, { targetType: 'paper', targetContent: 'Some paper text', triggerType: 'new_content', pushback });
    const out = calls;
    vi.restoreAllMocks();
    return out;
  }

  it('is byte-identical with an empty focus, blank notes and no site positions', async () => {
    const prompts = await capturePrompts(basePersona({ focus: { topics: [' '], goal: '' }, siteNotesMarkdown: '  ' }));
    expect(withoutSoundness(prompts)).toEqual(golden);
  });

  it('a reply to pushback with no record and no positions sends the 0.1.39 comment prompt', async () => {
    expect(await pushbackReply(basePersona(), { commentId: 'c1', fromHandle: 'rival' })).toEqual(golden.comment);
    expect(await pushbackReply(basePersona({ sitePositions: [] }), { commentId: 'c1', fromRecord: { blindAccuracy: null, citationsFound: 0, citationsTotal: 0 } })).toEqual(golden.comment);
  });

  it('take and review prompts ask for a position only once the site returns positions, and only add that line', async () => {
    const plainTake = await takePrompt(basePersona());
    expect(plainTake).not.toContain('position:');
    const withTake = await takePrompt(basePersona({ sitePositions: [] }));
    expect(withTake.replace(positionFieldLine(basePersona({ sitePositions: [] }), 'take'), '')).toBe(plainTake);

    const plain = await capturePrompts(basePersona());
    const withPos = await capturePrompts(basePersona({ sitePositions: [] }));
    const line = positionFieldLine(basePersona({ sitePositions: [] }), 'review');
    expect(line).toContain('"confidence": number 0-1');
    expect(withPos.review[0][0].content.replace(line, '')).toBe(plain.review[0][0].content);
    for (const k of ['solution', 'solver', 'critique', 'decide', 'comment']) expect(withPos[k]).toEqual(plain[k]);
  });

  it('a reply to pushback shows the record, the trust line and active positions', async () => {
    const msgs = await pushbackReply(basePersona({ sitePositions: [pos] }), { commentId: 'c9', fromHandle: 'rival', fromRecord: record });
    const user = msgs[0][1].content;
    expect(user).toContain("COMMENTER'S RECORD (@rival: blind rounds 72%, citations found 9/10). " + TRUST_LINE);
    expect(user).toContain('- pos_1 (confidence 0.80): "Greedy lifts never beat product constructions for n > 6"');
    expect(user).toContain('"positionUpdate": { "positionId"');
    expect(msgs[0][0]).toEqual(golden.comment[0][0]);
    expect(user.startsWith(golden.comment[0][1].content)).toBe(true);
  });

  it('focus reaches only the attempt decision', async () => {
    const p = await capturePrompts(basePersona({ focus: { topics: ['cap sets'], goal: 'Beat the cap set record' } }));
    expect(allText(p.decide)).toContain("Your owner's current focus for you (topics: cap sets; goal: Beat the cap set record)");
    const rest = withoutSoundness(p);
    for (const k of ['solution', 'solver', 'review', 'critique', 'comment'] as const) expect(rest[k]).toEqual(golden[k]);
  });

  it('site notes land after memory.md and before the site record', async () => {
    const prompts = await capturePrompts(basePersona({ persistentMemoryMarkdown: 'local note', siteNotesMarkdown: 'notes from another harness', siteMemoryMarkdown: 'FROM YOUR RECORD test' }));
    const sys = prompts.comment[0][0].content;
    expect(sys).toContain('YOUR NOTES (private notes on agent4science');
    expect(sys.indexOf('local note')).toBeLessThan(sys.indexOf('notes from another harness'));
    expect(sys.indexOf('notes from another harness')).toBeLessThan(sys.indexOf('FROM YOUR RECORD test'));
  });
});

describe('working styles change solving and reviewing, not tone', () => {
  for (const style of WORK_STYLE_NAMES) {
    it(`${style}: solve, solver, review and critique prompts carry the style; comments do not`, async () => {
      const p = await capturePrompts(basePersona({ workStyle: style }));
      expect(allText(p.solution)).toContain(WORK_STYLES[style].solve);
      expect(allText(p.solver)).toContain(WORK_STYLES[style].code);
      expect(allText(p.review)).toContain(WORK_STYLES[style].review);
      expect(allText(p.critique)).toContain(WORK_STYLES[style].review);
      expect(p.comment).toEqual(golden.comment);
    });
  }

  it('domain expertise reaches solving, reviewing and the attempt decision', async () => {
    const p = await capturePrompts(basePersona({ domain: 'fine-grained complexity' }));
    for (const k of ['solution', 'solver', 'review', 'critique', 'decide']) {
      expect(allText(p[k])).toContain('fine-grained complexity');
    }
    expect(p.comment).toEqual(golden.comment);
  });
});

describe('working settings', () => {
  it('readOthersFirst=false hides prior submissions from both solver paths', async () => {
    const p = await capturePrompts(basePersona({ workSettings: { readOthersFirst: false } }));
    expect(allText(p.solution)).not.toContain('Existing submissions to study');
    expect(allText(p.solution)).not.toContain('BUILDING ON this prior submission');
    expect(allText(p.solver)).not.toContain('Existing submissions (scores to beat)');
    expect(allText(p.solver)).toContain('BEST PUBLIC RESULT');
  });

  it('attempts keeps going until a candidate verifies as correct', async () => {
    const llm = client();
    stubComplete();
    verdicts = ['minor_issues', 'correct', 'correct'];
    const sol = await llm.generateSolution(basePersona({ workSettings: { attempts: 3 } }), challenge, subs);
    const analyses = calls.filter(c => c[0].content.startsWith('You are a rigorous mathematician'));
    expect(analyses).toHaveLength(2);
    expect(sol).not.toBeNull();
  });

  it('selfCheck off skips verification; strict adds a strict check', async () => {
    const llm = client();
    stubComplete();
    await llm.generateSolution(basePersona({ workSettings: { selfCheck: 'off' } }), challenge, subs);
    expect(calls.some(c => c[0].content.includes('mathematical referee'))).toBe(false);

    stubComplete();
    await llm.generateSolution(basePersona({ workSettings: { selfCheck: 'strict' } }), challenge, subs);
    expect(allText(calls)).toContain('STRICT CHECK');
  });

  it('solver keeps the candidate the local verifier scores best', async () => {
    vi.mocked(runSolverCode)
      .mockResolvedValueOnce({ success: true, solutionData: { x: [1] } })
      .mockResolvedValueOnce({ success: true, solutionData: { x: [2] } });
    vi.mocked(runVerifierCode)
      .mockResolvedValueOnce({ success: true, score: 1 })
      .mockResolvedValueOnce({ success: true, score: 5 });
    const llm = client();
    stubComplete();
    const sol = await llm.generateSolverSolution(basePersona({ workSettings: { attempts: 2 } }), solverChallenge, []);
    expect(sol?.solutionData).toEqual({ x: [2] });
  });

  it('strict solver self-check retries when the local verifier rejects the output', async () => {
    vi.mocked(runVerifierCode)
      .mockResolvedValueOnce({ success: false, error: 'verifier returned inf' })
      .mockResolvedValueOnce({ success: true, score: 3 });
    const llm = client();
    stubComplete();
    const sol = await llm.generateSolverSolution(basePersona({ workSettings: { selfCheck: 'strict' } }), solverChallenge, []);
    expect(sol).not.toBeNull();
    expect(allText(calls)).toContain('Local verifier rejected the output');
  });

  it('resolves defaults and clamps attempts', () => {
    expect(resolveWorkSettings(basePersona())).toEqual({ attempts: 1, readOthersFirst: true, selfCheck: 'normal' });
    expect(resolveWorkSettings(basePersona({ workSettings: { attempts: 99 } })).attempts).toBe(5);
  });
});

describe('review soundness', () => {
  it('returns soundness and confidence from the model', async () => {
    const llm = client();
    stubComplete();
    const review = await llm.generateReview(basePersona(), paper);
    expect(review.soundness).toBe('flawed');
    expect(review.soundnessConfidence).toBe(0.7);
  });

  it('drops invalid values and clamps confidence', () => {
    expect(parseSoundness({ soundness: 'maybe' })).toEqual({});
    expect(parseSoundness({ soundness: 'Sound', soundnessConfidence: 4 })).toEqual({ soundness: 'sound', soundnessConfidence: 1 });
    expect(parseSoundness({ soundness: 'flawed' })).toEqual({ soundness: 'flawed' });
  });

  it('asks for an honest judgment without leaning toward flawed', () => {
    expect(REVIEW_SOUNDNESS_FIELDS).toContain('do not lean toward either answer');
  });
});

describe('harness record', () => {
  it('omits workStyle and domain when unset', () => {
    expect(JSON.parse(JSON.stringify(harnessFor(basePersona())))).toEqual({ attempts: 1, selfCheck: 'normal' });
  });
  it('carries style, domain and settings', () => {
    expect(harnessFor(basePersona({ workStyle: 'checker', domain: 'OR', workSettings: { attempts: 2, selfCheck: 'strict' } })))
      .toEqual({ workStyle: 'checker', domain: 'OR', attempts: 2, selfCheck: 'strict' });
  });
  it('is sent on reviews and submissions, without unset fields or local-only keys', () => {
    const review = { paperId: 'p1', title: 'A review title', paperUrl: 'u', summary: 's', strengths: ['a'], weaknesses: ['b'], soundness: 'sound' as const, soundnessConfidence: 0.6, workProfile: {} };
    const plain = JSON.parse(JSON.stringify(buildReviewParams(review as never, workProfileFor(basePersona()))));
    expect(plain.harness).toEqual({ attempts: 1, selfCheck: 'normal' });
    expect(plain).not.toHaveProperty('workProfile');
    expect(plain).toMatchObject({ soundness: 'sound', soundnessConfidence: 0.6 });

    const styled = workProfileFor(basePersona({ workStyle: 'checker', domain: 'OR', workSettings: { readOthersFirst: false } }));
    expect(buildReviewParams(review as never, styled).harness).toEqual({ workStyle: 'checker', domain: 'OR', attempts: 1, selfCheck: 'normal' });
    const sub = buildSubmissionParams({ title: 't', body: 'b', approach: 'a', workProfile: styled } as never, styled);
    expect(sub.harness).toEqual({ workStyle: 'checker', domain: 'OR', attempts: 1, selfCheck: 'normal' });
    expect(sub).not.toHaveProperty('workProfile');
  });

  it('parses style names', () => {
    expect(parseWorkStyle('none')).toBeUndefined();
    expect(parseWorkStyle('Grinder')).toBe('grinder');
    expect(() => parseWorkStyle('captain')).toThrow();
  });
});

describe('site memory', () => {
  const digest = {
    pushback: {
      unanswered: [
        { commentId: 'c1', intent: 'challenge', from: { handle: 'rival', displayName: 'R' }, excerpt: 'Your bound in step 2 fails for n=4. ' + 'x'.repeat(400), confidence: 0.8, onYour: 'post' as const, target: { type: 'take', id: 't1' }, parentId: null, createdAt: '2026-11-01', answered: false },
        { commentId: 'c2', intent: 'support', from: null, excerpt: 'Nice', confidence: null, onYour: 'post' as const, target: null, parentId: null, createdAt: '2026-11-01', answered: false },
      ],
    },
    outcomes: { submissions: [{ id: 's1', challengeId: 'ch1', challengeTitle: 'Cap sets', scoringDirection: 'maximize', evaluationStatus: 'evaluated', evaluatedScore: 2.2, createdAt: '2026-11-01' }] },
  };

  it('formats unanswered challenges and outcomes, truncated', () => {
    const block = formatSiteMemory(digest);
    expect(block).toContain('[challenge] @rival on take t1');
    expect(block).not.toContain('Nice');
    expect(block).toContain('"Cap sets": evaluated, score 2.2 (maximize)');
    expect(block.length).toBeLessThan(1600);
    expect(block).not.toContain('x'.repeat(300));
  });

  it('is empty when there is nothing to report', () => {
    expect(formatSiteMemory({})).toBe('');
    expect(formatSiteMemory(undefined)).toBe('');
  });

  describe('fetching', () => {
    afterEach(() => { vi.unstubAllGlobals(); clearSiteMemoryCache(); });

    it('continues silently on 429 and caches the miss', async () => {
      const fetchMock = vi.fn(async () => new Response('{}', { status: 429 }));
      vi.stubGlobal('fetch', fetchMock);
      createAgent4ScienceClient({ baseUrl: 'https://example.invalid' });
      expect(await getSiteMemoryBlock('ag1', 'k')).toBe('');
      expect(await getSiteMemoryBlock('ag1', 'k')).toBe('');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('continues silently on network errors', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
      createAgent4ScienceClient({ baseUrl: 'https://example.invalid' });
      expect(await getSiteMemoryBlock('ag2', 'k')).toBe('');
    });

    it('reads the raw body (with its agent key) and caches per agent', async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, agent: { id: 'ag3', handle: 'me' }, ...digest }), { status: 200, headers: { 'content-type': 'application/json' } }));
      vi.stubGlobal('fetch', fetchMock);
      createAgent4ScienceClient({ baseUrl: 'https://example.invalid' });
      const block = await getSiteMemoryBlock('ag3', 'k');
      expect(block).toContain('@rival');
      await getSiteMemoryBlock('ag3', 'k');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toBe('https://example.invalid/api/v1/agents/me/memory');
    });

    it('lands in the persona prompt after memory.md', async () => {
      const prompts = await capturePrompts(basePersona({ persistentMemoryMarkdown: 'local note', siteMemoryMarkdown: 'FROM YOUR RECORD test' }));
      const sys = prompts.comment[0][0].content;
      expect(sys.indexOf('local note')).toBeLessThan(sys.indexOf('FROM YOUR RECORD test'));
    });
  });
});

describe('local storage', () => {
  it('stores work fields with the persona, drops runtime fields, and logs attempts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flamebird-ws-'));
    try {
      const db = new RuntimeDatabase(join(dir, 'test.db'));
      const persona = basePersona({ customPersonaMarkdown: 'md', siteMemoryMarkdown: 'site' });
      db.addAgent({ id: 'ag1', handle: 'h1', displayName: 'H', persona, capability: 'base', enabled: true, createdAt: new Date() }, 'enc');
      db.updateAgentPersona('ag1', applyWorkFields(persona, { workStyle: 'grinder', domain: 'OR', workSettings: { attempts: 3, readOthersFirst: true, selfCheck: 'normal' } }));
      const saved = db.getAgent('ag1')!.persona;
      expect(saved.workStyle).toBe('grinder');
      expect(saved.workSettings).toEqual({ attempts: 3 });
      expect(saved.customPersonaMarkdown).toBeUndefined();
      expect(saved.siteMemoryMarkdown).toBeUndefined();

      db.recordWork({ agentId: 'ag1', kind: 'review', targetId: 'p1', resultId: 'r1', status: 'submitted', workStyle: 'grinder', domain: 'OR', attempts: 3, readOthersFirst: true, selfCheck: 'normal', soundness: 'sound', soundnessConfidence: 0.6 });
      const [row] = db.getWorkLog({ agentId: 'ag1' });
      expect(row).toMatchObject({ kind: 'review', work_style: 'grinder', attempts: 3, read_others_first: 1, soundness: 'sound', soundness_confidence: 0.6 });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
