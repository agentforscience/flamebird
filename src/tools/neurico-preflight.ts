/**
 * NeuriCo Preflight
 *
 * Cheap, shared readiness checks for the paper-generation pipeline: Docker
 * daemon reachable, Claude CLI actually logged in (not just credential file
 * presence), GitHub token still valid. Computed once and cached, rather than
 * once per agent — the underlying state (auth, daemon) is shared across every
 * NeuriCo-capability agent, so N agents independently discovering the same
 * broken precondition 5 minutes into a doomed run is pure waste.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('neurico-preflight');

export interface PreflightCheck {
  ok: boolean;
  detail: string;
}

export interface PreflightResult {
  ok: boolean;
  docker: PreflightCheck;
  claudeAuth: PreflightCheck;
  githubToken: PreflightCheck;
  checkedAt: number;
}

function checkDockerRunning(): PreflightCheck {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 10_000 });
    return { ok: true, detail: 'daemon reachable' };
  } catch {
    return { ok: false, detail: 'Docker daemon not reachable — is Docker Desktop running?' };
  }
}

function checkClaudeAuth(): PreflightCheck {
  try {
    const stdout = execSync('claude auth status --json', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
    const parsed = JSON.parse(stdout);
    if (parsed.loggedIn) {
      return { ok: true, detail: `logged in as ${parsed.email ?? 'unknown'}` };
    }
    return { ok: false, detail: 'claude auth status reports not logged in — run `claude` on host to re-authenticate' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `claude auth status failed: ${msg.slice(0, 200)}` };
  }
}

/**
 * codex/gemini don't expose an equivalent live status subcommand as of this
 * writing; fall back to the same presence-only check NeuriCo's own
 * `./neurico status` dashboard uses. Weaker guarantee than checkClaudeAuth —
 * won't catch an expired-but-present credential.
 */
function checkCliCredentialsPresent(dirName: string): PreflightCheck {
  const full = path.join(os.homedir(), dirName);
  try {
    const present = fs.existsSync(full) && fs.readdirSync(full).length > 0;
    return present
      ? { ok: true, detail: `${dirName} present (presence only, not validated)` }
      : { ok: false, detail: `${dirName} missing or empty — run the provider's login on host` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `could not check ${dirName}: ${msg}` };
  }
}

async function checkGithubToken(token?: string): Promise<PreflightCheck> {
  if (!token) return { ok: false, detail: 'GITHUB_TOKEN not set' };
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: { Authorization: `token ${token}` },
    });
    if (res.status === 401) return { ok: false, detail: 'GITHUB_TOKEN invalid or expired' };
    if (!res.ok) return { ok: false, detail: `GitHub API returned ${res.status}` };
    return { ok: true, detail: 'valid' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `could not reach GitHub API: ${msg}` };
  }
}

export interface PreflightOptions {
  githubToken?: string;
  neuricoProvider?: 'claude' | 'codex' | 'gemini';
}

export async function runNeuricoPreflight(opts: PreflightOptions): Promise<PreflightResult> {
  const docker = checkDockerRunning();
  const githubToken = await checkGithubToken(opts.githubToken);

  const provider = opts.neuricoProvider ?? 'claude';
  const claudeAuth =
    provider === 'claude'
      ? checkClaudeAuth()
      : checkCliCredentialsPresent(provider === 'codex' ? '.codex' : '.gemini');

  return {
    ok: docker.ok && claudeAuth.ok && githubToken.ok,
    docker,
    claudeAuth,
    githubToken,
    checkedAt: Date.now(),
  };
}

// ── Cache: computed once per TTL window, not once per agent ──
let cached: { result: PreflightResult; expiresAt: number } | null = null;

export async function getCachedNeuricoPreflight(
  opts: PreflightOptions,
  ttlMs = 5 * 60_000,
): Promise<PreflightResult> {
  if (cached && Date.now() < cached.expiresAt) return cached.result;

  const result = await runNeuricoPreflight(opts);
  const wasOk = cached?.result.ok;
  cached = { result, expiresAt: Date.now() + ttlMs };

  if (!result.ok && wasOk !== false) {
    logger.warn({ result }, 'NeuriCo preflight failed — new paper-gen launches paused until this passes');
  } else if (result.ok && wasOk === false) {
    logger.info('NeuriCo preflight recovered — resuming paper-gen launches');
  }
  return result;
}

/** Test-only: clear the module-level cache. */
export function resetNeuricoPreflightCache(): void {
  cached = null;
}
