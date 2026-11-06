import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';

const FAKE = join(__dirname, 'fixtures', 'fake-claude.sh');
const LOG = join(__dirname, 'fixtures', 'fake-claude.log');
let mod: typeof import('../src/llm/claude-cli.js');

beforeAll(async () => {
  process.env.FLAMEBIRD_CLAUDE_BIN = FAKE;
  mod = await import('../src/llm/claude-cli.js');
});

describe('claude CLI provider', () => {
  it('maps model names', () => {
    expect(mod.claudeModel('sonnet')).toBe('claude-sonnet-5-5');
    expect(mod.claudeModel('anthropic/claude-sonnet-4.5')).toBe('claude-sonnet-4-5');
    expect(mod.claudeModel('claude-haiku-5-5')).toBe('claude-haiku-5-5');
    expect(mod.claudeModel('mistral:7b')).toBeUndefined();
    expect(mod.claudeModel(undefined)).toBeUndefined();
  });

  it('passes only whitelisted env, never API keys', () => {
    const env = mod.claudeEnv({ PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'sk-ant-x', LLM_API_KEY: 'sk-or-x', A4S_KEY: 'scb_x', FLAMEBIRD_CLAUDE_CONFIG_DIR: '/cfg' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', CLAUDE_CONFIG_DIR: '/cfg' });
  });

  it('disallows every tool and loads no MCP servers', () => {
    const args = mod.claudeArgs('sonnet', 'SYS');
    const tools = args[args.indexOf('--disallowedTools') + 1];
    for (const t of ['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'Task']) expect(tools.split(',')).toContain(t);
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('{"mcpServers":{}}');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args.slice(-2)).toEqual(['--append-system-prompt', 'SYS']);
  });

  it('sends the prompt on stdin, runs in a temp dir, and reads long output in full', async () => {
    if (existsSync(LOG)) rmSync(LOG);
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-pass';
    const r = await mod.runClaude({ prompt: 'SECRET-PROMPT-TEXT', system: 'be brief', model: 'haiku' });
    delete process.env.ANTHROPIC_API_KEY;
    expect(r.content).toHaveLength(20000);
    expect(r).toMatchObject({ promptTokens: 7, completionTokens: 5 });
    const log = readFileSync(LOG, 'utf8');
    rmSync(LOG);
    expect(log).toContain('STDIN:\nSECRET-PROMPT-TEXT');
    expect(log.split('\n').find(l => l.startsWith('ARGS:'))).not.toContain('SECRET-PROMPT-TEXT');
    expect(log).toContain('--model claude-haiku-5-5');
    expect(log).not.toContain('ANTHROPIC_API_KEY');
    expect(log).toMatch(/PWD:.*flamebird-claude-/);
  });

  it('retries once with a shorter-answer note when the answer is too long', async () => {
    for (const f of [LOG, LOG + '.toolong']) if (existsSync(f)) rmSync(f);
    const r = await mod.runClaude({ prompt: 'MAKE-IT-TOO-LONG please', system: '' });
    expect(r.content).toHaveLength(20000);
    expect(readFileSync(LOG + '.toolong', 'utf8').trim().split('\n')).toHaveLength(1);
    expect(readFileSync(LOG, 'utf8')).toContain('was too long and was cut off');
    for (const f of [LOG, LOG + '.toolong']) rmSync(f);
  });

  it('reports CLI errors', () => {
    expect(() => mod.parseClaudeJson('{"is_error":true,"result":"Credit balance is too low"}')).toThrow(/Credit balance/);
    expect(() => mod.parseClaudeJson('not json')).toThrow(/non-JSON/);
  });
});
