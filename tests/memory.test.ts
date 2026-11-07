/**
 * Memory and personalization: site notes, positions, trust weighting, focus,
 * the styles report and `list --json` key masking. All site calls are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { createAgent4ScienceClient } from '../src/api/agent4science-client.js';
import { RuntimeDatabase, createDatabase, closeDatabase, type WorkLogRow } from '../src/db/database.js';
import {
  buildNotesText, decideNotesWrite, splitNotes, beginNotesSession, endNotesSession, clearNotesSessions, NOTES_MAX,
  type NotesInput,
} from '../src/utils/site-notes.js';
import { applyPositionEffects } from '../src/utils/positions.js';
import { attachSiteMemory, clearSiteMemoryCache, formatSiteMemory } from '../src/utils/site-memory.js';
import { pushbackContextFor } from '../src/utils/pushback.js';
import { formatFromRecord, parsePositionProposal, parsePositionUpdate, TRUST_LINE } from '../src/llm/memory-prompts.js';
import { targetTopics, focusDecisionLine, parseFocusTopics } from '../src/utils/focus.js';
import { summarizeWorkLog } from '../src/cli/commands/styles.js';
import { agentJsonRecord, maskApiKey } from '../src/cli/commands/list-agents.js';
import type { AgentPersona, QueuedAction, SitePosition } from '../src/types.js';

const FAKE_KEY = 'scb_test_0000000000000000wxyz';

const persona = (extra: Partial<AgentPersona> = {}): AgentPersona => ({
  voice: 'skeptical', epistemics: 'rigorous', spiceLevel: 5, petPeeves: [], preferredTopics: ['statistics'], catchphrases: [], ...extra,
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type Call = { url: string; method: string; body?: unknown; auth?: string };
function mockFetch(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const c: Call = {
      url: String(url), method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
    };
    calls.push(c);
    return handler(c);
  });
  vi.stubGlobal('fetch', fn);
  createAgent4ScienceClient({ baseUrl: 'https://example.invalid' });
  return calls;
}

let dir: string;
let db: RuntimeDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flamebird-mem-'));
  process.env.FLAMEBIRD_HOME = dir;
  db = createDatabase(join(dir, 'test.db'));
  db.addAgent({ id: 'ag1', handle: 'h1', displayName: 'H', persona: persona(), capability: 'base', enabled: true, createdAt: new Date() }, 'enc');
  clearNotesSessions();
  clearSiteMemoryCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  closeDatabase();
  delete process.env.FLAMEBIRD_HOME;
  rmSync(dir, { recursive: true, force: true });
});

// ── Notes ────────────────────────────────────────────────────────────────

const baseInput = (extra: Partial<NotesInput> = {}): NotesInput => ({
  handle: 'h1', host: 'aaaa', now: new Date('2026-11-05T12:00:00Z'),
  positions: [{ id: 'pos_1', agent_id: 'ag1', claim: 'Effect sizes in the replication are half the original', confidence: 0.4, tags: null, about_type: 'take', about_id: 't1', status: 'active', synced: 1, created_at: '', updated_at: '' }],
  revisions: [{ id: 1, agent_id: 'ag1', position_id: 'pos_1', from_confidence: 0.8, to_confidence: 0.4, reason: 'Their power analysis shows n=40 cannot detect d=0.3', trigger_type: 'comment', trigger_id: 'c1', at: '2026-11-05T10:00:00Z' }],
  working: {
    positions: [{ topic: 'Replication crisis', stance: 'skeptical', summary: 'Small n studies overclaim', sourceContentId: 'x', confidence: 0.7, updatedAt: '' }],
    relationships: { '@rival': { exchanges: 4, tone: 'challenging', lastTopic: 'power analysis', lastAt: '2026-11-04' }, '@once': { exchanges: 1, tone: 'neutral', lastTopic: 'x', lastAt: '2026-11-04' } },
    recentActivity: [],
  },
  memoryMd: '- [2026-11-01] Position on "priors": skeptical',
  ...extra,
});

describe('notes text', () => {
  it('keeps text written outside the flamebird block and replaces only the block', () => {
    const first = buildNotesText('Notes from Claude Code: check priors.', baseInput());
    expect(first.startsWith('Notes from Claude Code: check priors.')).toBe(true);
    expect(first).toContain('0.40 "Effect sizes in the replication are half the original" [pos_1, about take t1]');
    expect(first).toContain('[pos_1] 0.80 -> 0.40 after comment c1');
    expect(first).toContain('@rival: 4 exchanges');
    expect(first).not.toContain('@once');
    expect(first).toContain('### From memory.md');

    const second = buildNotesText(`${first}\n\nA later human note.`, baseInput({ positions: [] }));
    expect(second.match(/flamebird:begin/g)).toHaveLength(1);
    expect(second).toContain('Notes from Claude Code: check priors.');
    expect(second).toContain('A later human note.');
    expect(second).not.toContain('[pos_1, about');
    expect(splitNotes(second).host).toBe('aaaa');
  });

  it('never exceeds 8000 chars and leaves full foreign notes alone', () => {
    const big = buildNotesText('', baseInput({ memoryMd: 'm'.repeat(20000) }));
    expect(big.length).toBeLessThanOrEqual(NOTES_MAX);
    const full = 'x'.repeat(7900);
    expect(buildNotesText(full, baseInput())).toBe(full);
  });

  it('is deterministic', () => {
    expect(buildNotesText('a', baseInput())).toBe(buildNotesText('a', baseInput()));
  });
});

describe('notes overwrite guard', () => {
  const start = new Date('2026-11-05T09:00:00Z');
  const notes = (text: string, updatedAt: string | null, version: number) => ({ text, updatedAt, version });

  it('writes when the site copy is unchanged since session start', () => {
    const b = notes('old', '2026-11-04T00:00:00Z', 3);
    expect(decideNotesWrite({ baseline: b, current: { ...b }, sessionStart: start, next: 'new text', host: 'aaaa' }).write).toBe(true);
  });

  it('skips when the site copy changed while the session ran', () => {
    const b = notes('old', '2026-11-04T00:00:00Z', 3);
    const d = decideNotesWrite({ baseline: b, current: notes('edited elsewhere', '2026-11-05T10:00:00Z', 4), sessionStart: start, next: 'much longer local text', host: 'aaaa' });
    expect(d).toEqual({ write: false, reason: 'site notes changed while this session ran' });
  });

  it('skips when the start read failed and the site copy is newer than the session', () => {
    const d = decideNotesWrite({ baseline: null, current: notes('x', '2026-11-05T09:30:00Z', 1), sessionStart: start, next: 'y', host: 'aaaa' });
    expect(d.write).toBe(false);
    expect(decideNotesWrite({ baseline: null, current: notes('x', '2026-11-01T00:00:00Z', 1), sessionStart: start, next: 'y', host: 'aaaa' }).write).toBe(true);
  });

  it('skips when unreachable, unchanged, or a shorter copy would replace another machine\'s block', () => {
    expect(decideNotesWrite({ baseline: null, current: null, sessionStart: start, next: 'y', host: 'aaaa' }).write).toBe(false);
    const same = notes('same', null, 0);
    expect(decideNotesWrite({ baseline: same, current: same, sessionStart: start, next: 'same', host: 'aaaa' }).reason).toBe('unchanged');
    const foreign = notes('<!-- flamebird:begin host=bbbb -->\n' + 'p'.repeat(500) + '\n<!-- flamebird:end -->', '2026-11-01T00:00:00Z', 2);
    expect(decideNotesWrite({ baseline: foreign, current: foreign, sessionStart: start, next: 'short', host: 'aaaa' }).write).toBe(false);
    expect(decideNotesWrite({ baseline: foreign, current: foreign, sessionStart: start, next: 'p'.repeat(900), host: 'aaaa' }).write).toBe(true);
  });
});

describe('notes session', () => {
  it('reads notes at start into the persona and writes once at end', async () => {
    const stored = { text: 'Human note', updatedAt: '2026-11-01T00:00:00Z', version: 2 };
    const calls = mockFetch(c => {
      if (c.method === 'GET') return json({ notes: stored });
      return json({ notes: { text: (c.body as { text: string }).text, updatedAt: '2026-11-05T12:00:00Z', version: 3 } });
    });
    const p = persona();
    await beginNotesSession('ag1', FAKE_KEY, p);
    expect(p.siteNotesMarkdown).toBe('Human note');
    db.savePosition({ id: 'pos_9', agentId: 'ag1', claim: 'A claim long enough to keep', confidence: 0.6 });
    const d = await endNotesSession('ag1', FAKE_KEY, 'h1', p);
    expect(d.write).toBe(true);
    const puts = calls.filter(c => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0].url).toBe('https://example.invalid/api/v1/agents/me/notes');
    expect(puts[0].auth).toBe(`Bearer ${FAKE_KEY}`);
    const text = (puts[0].body as { text: string }).text;
    expect(text.startsWith('Human note')).toBe(true);
    expect(text).toContain('A claim long enough to keep');
    // Second end without a new session does nothing
    expect((await endNotesSession('ag1', FAKE_KEY, 'h1', p)).write).toBe(false);
  });

  it('does not write when the site copy changed during the session', async () => {
    let version = 2;
    const calls = mockFetch(() => json({ notes: { text: `v${version}`, updatedAt: `2026-11-0${version}T00:00:00Z`, version } }));
    await beginNotesSession('ag1', FAKE_KEY, persona());
    version = 3;
    const d = await endNotesSession('ag1', FAKE_KEY, 'h1');
    expect(d.reason).toBe('site notes changed while this session ran');
    expect(calls.some(c => c.method === 'PUT')).toBe(false);
  });

  it('is silent on 404, 401, 429 and network errors', async () => {
    for (const status of [404, 401, 429]) {
      const calls = mockFetch(() => json({}, status));
      const p = persona();
      await beginNotesSession('ag1', FAKE_KEY, p);
      expect(p.siteNotesMarkdown).toBeUndefined();
      expect((await endNotesSession('ag1', FAKE_KEY, 'h1')).write).toBe(false);
      expect(calls.some(c => c.method === 'PUT')).toBe(false);
    }
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await beginNotesSession('ag1', FAKE_KEY, persona());
    expect((await endNotesSession('ag1', FAKE_KEY, 'h1')).write).toBe(false);
  });
});

// ── Positions ────────────────────────────────────────────────────────────

const action = (type: QueuedAction['type'], payload: Record<string, unknown>): QueuedAction => ({
  id: 'a1', agentId: 'ag1', type, targetId: 'p1', targetType: 'paper', priority: 'normal', payload,
  createdAt: new Date(), executeAfter: new Date(), attempts: 0, maxAttempts: 3,
});

describe('positions', () => {
  it('opens a position about a posted take and mirrors it locally', async () => {
    const calls = mockFetch(c => json({ position: { id: 'pos_new', claim: (c.body as { claim: string }).claim, confidence: 0.7, status: 'active', about: (c.body as { about: unknown }).about } }));
    await applyPositionEffects(
      action('take', { position: { claim: 'Benchmark gains vanish under a fixed compute budget', confidence: 0.7 }, tags: ['ml', 'Benchmarks'] }),
      { success: true, actionId: 'a1', responseId: 'take_42' }, FAKE_KEY,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://example.invalid/api/v1/agents/me/positions');
    expect(calls[0].body).toEqual({ claim: 'Benchmark gains vanish under a fixed compute budget', confidence: 0.7, tags: ['ml', 'benchmarks'], about: { type: 'take', id: 'take_42' } });
    expect(db.getPositions('ag1')[0]).toMatchObject({ id: 'pos_new', about_type: 'take', about_id: 'take_42', synced: 1 });
  });

  it('keeps a local copy when the site has no positions endpoint yet', async () => {
    mockFetch(() => json({}, 404));
    await applyPositionEffects(action('review', { position: { claim: 'The ablation does not isolate the new loss term', confidence: 0.9 } }), { success: true, actionId: 'a1', responseId: 'rev_1' }, FAKE_KEY);
    expect(db.getPositions('ag1')[0]).toMatchObject({ synced: 0, about_type: 'review', about_id: 'rev_1' });
  });

  it('revises a position after a reply, naming the pushback comment as trigger', async () => {
    const calls = mockFetch(c => json({ position: { id: 'pos_1', claim: 'c', confidence: (c.body as { confidence: number }).confidence } }));
    db.savePosition({ id: 'pos_1', agentId: 'ag1', claim: 'Effect sizes are half the original', confidence: 0.8 });
    await applyPositionEffects(
      action('comment', { body: 'reply', parentId: 'c_parent', pushbackCommentId: 'c_push', positionUpdate: { positionId: 'pos_1', confidence: 0.5, reason: 'Their reanalysis with the preregistered exclusions halves the effect.' } }),
      { success: true, actionId: 'a1', responseId: 'c_reply' }, FAKE_KEY,
    );
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].url).toBe('https://example.invalid/api/v1/agents/me/positions/pos_1');
    expect(calls[0].body).toEqual({ confidence: 0.5, reason: 'Their reanalysis with the preregistered exclusions halves the effect.', trigger: { type: 'comment', id: 'c_push' } });
    expect(db.getPositionRevisions('ag1')[0]).toMatchObject({ from_confidence: 0.8, to_confidence: 0.5, trigger_id: 'c_push' });
  });

  it('does nothing for failed actions or payloads without position fields', async () => {
    const calls = mockFetch(() => json({}));
    await applyPositionEffects(action('take', { position: { claim: 'x'.repeat(40), confidence: 0.5 } }), { success: false, actionId: 'a1' }, FAKE_KEY);
    await applyPositionEffects(action('comment', { body: 'b' }), { success: true, actionId: 'a1' }, FAKE_KEY);
    expect(calls).toHaveLength(0);
  });

  it('validates proposals and updates', () => {
    expect(parsePositionProposal({ claim: 'short', confidence: 0.5 })).toBeUndefined();
    expect(parsePositionProposal({ claim: 'A claim with enough length', confidence: 3 })).toEqual({ claim: 'A claim with enough length', confidence: 1 });
    expect(parsePositionProposal({ claim: 'A claim with enough length' })).toBeUndefined();
    const active: SitePosition[] = [{ id: 'p1', claim: 'c', confidence: 0.8 }];
    const reason = 'The counterexample at n=7 breaks step two.';
    expect(parsePositionUpdate({ positionId: 'p2', confidence: 0.4, reason }, active)).toBeUndefined();
    expect(parsePositionUpdate({ positionId: 'p1', confidence: 0.8, reason }, active)).toBeUndefined();
    expect(parsePositionUpdate({ positionId: 'p1', confidence: 0.4, reason: 'too short' }, active)).toBeUndefined();
    expect(parsePositionUpdate({ positionId: 'p1', confidence: 0.4, reason }, active)).toEqual({ positionId: 'p1', confidence: 0.4, reason });
  });
});

// ── Site memory digest: positions and records ───────────────────────────

describe('site memory digest', () => {
  const item = { commentId: 'c1', intent: 'challenge', from: { handle: 'rival', displayName: 'R' }, excerpt: 'Step 2 fails', confidence: 0.8, onYour: 'post' as const, target: { type: 'take', id: 't1' }, parentId: null, createdAt: '2026-11-01', answered: false };

  it('shows the pusher\'s record and the trust line only when a record exists', () => {
    const withRec = formatSiteMemory({ pushback: { unanswered: [{ ...item, fromRecord: { blindAccuracy: 0.72, citationsFound: 9, citationsTotal: 10 } }] } });
    expect(withRec).toContain('[challenge] @rival on take t1 (@rival: blind rounds 72%, citations found 9/10): "Step 2 fails"');
    expect(withRec).toContain(TRUST_LINE);
    const without = formatSiteMemory({ pushback: { unanswered: [item] } });
    expect(without).not.toContain(TRUST_LINE);
    expect(formatFromRecord({ blindAccuracy: null, citationsFound: 0, citationsTotal: 0 })).toBe('');
  });

  it('sets sitePositions from the digest, and leaves it undefined on older sites', async () => {
    mockFetch(() => json({ success: true, positions: [{ id: 'pos_1', claim: 'A site position claim', confidence: 0.6, status: 'active' }] }));
    const p = persona();
    await attachSiteMemory(p, 'ag1', FAKE_KEY);
    expect(p.sitePositions?.map(x => x.id)).toEqual(['pos_1']);
    expect(db.getPositions('ag1')[0].id).toBe('pos_1');

    clearSiteMemoryCache();
    mockFetch(() => json({ success: true }));
    const old = persona();
    await attachSiteMemory(old, 'ag1', FAKE_KEY);
    expect(old.sitePositions).toBeUndefined();
  });

  it('treats only pushback intents as pushback', () => {
    expect(pushbackContextFor('c1', 'support', undefined)).toBeUndefined();
    expect(pushbackContextFor('c1', 'challenge', undefined)).toEqual({ commentId: 'c1' });
    expect(pushbackContextFor('c1', undefined, { ...item, fromRecord: { blindAccuracy: 0.5, citationsFound: 1, citationsTotal: 2 } }))
      .toEqual({ commentId: 'c1', fromHandle: 'rival', fromRecord: { blindAccuracy: 0.5, citationsFound: 1, citationsTotal: 2 } });
    expect(pushbackContextFor(undefined, 'challenge', undefined)).toBeUndefined();
  });
});

// ── Focus ────────────────────────────────────────────────────────────────

describe('focus', () => {
  it('puts focus topics ahead of preferredTopics, and changes nothing without a focus', () => {
    expect(targetTopics(persona())).toEqual(['statistics']);
    expect(targetTopics(persona({ focus: { topics: ['Cap sets', 'statistics'] } }))).toEqual(['Cap sets', 'statistics']);
    expect(focusDecisionLine(persona())).toBe('');
    expect(focusDecisionLine(persona({ focus: { topics: [], goal: '   ' } }))).toBe('');
  });

  it('parses topics and enforces the limit', () => {
    expect(parseFocusTopics(' a, b ,,a ')).toEqual(['a', 'b']);
    expect(() => parseFocusTopics(Array.from({ length: 11 }, (_, i) => `t${i}`).join(','))).toThrow();
  });

  it('is stored with the persona', () => {
    db.updateAgentPersona('ag1', persona({ focus: { topics: ['cap sets'], goal: 'g' }, siteNotesMarkdown: 'n', sitePositions: [] }));
    const saved = db.getAgent('ag1')!.persona;
    expect(saved.focus).toEqual({ topics: ['cap sets'], goal: 'g' });
    expect(saved.siteNotesMarkdown).toBeUndefined();
    expect(saved.sitePositions).toBeUndefined();
  });
});

// ── Styles report ────────────────────────────────────────────────────────

describe('styles report', () => {
  const row = (r: Partial<WorkLogRow>): WorkLogRow => ({
    id: 1, agent_id: 'ag1', kind: 'submission', target_id: 'ch1', result_id: null, status: 'submitted', work_style: null, domain: null,
    attempts: 1, read_others_first: 1, self_check: 'normal', soundness: null, soundness_confidence: null, score: null, scoring_direction: null,
    error: null, created_at: '', ...r,
  });

  it('counts by style and keeps the best score per challenge in the right direction', () => {
    const report = summarizeWorkLog([
      row({ work_style: 'grinder', score: 3, scoring_direction: 'minimize' }),
      row({ work_style: 'grinder', score: 2, scoring_direction: 'minimize' }),
      row({ work_style: 'grinder', status: 'blocked' }),
      row({ agent_id: 'ag2', score: 2.5 }),
      row({ status: 'failed' }),
      row({ kind: 'review', target_id: 'p1' }),
    ]);
    expect(report.styles.find(s => s.style === 'grinder')).toMatchObject({ attempts: 3, submitted: 2, blocked: 1, failed: 0, scored: 2 });
    expect(report.styles.find(s => s.style === 'default')).toMatchObject({ agents: 2, attempts: 2, submitted: 1, failed: 1, reviews: 1 });
    expect(report.bestScores).toEqual([{ challengeId: 'ch1', direction: 'minimize', byStyle: [{ style: 'grinder', score: 2 }, { style: 'default', score: 2.5 }] }]);
  });

  it('reads scores from the database', () => {
    db.recordWork({ agentId: 'ag1', kind: 'submission', targetId: 'ch1', resultId: 's1', status: 'submitted', workStyle: 'checker', attempts: 1, readOthersFirst: true, selfCheck: 'normal', score: 1.5, scoringDirection: 'maximize' });
    db.setWorkScore('s1', 1.75);
    expect(summarizeWorkLog(db.getAllWorkLog()).bestScores[0].byStyle).toEqual([{ style: 'checker', score: 1.75 }]);
  });
});

// ── list --json ──────────────────────────────────────────────────────────

describe('list --json', () => {
  it('masks API keys to the last 4 characters', () => {
    expect(maskApiKey(FAKE_KEY)).toBe('****wxyz');
    expect(maskApiKey('short')).toBe('****');
    const agent = db.getAgent('ag1')!;
    const rec = agentJsonRecord({ ...agent, apiKeyEncrypted: 'enc' }, { provider: 'openrouter', model: 'm' }, () => FAKE_KEY);
    expect(rec).not.toHaveProperty('apiKey');
    expect(rec.apiKeyLast4).toBe('****wxyz');
    expect(JSON.stringify(rec)).not.toContain(FAKE_KEY);
  });

  it('prints no decrypted key from the real command', async () => {
    closeDatabase();
    const envPath = join(dir, '.env');
    const dbPath = join(dir, 'data', 'runtime.db');
    mkdirSync(join(dir, 'data'), { recursive: true });
    const encryptionKey = 'test-encryption-key-0123456789';
    writeFileSync(envPath, `ENCRYPTION_KEY=${encryptionKey}\nDB_PATH=${dbPath}\n`);
    const saved = { CONFIG_PATH: process.env.CONFIG_PATH, ENCRYPTION_KEY: process.env.ENCRYPTION_KEY, DB_PATH: process.env.DB_PATH };
    process.env.CONFIG_PATH = envPath;
    process.env.ENCRYPTION_KEY = encryptionKey;
    process.env.DB_PATH = dbPath;
    try {
      const { encryptApiKey } = await import('../src/agents/agent-manager.js');
      const { resetConfigCache } = await import('../src/config/config.js');
      resetConfigCache();
      const real = createDatabase(dbPath);
      real.addAgent({ id: 'ag9', handle: 'h9', displayName: 'H9', persona: persona(), capability: 'base', enabled: true, createdAt: new Date() }, encryptApiKey(FAKE_KEY, encryptionKey));
      const out: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
      const { listAgentsCommand } = await import('../src/cli/commands/list-agents.js');
      await listAgentsCommand({ json: true });
      const printed = out.join('\n');
      const parsed = JSON.parse(printed);
      expect(parsed[0]).toMatchObject({ handle: 'h9', apiKeyLast4: '****wxyz' });
      expect(printed).not.toContain(FAKE_KEY);
      expect(printed).not.toContain('"apiKey"');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      (await import('../src/config/config.js')).resetConfigCache();
    }
  });
});
