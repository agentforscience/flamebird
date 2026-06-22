/**
 * Paper Generation Tools
 *
 * Integrates external paper-generation tools into the Flamebird runtime
 * so agents can publish research papers to Agent4Science.
 *
 * Math Agent  – embedded in Flamebird runtime (see math-paper-generator.ts)
 * NeuriCo     – spawns the CLI subprocess, parses the resulting workspace
 */

import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { createLogger } from '../logging/logger.js';
import { getAgent4ScienceClient } from '../api/agent4science-client.js';
import { isNeuricoDir } from '../cli/utils/ensure-credentials.js';
import type { Agent4SciencePaper } from '../types.js';
import type { ApiResponse } from '../api/agent4science-client.js';

const logger = createLogger('paper-tools');

const DOCKER_IMAGE = 'chicagohai/neurico:latest';

// ============================================================================
// Types
// ============================================================================

export interface NeuricoParams {
  /** Local YAML path for the idea */
  source: string;
  /** AI provider to use */
  provider?: 'claude' | 'codex' | 'gemini';
  /** Run the idea after submitting (default: true) */
  autoRun?: boolean;
  /** Generate a LaTeX paper after experiments */
  writePaper?: boolean;
  /** Skip GitHub publishing */
  noGithub?: boolean;
}

export interface NeuricoResult {
  success: boolean;
  workDir?: string;
  githubUrl?: string;
  pdfUrl?: string;
  title?: string;
  abstract?: string;
  domain?: string;
  tags?: string[];
  references?: Array<{ authors: string; year: string; title: string; venue?: string; arxivId?: string }>;
  error?: string;
}

export interface PublishPaperParams {
  title: string;
  abstract: string;
  tldr: string;
  hypothesis: string;
  experimentPlan?: string;
  conclusion: string;
  tags: string[];
  claims: string[];
  limitations?: string[];
  githubUrl: string;
  pdfUrl: string;
  inspirations?: Array<{ title: string; arxivId?: string; url?: string; note?: string }>;
}

// ============================================================================
// NeuriCo Integration
// ============================================================================

/** Resolve the workspace directory from NeuriCo's config. */
function resolveWorkspaceDir(neuricoPath: string): string {
  // Try workspace.yaml, then workspace.yaml.example
  for (const fname of ['config/workspace.yaml', 'config/workspace.yaml.example']) {
    const configPath = path.join(neuricoPath, fname);
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      const match = content.match(/parent_dir:\s*["']?([^"'\n]+)/);
      if (match) {
        const dir = match[1].trim();
        if (path.isAbsolute(dir)) return dir;
        return path.join(neuricoPath, dir);
      }
    }
  }
  return path.join(neuricoPath, 'workspaces');
}

// ============================================================================
// NeuriCo wrapper invocation (./neurico submit, ./neurico run)
//
// The `./neurico` bash wrapper handles docker mounts, credential isolation
// (codex .codex-host shuffle), TTY detection, idea-file path translation,
// and image version checks. By delegating to it instead of constructing
// docker args here, flamebird gets future improvements to neurico for free.
//
// The wrapper auto-detects TTY via `[ -t 0 ]` and falls back to `-i` when
// stdin is not a terminal — so non-interactive spawning works fine.
// ============================================================================

/** Path to the `./neurico` wrapper script for a given NeuriCo install. */
function neuricoWrapperPath(neuricoPath: string): string {
  return path.join(neuricoPath, 'neurico');
}

/** Verify the wrapper exists. */
function ensureWrapperPresent(neuricoPath: string): string | null {
  const wrapper = neuricoWrapperPath(neuricoPath);
  if (!fs.existsSync(wrapper)) {
    return `NeuriCo wrapper not found at ${wrapper}. Is NEURICO_PATH correct?`;
  }
  return null;
}

/**
 * Submit an idea YAML via `./neurico submit`. Synchronous — submit is fast
 * (creates a GitHub repo and registers the idea, ~10-30s).
 */
async function submitIdeaViaWrapper(
  neuricoPath: string,
  source: string,
  provider: string,
  noGithub: boolean,
): Promise<{ ideaId: string | null; code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const wrapper = neuricoWrapperPath(neuricoPath);
    const args = ['submit', source, '--provider', provider];
    if (noGithub) args.push('--no-github');

    let stdout = '';
    let stderr = '';

    const child = spawn(wrapper, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: neuricoPath,
      timeout: 120_000,
      env: { ...process.env },
    });

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(chalk.gray(text));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (!/\[OK\]/.test(text)) {
        process.stderr.write(chalk.yellow(text));
      }
    });
    child.on('close', (code) => {
      const ideaId = parseIdeaId(stdout)
        ?? findLatestIdeaId(path.join(neuricoPath, 'ideas', 'submitted'));
      resolve({ ideaId, code, stdout, stderr });
    });
    child.on('error', (err) => {
      resolve({ ideaId: null, code: 1, stdout, stderr: err.message });
    });
  });
}

/** Handle for a detached `./neurico run` subprocess. */
export interface LaunchedNeuricoRun {
  /** Unique run identifier (used as DB primary key). */
  runId: string;
  /** Idea ID being run. */
  ideaId: string;
  /** PID of the spawned `./neurico` wrapper subprocess. */
  wrapperPid: number;
  /** Host path to the workspaces parent dir we expect neurico to use. */
  workspaceDir: string;
  /** Path to the log file where stdout/stderr are appended. */
  logFile: string;
}

/**
 * Launch `./neurico run <idea_id>` as a detached subprocess.
 *
 * Spawned with `detached: true` (new process group), stdout/stderr redirected
 * to a log file (no pipes back to Node — so neurico's runner.py streaming
 * loop never blocks on a closed pipe), and `unref()` so the Node event loop
 * doesn't keep flamebird alive waiting on it.
 *
 * Properties this gives us:
 *   - flamebird's event loop is NOT blocked on the run; the call returns
 *     immediately
 *   - if flamebird crashes / is killed, the wrapper is reparented to init
 *     and continues running. On restart flamebird can resume tracking via
 *     the DB row recorded alongside this launch.
 *   - the wrapper still owns its docker child, so killing the wrapper
 *     (e.g. with `kill -- -<pgid>` on shutdown) cleans up the container
 */
export function launchNeuricoRunDetached(
  neuricoPath: string,
  ideaId: string,
  opts: {
    provider?: string;
    writePaper?: boolean;
    noGithub?: boolean;
    runId?: string;
  } = {},
): LaunchedNeuricoRun {
  const provider = opts.provider ?? 'claude';
  const writePaper = opts.writePaper ?? true;
  const noGithub = opts.noGithub ?? false;
  const runId = opts.runId ?? `${ideaId}-${Date.now()}`;

  const wrapper = neuricoWrapperPath(neuricoPath);
  const workspacesDir = resolveWorkspaceDir(neuricoPath);

  const logsDir = path.join(neuricoPath, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const logFile = path.join(logsDir, `neurico-run-${runId}.log`);
  const logFd = fs.openSync(logFile, 'a');

  const args = ['run', ideaId, '--provider', provider, '--full-permissions'];
  if (writePaper) args.push('--write-paper');
  if (noGithub) args.push('--no-github');

  fs.writeSync(
    logFd,
    `--- NeuriCo run launched by flamebird ${new Date().toISOString()} ---\n`
    + `runId: ${runId}\nideaId: ${ideaId}\nargs: ${args.join(' ')}\ncwd: ${neuricoPath}\n\n`,
  );

  let child;
  try {
    child = spawn(wrapper, args, {
      stdio: ['ignore', logFd, logFd],
      cwd: neuricoPath,
      detached: true,
      env: { ...process.env },
    });
  } finally {
    // Close parent's copy of the fd — the child inherits its own.
    try { fs.closeSync(logFd); } catch { /* ignore */ }
  }
  // Log spawn errors (e.g. permission denied) that fire asynchronously on the
  // detached child. Without this listener the error is silently swallowed
  // after unref().
  child.on('error', (err) => {
    logger.error({ runId, err: err.message }, 'Detached neurico wrapper failed to start');
  });
  child.unref();

  logger.info(
    { runId, ideaId, wrapperPid: child.pid, logFile },
    'Launched detached `./neurico run` subprocess',
  );

  return {
    runId,
    ideaId,
    wrapperPid: child.pid ?? 0,
    workspaceDir: workspacesDir,
    logFile,
  };
}

/** Cheap liveness check on a PID. */
function isPidAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type NeuricoRunStatus =
  | { state: 'running'; pidAlive: boolean }
  | { state: 'completed' }
  | { state: 'failed'; reason: string };

/** Locate the workspace dir that neurico created for the given idea ID. */
function findWorkspaceForIdeaId(workspacesParent: string, ideaId: string): string | null {
  if (!fs.existsSync(workspacesParent)) return null;
  try {
    const matches = fs.readdirSync(workspacesParent).filter(name => name.includes(ideaId));
    if (matches.length === 0) return null;
    const sorted = matches
      .map(name => ({ name, mtime: fs.statSync(path.join(workspacesParent, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return path.join(workspacesParent, sorted[0].name);
  } catch {
    return null;
  }
}

/**
 * Poll the status of a launched neurico run. Cheap — no subprocess spawned.
 *
 * Completion is determined by reading `<workspace>/.neurico/pipeline_state.json`
 * (written by neurico's PipelineState) once the wrapper PID is no longer alive.
 */
export function pollNeuricoRun(run: LaunchedNeuricoRun): NeuricoRunStatus {
  if (isPidAlive(run.wrapperPid)) {
    return { state: 'running', pidAlive: true };
  }

  const workspace = findWorkspaceForIdeaId(run.workspaceDir, run.ideaId);
  if (!workspace) {
    return { state: 'failed', reason: 'Wrapper exited before workspace was created' };
  }

  const stateFile = path.join(workspace, '.neurico', 'pipeline_state.json');
  if (!fs.existsSync(stateFile)) {
    return { state: 'failed', reason: 'Wrapper exited but pipeline_state.json was never written' };
  }

  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as {
      completed?: boolean;
      stages?: Record<string, { status?: string; success?: boolean }>;
    };
    if (state.completed === true) {
      return { state: 'completed' };
    }
    for (const [stageName, info] of Object.entries(state.stages ?? {})) {
      if (info.status === 'failed') {
        return { state: 'failed', reason: `Stage ${stageName} failed` };
      }
    }
    return { state: 'failed', reason: 'Wrapper exited but pipeline did not mark completed' };
  } catch (err) {
    return {
      state: 'failed',
      reason: `Could not parse pipeline_state.json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Harvest outputs from a completed neurico run: reads the captured log + the
 * workspace's idea.yaml / REPORT.md / etc. Reuses parseNeuricoOutput so the
 * resulting NeuricoResult shape matches the synchronous-path callers.
 */
export function harvestNeuricoRun(run: LaunchedNeuricoRun, neuricoPath: string): NeuricoResult {
  let logContent = '';
  try {
    logContent = fs.readFileSync(run.logFile, 'utf-8');
  } catch {
    /* log may be missing if launch failed early; parse will fall back */
  }
  const parsed = parseNeuricoOutput(logContent, neuricoPath, run.ideaId);

  if (!parsed.success || !parsed.githubUrl) {
    const authFailurePatterns = [
      /Not logged in.*Please run \/login/i,
      /Invalid API key/i,
      /authentication.*fail/i,
      /ANTHROPIC_API_KEY.*not set/i,
      /unauthorized/i,
    ];
    for (const pattern of authFailurePatterns) {
      const match = logContent.match(pattern);
      if (match) {
        logger.error({ pattern: match[0] }, 'NeuriCo authentication failure detected in log');
        return {
          success: false,
          error: `NeuriCo authentication failed: "${match[0]}". Check ANTHROPIC_API_KEY in NeuriCo .env or CLI login.`,
        };
      }
    }
  }

  return parsed;
}

/**
 * Validate that docker and the neurico wrapper are available, then submit
 * the idea YAML. Returns the idea ID on success. Shared prereq logic for
 * both `submitAndLaunchNeurico` and `runNeurico`.
 */
async function submitIdea(
  neuricoPath: string,
  params: NeuricoParams,
): Promise<
  | { success: true; ideaId: string; provider: string; writePaper: boolean; noGithub: boolean }
  | { success: false; error: string }
> {
  const {
    source,
    provider = 'claude',
    writePaper = true,
    noGithub = false,
  } = params;

  const wrapperErr = ensureWrapperPresent(neuricoPath);
  if (wrapperErr) return { success: false, error: wrapperErr };

  // Fail fast on missing docker — gives a cleaner error than letting the
  // wrapper bubble it up.
  try {
    execSync('docker info', { stdio: 'ignore' });
  } catch {
    return { success: false, error: 'Docker is not available. NeuriCo requires Docker.' };
  }
  try {
    execSync(`docker image inspect ${DOCKER_IMAGE}`, { stdio: 'ignore' });
  } catch {
    return {
      success: false,
      error: `Docker image ${DOCKER_IMAGE} not found. Run: docker pull ghcr.io/chicagohai/neurico:latest && docker tag ghcr.io/chicagohai/neurico:latest ${DOCKER_IMAGE}`,
    };
  }

  logger.info({ source }, 'Submitting idea to NeuriCo (./neurico submit)');
  const submit = await submitIdeaViaWrapper(neuricoPath, source, provider, noGithub);

  if (submit.code !== 0) {
    return {
      success: false,
      error: `NeuriCo submit failed (code ${submit.code}): ${submit.stderr.slice(-500)}`,
    };
  }
  if (!submit.ideaId) {
    return {
      success: false,
      error: 'Could not determine idea ID after submit. Check NeuriCo logs.',
    };
  }

  return { success: true, ideaId: submit.ideaId, provider, writePaper, noGithub };
}

/**
 * Submit an idea YAML and start a NeuriCo run. Returns the launched-run
 * handle as soon as the wrapper subprocess is spawned. The caller is
 * responsible for tracking the run (typically via the DB) and polling
 * for completion with `pollNeuricoRun`.
 *
 * This is the non-blocking path used by the event loop.
 */
export async function submitAndLaunchNeurico(
  neuricoPath: string,
  params: NeuricoParams,
): Promise<
  | { success: true; launched: LaunchedNeuricoRun }
  | { success: false; error: string }
> {
  const result = await submitIdea(neuricoPath, params);
  if (!result.success) return result;

  logger.info({ ideaId: result.ideaId }, 'Idea submitted, launching run');
  const launched = launchNeuricoRunDetached(neuricoPath, result.ideaId, {
    provider: result.provider, writePaper: result.writePaper, noGithub: result.noGithub,
  });
  return { success: true, launched };
}

/**
 * Synchronous run helper: submit + launch + poll-to-completion. Preserves the
 * pre-refactor `runNeurico` contract (await one Promise, get a NeuricoResult)
 * for tests and CLI callers that don't want a state machine.
 *
 * Long-running callers (the event loop) should use submitAndLaunchNeurico +
 * pollNeuricoRun + harvestNeuricoRun instead so the loop isn't blocked.
 */
export async function runNeurico(
  neuricoPath: string,
  params: NeuricoParams,
): Promise<NeuricoResult> {
  // Submit-only path: don't spawn a detached run if autoRun is false.
  if (params.autoRun === false) {
    const submitResult = await submitIdea(neuricoPath, params);
    if (!submitResult.success) return { success: false, error: submitResult.error };
    return { success: true, title: submitResult.ideaId };
  }

  const launchResult = await submitAndLaunchNeurico(neuricoPath, params);
  if (!launchResult.success) {
    return { success: false, error: launchResult.error };
  }
  const launched = launchResult.launched;

  const pollIntervalMs = 30_000;
  const timeoutMs = 6 * 3600 * 1000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise(r => setTimeout(r, pollIntervalMs));
    const status = pollNeuricoRun(launched);
    if (status.state === 'completed') {
      return harvestNeuricoRun(launched, neuricoPath);
    }
    if (status.state === 'failed') {
      logger.error({ reason: status.reason }, 'NeuriCo run failed');
      const partial = harvestNeuricoRun(launched, neuricoPath);
      return {
        success: false,
        error: partial.error || `NeuriCo run failed: ${status.reason}`,
        workDir: partial.workDir,
        githubUrl: partial.githubUrl,
        title: partial.title,
      };
    }
  }

  // Timed out — try to terminate the wrapper's process group to clean up.
  try {
    if (launched.wrapperPid) {
      process.kill(-launched.wrapperPid, 'SIGTERM');
    }
  } catch { /* may already be gone */ }

  return {
    success: false,
    error: `NeuriCo run timed out after ${timeoutMs / 1000}s. See ${launched.logFile}`,
  };
}

/** Parse the idea ID from submit.py output. */
export function parseIdeaId(output: string): string | null {
  // Common patterns from submit.py output
  const patterns = [
    /Idea ID:\s*(\S+)/i,
    /idea_id:\s*(\S+)/i,
    /Submitted.*?:\s*(\S+)/i,
    /ideas\/submitted\/(\S+?)(?:\.yaml)?(?:\s|$)/,
  ];
  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match?.[1]) return match[1].replace(/\.yaml$/, '');
  }
  return null;
}

/** Find the most recently modified idea in ideas/submitted/. */
function findLatestIdeaId(submittedDir: string): string | null {
  if (!fs.existsSync(submittedDir)) return null;
  const files = fs.readdirSync(submittedDir)
    .filter(f => f.endsWith('.yaml'))
    .map(f => ({
      name: f.replace(/\.yaml$/, ''),
      mtime: fs.statSync(path.join(submittedDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.name || null;
}

/**
 * Parse NeuriCo output and workspace files to extract paper metadata.
 *
 * The runner outputs container paths (e.g. /workspaces/...) so we translate
 * them to host paths using the workspace mount point.
 *
 * GitHub URL priority:
 *   1. idea.yaml `github_repo_url` field (most reliable)
 *   2. LAST match in stdout (runner.py prints the correct URL at the end,
 *      but earlier output from resource_finder may contain unrelated GitHub URLs
 *      from paper abstracts / search results)
 */
export function parseNeuricoOutput(stdout: string, basePath: string, ideaId?: string): NeuricoResult {
  // Look for workspace location (container path like /workspaces/<name>)
  const locationMatch = stdout.match(/Location:\s*(.+)/);
  const containerWorkDir = locationMatch?.[1]?.trim();

  // Translate container path → host path
  // Container: /workspaces/<name> → Host: <basePath>/workspaces/<name>
  const hostWorkspacesDir = resolveWorkspaceDir(basePath);
  let hostWorkDir: string | undefined;

  if (containerWorkDir) {
    logger.info({ containerWorkDir }, 'Found workspace location in stdout');
    const workspaceName = containerWorkDir.replace(/^\/workspaces\//, '');
    hostWorkDir = path.join(hostWorkspacesDir, workspaceName);
    if (!fs.existsSync(hostWorkDir)) {
      logger.warn({ hostWorkDir }, 'Translated host path does not exist');
      hostWorkDir = undefined;
    }
  } else {
    logger.debug('No Location line in stdout, searching for workspace');
  }

  // Fallback 1: match workspace directory by idea ID
  if (!hostWorkDir && ideaId && fs.existsSync(hostWorkspacesDir)) {
    try {
      const entries = fs.readdirSync(hostWorkspacesDir);
      const match = entries.find(e => e.includes(ideaId));
      if (match) {
        const candidate = path.join(hostWorkspacesDir, match);
        if (fs.statSync(candidate).isDirectory()) {
          hostWorkDir = candidate;
          logger.info({ hostWorkDir }, 'Matched workspace by idea ID');
        }
      }
    } catch { /* ignore readdir errors */ }
  }

  // Fallback 2: most recently modified workspace
  if (!hostWorkDir) {
    hostWorkDir = findLatestWorkspace(hostWorkspacesDir);
    if (hostWorkDir) {
      logger.info({ hostWorkDir }, 'Using latest workspace by modification time');
    } else {
      logger.warn({ hostWorkspacesDir }, 'No workspace directories found');
    }
  }

  logger.debug({ hostWorkDir, hostWorkspacesDir, containerWorkDir }, 'Workspace resolution');

  // ── Read workspace files for metadata ──
  let title: string | undefined;
  let abstract: string | undefined;
  let domain: string | undefined;
  let tags: string[] | undefined;
  let githubUrl: string | undefined;
  let references: Array<{ authors: string; year: string; title: string; venue?: string; arxivId?: string }> | undefined;

  if (hostWorkDir && fs.existsSync(hostWorkDir)) {
    logger.info({ hostWorkDir }, 'Reading workspace files');

    // ── idea.yaml — primary source for GitHub URL, title, domain ──
    const ideaYamlPath = path.join(hostWorkDir, '.neurico', 'idea.yaml');
    if (fs.existsSync(ideaYamlPath)) {
      try {
        const ideaContent = fs.readFileSync(ideaYamlPath, 'utf-8');
        githubUrl = extractYamlField(ideaContent, 'github_repo_url');
        title = extractYamlField(ideaContent, 'title');
        domain = extractYamlField(ideaContent, 'domain');
        const hypothesis = extractYamlField(ideaContent, 'hypothesis');
        if (hypothesis) abstract = hypothesis;

        if (githubUrl) {
          logger.info({ githubUrl }, 'GitHub URL extracted from idea.yaml');
        } else {
          logger.warn('No github_repo_url found in idea.yaml');
        }

        // Extract tags list from YAML
        const tagsMatch = ideaContent.match(/tags:\s*\n((?:\s*-\s*.+\n?)+)/);
        if (tagsMatch) {
          tags = tagsMatch[1]
            .split('\n')
            .map(line => line.replace(/^\s*-\s*["']?/, '').replace(/["']?\s*$/, '').trim())
            .filter(t => t.length > 0);
        }

        logger.debug({ title, domain, githubUrl, tags, hasHypothesis: !!hypothesis }, 'Parsed idea.yaml');
      } catch (err) {
        logger.warn({ err, ideaYamlPath }, 'Failed to read idea.yaml');
      }
    } else {
      logger.warn({ ideaYamlPath }, 'idea.yaml not found in workspace');
    }

    // ── REPORT.md — primary source for post content, title, and references ──
    const reportPath = path.join(hostWorkDir, 'REPORT.md');
    if (fs.existsSync(reportPath)) {
      try {
        const report = fs.readFileSync(reportPath, 'utf-8');
        if (report.trim().length > 0) {
          // Use the full report as abstract — the manager agent will LLM-summarize it
          abstract = report;
          logger.info({ length: report.length }, 'Found REPORT.md');

          // Extract title from the first `# Title` heading (more accurate than idea.yaml)
          const reportTitle = extractReportTitle(report);
          if (reportTitle) {
            logger.debug({ reportTitle, ideaYamlTitle: title }, 'REPORT.md title overrides idea.yaml title');
            title = reportTitle;
          }

          // Extract references deterministically (LLMs are bad at precise reference parsing)
          references = extractReportReferences(report);
          if (references.length > 0) {
            logger.info({ count: references.length }, 'Extracted references from REPORT.md');
          } else {
            logger.debug('No references section found in REPORT.md');
          }
        } else {
          logger.warn({ reportPath }, 'REPORT.md exists but is empty');
        }
      } catch (err) {
        logger.warn({ err, reportPath }, 'Failed to read REPORT.md');
      }
    } else {
      logger.debug({ reportPath }, 'No REPORT.md found');
    }

    // Fallback: try README.md
    if (!abstract) {
      const readmePath = path.join(hostWorkDir, 'README.md');
      if (fs.existsSync(readmePath)) {
        logger.debug('No abstract from idea.yaml or REPORT.md, falling back to README.md');
        try {
          const readme = fs.readFileSync(readmePath, 'utf-8');
          const paragraphs = readme.split('\n\n').filter(p => !p.startsWith('#') && p.trim().length > 50);
          if (paragraphs.length > 0) {
            abstract = paragraphs[0].trim().slice(0, 2000);
            logger.debug({ abstractLength: abstract.length }, 'Extracted abstract from README.md');
          } else {
            logger.warn('README.md has no substantial paragraphs for abstract');
          }
        } catch (err) {
          logger.warn({ err, readmePath }, 'Failed to read README.md');
        }
      } else {
        logger.warn({ hostWorkDir }, 'No abstract source found (no REPORT.md, no README.md, no hypothesis)');
      }
    }
  } else {
    logger.warn({ hostWorkDir, hostWorkspacesDir }, 'No workspace directory found');
  }

  // ── Fallback: .git/config for GitHub URL ──
  if (!githubUrl && hostWorkDir) {
    const gitConfigPath = path.join(hostWorkDir, '.git', 'config');
    if (fs.existsSync(gitConfigPath)) {
      try {
        const gitConfig = fs.readFileSync(gitConfigPath, 'utf-8');
        const urlMatch = gitConfig.match(/url\s*=\s*(https:\/\/github\.com\/[^\s]+)/);
        if (urlMatch) {
          githubUrl = urlMatch[1].replace(/\.git$/, '');
          logger.info({ githubUrl }, 'GitHub URL extracted from .git/config');
        }
      } catch { /* ignore */ }
    }
  }

  // ── Fallback GitHub URL: use LAST match in stdout ──
  // The runner.py prints the correct URL at the end, but earlier output
  // (resource_finder agent output, search results) may contain unrelated GitHub URLs.
  if (!githubUrl) {
    githubUrl = extractLastGithubUrl(stdout);
    if (githubUrl) {
      logger.debug({ githubUrl }, 'GitHub URL extracted from stdout (not idea.yaml)');
    }
  }

  // Strip trailing punctuation/quotes that might have been captured
  if (githubUrl) {
    githubUrl = githubUrl.replace(/[)}\].,;"']+$/, '');
  }

  // Construct pdfUrl from githubUrl (paper is always at paper_draft/main.pdf)
  const pdfUrl = githubUrl ? `${githubUrl}/blob/main/paper_draft/main.pdf` : undefined;

  if (!hostWorkDir && !githubUrl) {
    logger.error('parseNeuricoOutput failed: no workspace found and no GitHub URL in stdout');
    return {
      success: false,
      error: 'Could not find workspace or GitHub URL in NeuriCo output',
    };
  }

  if (!githubUrl) {
    logger.warn({ hostWorkDir, title }, 'parseNeuricoOutput: workspace found but no GitHub URL from any source');
  }

  const finalTags = tags || (domain ? [domain] : undefined);
  const finalRefs = references && references.length > 0 ? references : undefined;

  logger.info({
    title,
    abstractLength: abstract?.length,
    domain,
    tags: finalTags,
    githubUrl,
    pdfUrl,
    refCount: finalRefs?.length ?? 0,
  }, 'NeuriCo output parsed — ready for posting');

  return {
    success: true,
    workDir: hostWorkDir,
    githubUrl: githubUrl || undefined,
    pdfUrl,
    title,
    abstract,
    domain,
    tags: finalTags,
    references: finalRefs,
  };
}

/**
 * Extract the LAST GitHub URL from stdout using multiple patterns.
 * We want the last match because runner.py prints the correct URL at the end,
 * while earlier output may contain unrelated GitHub URLs from search results.
 */
export function extractLastGithubUrl(stdout: string): string | undefined {
  const patterns = [
    /GitHub:\s*(https:\/\/github\.com\/[^\s]+)/gi,
    /github_repo_url:\s*(https:\/\/github\.com\/[^\s]+)/gi,
    /Results published to GitHub!\s*\n?\s*(https:\/\/github\.com\/[^\s]+)/gi,
  ];

  let lastUrl: string | undefined;
  for (const pattern of patterns) {
    for (const match of stdout.matchAll(pattern)) {
      // Skip the ChicagoHAI/NeuriCo boilerplate URL
      if (match[1] && !match[1].includes('ChicagoHAI/NeuriCo')) {
        lastUrl = match[1];
      }
    }
    // If we found matches with this pattern, use the last one
    if (lastUrl) return lastUrl;
  }
  return undefined;
}

/** Extract the title from a REPORT.md's first `# Title` heading. */
export function extractReportTitle(report: string): string | undefined {
  for (const line of report.split('\n')) {
    if (line.startsWith('# ') && !line.startsWith('## ')) {
      return line.replace(/^#\s+/, '').trim();
    }
  }
  return undefined;
}

/**
 * Extract the `## References` section from REPORT.md and parse into structured objects.
 * Handles formats like:
 *   1. Author (Year). Title. Venue. arXiv:ID
 *   - Author (Year). Title. arXiv:ID
 *
 * Ported from flamebird_old/scripts/prefill.ts parseReferences().
 */
export function extractReportReferences(report: string): Array<{ authors: string; year: string; title: string; venue?: string; arxivId?: string }> {
  const lines = report.split('\n');

  // Find the ## References section
  const startIdx = lines.findIndex(l => /^##\s+(\d+\.\s+)?Reference/i.test(l));
  if (startIdx < 0) return [];

  // Collect lines until next ## heading
  const refLines: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    refLines.push(lines[i]);
  }

  // Parse each reference line
  const refs: Array<{ authors: string; year: string; title: string; venue?: string; arxivId?: string }> = [];

  for (const line of refLines) {
    const trimmed = line.trim();
    const stripped = trimmed.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '');
    if (stripped.length < 10) continue;

    // Pattern: "Authors (Year). Title. Venue."
    const match = stripped.match(/^(.+?)\s*\((\d{4})\)\.\s*(.+)/);
    if (!match) continue;

    const authors = match[1].trim();
    const year = match[2];
    let rest = match[3].trim().replace(/\.$/, '');

    // Extract arXiv ID if present
    let arxivId: string | undefined;
    const arxivMatch = rest.match(/arXiv:(\d+\.\d+)/i);
    if (arxivMatch) {
      arxivId = arxivMatch[1];
      rest = rest.replace(/\.?\s*arXiv:\d+\.\d+\.?/i, '').trim();
    }

    // Split remaining into title and venue on the last period
    let refTitle = rest;
    let venue: string | undefined;
    const lastDot = rest.lastIndexOf('.');
    if (lastDot > 0 && lastDot < rest.length - 1) {
      refTitle = rest.slice(0, lastDot).trim();
      venue = rest.slice(lastDot + 1).trim();
    } else if (lastDot === rest.length - 1) {
      refTitle = rest.slice(0, lastDot).trim();
    }

    if (!refTitle || refTitle.length < 5) continue;

    refs.push({
      authors,
      year,
      title: refTitle,
      ...(venue ? { venue } : {}),
      ...(arxivId ? { arxivId } : {}),
    });
  }

  return refs;
}

/** Find the most recently modified workspace directory. */
function findLatestWorkspace(workspacesDir: string): string | undefined {
  if (!fs.existsSync(workspacesDir)) return undefined;
  try {
    const entries = fs.readdirSync(workspacesDir)
      .filter(f => fs.statSync(path.join(workspacesDir, f)).isDirectory())
      .map(f => ({
        name: f,
        mtime: fs.statSync(path.join(workspacesDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    return entries[0] ? path.join(workspacesDir, entries[0].name) : undefined;
  } catch {
    return undefined;
  }
}

/** Simple helper to extract a YAML field value (avoids pulling in a YAML parser dep). */
export function extractYamlField(content: string, field: string): string | undefined {
  // Try single-quoted multi-line: field: 'line1\n  line2\n  ...\n  '
  const multiQuoteRegex = new RegExp(`^\\s*${field}:\\s*'([\\s\\S]*?)'\\s*(?:\\n|$)`, 'm');
  const multiQuoteMatch = content.match(multiQuoteRegex);
  if (multiQuoteMatch) {
    return multiQuoteMatch[1].replace(/\n\s*/g, ' ').trim();
  }
  // Try double-quoted multi-line
  const multiDquoteRegex = new RegExp(`^\\s*${field}:\\s*"([\\s\\S]*?)"\\s*(?:\\n|$)`, 'm');
  const multiDquoteMatch = content.match(multiDquoteRegex);
  if (multiDquoteMatch) {
    return multiDquoteMatch[1].replace(/\n\s*/g, ' ').trim();
  }
  // Fall back to single-line unquoted value
  const regex = new RegExp(`^\\s*${field}:\\s*["']?(.+?)["']?\\s*$`, 'm');
  const match = content.match(regex);
  return match?.[1]?.trim();
}

// ============================================================================
// Publish to Agent4Science
// ============================================================================

/**
 * Publish a paper to Agent4Science using the existing Agent4ScienceClient.
 * This is the final step after either Math Agent or NeuriCo produces results.
 */
export async function publishPaperToAgent4Science(
  apiKey: string,
  params: PublishPaperParams,
): Promise<ApiResponse<Agent4SciencePaper>> {
  const client = getAgent4ScienceClient();
  logger.info({ title: params.title, tags: params.tags }, 'Publishing paper to Agent4Science');
  return client.createPaper(params, apiKey);
}

// ============================================================================
// Path Resolution
// ============================================================================

/** Resolve the NeuriCo installation path from env or defaults. */
export function resolveNeuricoPath(): string | null {
  // Check env var first
  if (process.env.NEURICO_PATH) {
    const p = process.env.NEURICO_PATH;
    // Direct path to NeuriCo dir (preferred)
    if (isNeuricoDir(p)) return p;
    // Parent dir containing neurico/ subdir (backward compat)
    const sub = path.join(p, 'neurico');
    if (isNeuricoDir(sub)) return sub;
  }

  // Common locations
  const candidates = [
    path.join(process.env.HOME || '', '.flamebird', 'neurico'),
    path.join(process.env.HOME || '', 'neurico'),
    path.join(process.cwd(), 'neurico'),
    path.join(process.cwd(), '..', 'neurico'),
  ];

  for (const p of candidates) {
    if (isNeuricoDir(p)) return p;
  }

  return null;
}
