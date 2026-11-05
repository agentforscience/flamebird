/**
 * Site notes: private memory on agent4science that any harness can read.
 *
 * Session start: GET /agents/me/notes, keep the copy as the baseline, and put
 * the text in the persona prompt next to memory.md (truncated).
 * Session end: build a notes text from local memory (positions, changes of
 * mind, people, recent stances, memory.md) with no LLM call, and PUT it once.
 *
 * Flamebird only owns the part between its markers. Text outside them (written
 * by Claude Code, Codex or a person) is kept as is.
 *
 * Overwrite guard (decideNotesWrite):
 * - the site cannot be read at session end: skip (local stays the source of truth);
 * - the site copy changed since the session-start read (version or updatedAt): skip;
 * - the session-start read failed and the site copy is newer than the session start: skip;
 * - the managed block came from another machine and the new text is shorter: skip;
 * - nothing changed: skip.
 *
 * Any failure (401, 404, 429, network) is silent. FLAMEBIRD_SITE_NOTES=0 or
 * FLAMEBIRD_SITE_MEMORY=0 turns this off.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { hostname } from 'os';
import { join } from 'path';
import type { AgentPersona, AgentWorkingMemory } from '../types.js';
import type { SiteNotes } from '../api/agent4science-client.js';
import { getAgent4ScienceClient } from '../api/agent4science-client.js';
import { tryGetDatabase, type PositionRevisionRow, type PositionRow } from '../db/database.js';
import { getFlamebirdHome } from '../config/config.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('site-notes');

export const NOTES_MAX = 8000;
const BEGIN_RE = /<!-- flamebird:begin(?: host=([a-f0-9]+))? -->/;
const END = '<!-- flamebird:end -->';
const MIN_SECTION = 300;
const MAX_MEMORY_MD = 3000;

export interface NotesInput {
  handle: string;
  memoryMd?: string;
  working?: AgentWorkingMemory;
  positions?: PositionRow[];
  revisions?: PositionRevisionRow[];
  /** Short id of this machine, so another machine's block is not replaced by a shorter one. */
  host: string;
  now?: Date;
}

export interface NotesDecision {
  write: boolean;
  reason: string;
}

interface NotesSession {
  startedAt: Date;
  baseline: SiteNotes | null;
}

const sessions = new Map<string, NotesSession>();

function disabled(): boolean {
  return process.env.FLAMEBIRD_SITE_NOTES === '0' || process.env.FLAMEBIRD_SITE_MEMORY === '0';
}

/** Short, stable id for this machine and flamebird home (hashed: no hostname leaves the machine). */
export function machineId(): string {
  return createHash('sha256').update(`${hostname()}|${getFlamebirdHome()}`).digest('hex').slice(0, 10);
}

function normalize(n: Partial<SiteNotes> | undefined | null): SiteNotes {
  return {
    text: typeof n?.text === 'string' ? n.text : '',
    updatedAt: typeof n?.updatedAt === 'string' ? n.updatedAt : null,
    version: typeof n?.version === 'number' ? n.version : 0,
  };
}

function clip(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

/** Split site text into the flamebird block (if any) and everything else. */
export function splitNotes(text: string): { outside: string; block: string | null; host: string | null } {
  const m = BEGIN_RE.exec(text);
  if (!m) return { outside: text.trim(), block: null, host: null };
  const endAt = text.indexOf(END, m.index);
  const stop = endAt >= 0 ? endAt + END.length : text.length;
  const outside = `${text.slice(0, m.index)}${text.slice(stop)}`.replace(/\n{3,}/g, '\n\n').trim();
  return { outside, block: text.slice(m.index, stop), host: m[1] ?? null };
}

/** The flamebird block, at most `budget` chars. Deterministic for a given input. */
export function buildManagedSection(input: NotesInput, budget: number): string {
  const date = (input.now ?? new Date()).toISOString().slice(0, 10);
  const head = `<!-- flamebird:begin host=${input.host} -->\n## Flamebird memory for @${input.handle} (${date})\nWritten by flamebird at session end from local memory. Edit outside this block: it is replaced each session.`;
  const tail = `\n${END}`;
  let room = budget - head.length - tail.length;
  if (room < 50) return '';

  const sections: string[] = [];
  const add = (title: string, lines: string[]) => {
    if (!lines.length || room <= 0) return;
    let text = `\n\n### ${title}`;
    for (const line of lines) {
      const next = `\n${line}`;
      if (text.length + next.length > room) break;
      text += next;
    }
    if (text.includes('\n- ')) {
      sections.push(text);
      room -= text.length;
    }
  };

  const positions = (input.positions ?? []).filter(p => p.status === 'active');
  add('Positions (confidence the claim is true)', positions.slice(0, 20).map(p => {
    const about = p.about_type && p.about_id ? `, about ${p.about_type} ${p.about_id}` : '';
    const where = p.synced ? p.id : 'not on the site';
    return `- ${p.confidence.toFixed(2)} "${clip(p.claim, 200)}" [${where}${about}]`;
  }));

  add('Changes of mind', (input.revisions ?? []).slice(0, 10).map(r => {
    const trigger = r.trigger_type && r.trigger_id ? ` after ${r.trigger_type} ${r.trigger_id}` : '';
    return `- ${r.at.slice(0, 10)} [${r.position_id}] ${r.from_confidence.toFixed(2)} -> ${r.to_confidence.toFixed(2)}${trigger}: ${clip(r.reason, 200)}`;
  }));

  const people = Object.entries(input.working?.relationships ?? {})
    .filter(([, r]) => r && r.exchanges >= 2)
    .sort((a, b) => b[1].exchanges - a[1].exchanges || b[1].lastAt.localeCompare(a[1].lastAt) || a[0].localeCompare(b[0]))
    .slice(0, 8);
  add('People', people.map(([handle, r]) => {
    const h = handle.startsWith('@') ? handle : `@${handle}`;
    const point = r.recentExchanges?.[r.recentExchanges.length - 1]?.theirPoint;
    return `- ${h}: ${r.exchanges} exchanges, ${r.tone}, last on "${clip(r.lastTopic, 80)}"${point ? `; their point: ${clip(point, 120)}` : ''}`;
  }));

  add('Recent stances', (input.working?.positions ?? []).slice(-6).reverse().map(p =>
    `- "${clip(p.topic, 80)}": ${p.stance} (${p.confidence.toFixed(2)}). ${clip(p.summary, 140)}`));

  const md = (input.memoryMd ?? '').trim();
  if (md && room > 120) {
    const max = Math.min(room - 30, MAX_MEMORY_MD);
    const body = md.length > max ? `[...]\n${md.slice(md.length - max + 6)}` : md;
    sections.push(`\n\n### From memory.md\n${body}`);
  }

  if (!sections.length) return '';
  return `${head}${sections.join('')}${tail}`;
}

/** Full notes text: the site's own text first, then the flamebird block. At most NOTES_MAX chars. */
export function buildNotesText(siteText: string, input: NotesInput): string {
  const { outside } = splitNotes(siteText);
  const budget = NOTES_MAX - outside.length - (outside ? 2 : 0);
  if (budget < MIN_SECTION) return siteText;
  const section = buildManagedSection(input, budget);
  if (!section) return siteText;
  return outside ? `${outside}\n\n${section}` : section;
}

/** Pure overwrite guard. See the header comment. */
export function decideNotesWrite(args: {
  baseline: SiteNotes | null;
  current: SiteNotes | null;
  sessionStart: Date;
  next: string;
  host: string;
}): NotesDecision {
  const { baseline, current, sessionStart, next, host } = args;
  if (!current) return { write: false, reason: 'site notes unreachable at session end; local memory stays the source of truth' };
  if (!next.trim()) return { write: false, reason: 'nothing to write' };
  if (next.length > NOTES_MAX) return { write: false, reason: 'notes text over 8000 chars' };
  if (baseline) {
    if (current.version !== baseline.version || current.updatedAt !== baseline.updatedAt) {
      return { write: false, reason: 'site notes changed while this session ran' };
    }
  } else if (current.updatedAt) {
    const t = Date.parse(current.updatedAt);
    if (!Number.isFinite(t) || t >= sessionStart.getTime()) {
      return { write: false, reason: 'site notes are newer than this session start (start read failed)' };
    }
  }
  if (next === current.text) return { write: false, reason: 'unchanged' };
  const siteHost = splitNotes(current.text).host;
  if (next.length < current.text.length && siteHost && siteHost !== host) {
    return { write: false, reason: 'site notes come from another machine and are longer; not replacing them with a shorter local copy' };
  }
  return { write: true, reason: 'ok' };
}

/** Start a notes session: read site notes into the persona. Never throws. */
export async function beginNotesSession(agentId: string, apiKey: string, persona: AgentPersona, now = new Date()): Promise<void> {
  if (disabled()) return;
  const session: NotesSession = { startedAt: now, baseline: null };
  sessions.set(agentId, session);
  try {
    const res = await getAgent4ScienceClient().getMyNotes(apiKey);
    if (res.ok && res.data?.notes) {
      session.baseline = normalize(res.data.notes);
      if (session.baseline.text.trim()) persona.siteNotesMarkdown = session.baseline.text;
      else delete persona.siteNotesMarkdown;
    } else {
      logger.debug({ agentId, status: res.status }, 'Site notes unavailable at session start');
    }
  } catch {
    // client not initialized: continue without notes
  }
}

function readMemoryMd(handle: string, fallback?: string): string | undefined {
  try {
    const p = join(getFlamebirdHome(), 'agents', handle, 'memory.md');
    if (existsSync(p)) return readFileSync(p, 'utf-8');
  } catch {
    // fall back to what was loaded at start
  }
  return fallback;
}

/** Local inputs for the notes text. */
export function gatherNotesInput(agentId: string, handle: string, persona?: AgentPersona): NotesInput {
  const db = tryGetDatabase();
  return {
    handle,
    host: machineId(),
    memoryMd: readMemoryMd(handle, persona?.persistentMemoryMarkdown),
    working: db?.getAgentMemory(agentId),
    positions: db?.getPositions(agentId, { status: 'active', limit: 20 }) ?? [],
    revisions: db?.getPositionRevisions(agentId, { limit: 10 }) ?? [],
  };
}

/** End a notes session: write consolidated notes once if the guard allows. Never throws. */
export async function endNotesSession(agentId: string, apiKey: string, handle: string, persona?: AgentPersona): Promise<NotesDecision> {
  const session = sessions.get(agentId);
  sessions.delete(agentId);
  if (disabled()) return { write: false, reason: 'disabled' };
  if (!session) return { write: false, reason: 'no session started' };
  try {
    const client = getAgent4ScienceClient();
    const res = await client.getMyNotes(apiKey);
    const current = res.ok && res.data?.notes ? normalize(res.data.notes) : null;
    const input = gatherNotesInput(agentId, handle, persona);
    const next = buildNotesText(current?.text ?? '', input);
    const decision = decideNotesWrite({ baseline: session.baseline, current, sessionStart: session.startedAt, next, host: input.host });
    if (!decision.write) {
      logger.debug({ agentId, reason: decision.reason }, 'Skipping site notes write');
      return decision;
    }
    const put = await client.putMyNotes(apiKey, next);
    if (!put.ok) {
      logger.debug({ agentId, status: put.status }, 'Site notes write failed');
      return { write: false, reason: `write failed (${put.status})` };
    }
    logger.info({ agentId, chars: next.length }, 'Wrote site notes');
    return decision;
  } catch {
    return { write: false, reason: 'error' };
  }
}

/** End every open session (event loop shutdown). */
export async function endAllNotesSessions(
  resolve: (agentId: string) => { apiKey?: string; handle?: string; persona?: AgentPersona } | undefined,
): Promise<void> {
  for (const agentId of [...sessions.keys()]) {
    const r = resolve(agentId);
    if (r?.apiKey && r.handle) await endNotesSession(agentId, r.apiKey, r.handle, r.persona);
    else sessions.delete(agentId);
  }
}

/** For tests. */
export function clearNotesSessions(): void {
  sessions.clear();
}
