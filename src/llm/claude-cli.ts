/**
 * Claude CLI provider (LLM_PROVIDER=claude): runs `claude -p` on the user's
 * own Claude login instead of an API key.
 *
 * Prompts include other agents' posts, so the CLI must never be able to act
 * on the machine:
 * - every tool is disallowed and no MCP servers load;
 * - it runs from an empty temp folder;
 * - it gets only a whitelisted environment, never ANTHROPIC_API_KEY or
 *   flamebird's own keys (with ANTHROPIC_API_KEY set, the CLI would bill that
 *   key instead of the subscription).
 *
 * The prompt goes in on stdin (not argv, where `ps` shows it). Output goes to a
 * file, because piped `claude -p` output can stop at 8,000 characters.
 */

import { spawn } from 'child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const CLAUDE_BIN = process.env.FLAMEBIRD_CLAUDE_BIN || 'claude';
const TIMEOUT_MS = 300_000;

export const DISALLOWED_TOOLS = [
  'Bash', 'BashOutput', 'KillShell', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'LS',
  'WebFetch', 'WebSearch', 'Task', 'Agent', 'NotebookRead', 'NotebookEdit', 'TodoWrite', 'Skill', 'SlashCommand',
];

const ENV_WHITELIST = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM'];

/** Environment for the child: whitelisted names only, plus a dedicated Claude config dir if set. */
export function claudeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ENV_WHITELIST) if (env[k] !== undefined) out[k] = env[k];
  const config = env.FLAMEBIRD_CLAUDE_CONFIG_DIR || env.CLAUDE_CONFIG_DIR;
  if (config) out.CLAUDE_CONFIG_DIR = config;
  return out;
}

// Short names map to full IDs, because older CLI versions don't know the aliases.
const ALIASES: Record<string, string> = {
  sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-1',
};

/**
 * Model name for `claude --model`. Accepts short names (sonnet, opus, haiku,
 * fable), Claude model IDs, and OpenRouter-style names ("anthropic/claude-sonnet-4.5").
 * Anything else returns undefined, so the CLI uses its default.
 */
export function claudeModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const m = model.trim().toLowerCase().replace(/^anthropic\//, '');
  if (ALIASES[m]) return ALIASES[m];
  if (/^claude-[a-z0-9.-]+$/.test(m)) return m.replace(/\./g, '-');
  return undefined;
}

export function claudeArgs(model: string | undefined, system: string): string[] {
  const args = ['-p', '--output-format', 'json', '--permission-mode', 'default',
    '--disallowedTools', DISALLOWED_TOOLS.join(','),
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
  const m = claudeModel(model);
  if (m) args.push('--model', m);
  if (system) args.push('--append-system-prompt', system);
  return args;
}

// At most N calls at once (FLAMEBIRD_CLAUDE_CONCURRENCY, default 2), so a fleet
// of agents doesn't hit the subscription's rate limit all at once.
let running = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  const max = Math.max(1, Number(process.env.FLAMEBIRD_CLAUDE_CONCURRENCY) || 2);
  if (running >= max) await new Promise<void>(r => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

export type ClaudeResult = { content: string; promptTokens: number; completionTokens: number };

/** Parses `claude -p --output-format json` output. */
export function parseClaudeJson(raw: string): ClaudeResult {
  let data: { result?: unknown; is_error?: boolean; subtype?: string; usage?: Record<string, number> };
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Claude CLI returned non-JSON output: ${raw.slice(0, 200)}`);
  }
  if (data.is_error || typeof data.result !== 'string') {
    throw new Error(`Claude CLI error: ${String(data.result ?? data.subtype ?? 'no result').slice(0, 300)}`);
  }
  const u = data.usage || {};
  return {
    content: data.result.trim(),
    promptTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
    completionTokens: u.output_tokens || 0,
  };
}

export function runClaude(opts: { prompt: string; system: string; model?: string }): Promise<ClaudeResult> {
  return slot(() => new Promise<ClaudeResult>((resolve, reject) => {
    const dir = mkdtempSync(join(tmpdir(), 'flamebird-claude-'));
    const outPath = join(dir, 'out.json');
    const out = openSync(outPath, 'w');
    let stderr = '';
    const child = spawn(CLAUDE_BIN, claudeArgs(opts.model, opts.system), {
      cwd: dir, env: claudeEnv(), stdio: ['pipe', out, 'pipe'],
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
    child.stderr?.on('data', (d: Buffer) => { if (stderr.length < 2000) stderr += d.toString(); });
    const finish = (err: Error | null) => {
      clearTimeout(timer);
      try { closeSync(out); } catch { /* already closed */ }
      let raw = '';
      try { raw = readFileSync(outPath, 'utf8'); } catch { /* no output */ }
      rmSync(dir, { recursive: true, force: true });
      if (err) return reject(err);
      try { resolve(parseClaudeJson(raw)); } catch (e) { reject(e); }
    };
    child.on('error', (e: NodeJS.ErrnoException) => finish(new Error(
      e.code === 'ENOENT' ? `Claude CLI not found (${CLAUDE_BIN}). Install Claude Code and run \`claude\` once to log in.` : `Claude CLI error: ${e.message}`)));
    child.on('close', (code, signal) => {
      if (signal) return finish(new Error(`Claude CLI stopped (${signal}); timeout is ${TIMEOUT_MS / 1000}s`));
      // On failure the CLI usually still writes a JSON result with the reason.
      if (code !== 0) {
        let reason = stderr.trim();
        try { reason = String(JSON.parse(readFileSync(outPath, 'utf8')).result ?? reason); } catch { /* not JSON */ }
        return finish(new Error(`Claude CLI exited with code ${code}: ${reason.slice(0, 300)}`));
      }
      finish(null);
    });
    child.stdin?.end(opts.prompt);
  }));
}
