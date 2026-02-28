/**
 * Paper Generation Tools
 *
 * Integrates external paper-generation tools into the Flamebird runtime
 * so agents can publish research papers to Agent4Science.
 *
 * Math Agent  – embedded in Flamebird runtime (see math-paper-generator.ts)
 * Idea Explorer – spawns the CLI subprocess, parses the resulting workspace
 */

import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { createLogger } from '../logging/logger.js';
import { getAgent4ScienceClient } from '../api/agent4science-client.js';
import type { Agent4SciencePaper } from '../types.js';
import type { ApiResponse } from '../api/agent4science-client.js';

const logger = createLogger('paper-tools');

const DOCKER_IMAGE = 'chicagohai/idea-explorer:latest';

// ============================================================================
// Types
// ============================================================================

export interface IdeaExplorerParams {
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

export interface IdeaExplorerResult {
  success: boolean;
  workDir?: string;
  githubUrl?: string;
  pdfUrl?: string;
  title?: string;
  abstract?: string;
  domain?: string;
  tags?: string[];
  references?: Array<{ authors: string; year: number; title: string; venue?: string; arxivId?: string }>;
  error?: string;
}

export interface PublishPaperParams {
  title: string;
  abstract: string;
  tldr: string;
  hypothesis?: string;
  experimentPlan?: string;
  conclusion?: string;
  tags: string[];
  claims: string[];
  limitations?: string[];
  githubUrl: string;
  pdfUrl: string;
  inspirations?: Array<{ title: string; arxivId?: string; url?: string; note?: string }>;
}

// ============================================================================
// Idea Explorer Integration
// ============================================================================

/**
 * Build the common Docker args that mirror idea-explorer's docker/run.sh.
 * We call docker directly (instead of the bash wrapper) to avoid the `-t`
 * TTY flag that breaks non-interactive spawning.
 */
function buildDockerArgs(ideaExplorerPath: string): string[] {
  const args: string[] = ['run', '-i', '--rm'];

  // User ID mapping (same as the wrapper's get_user_flags)
  try {
    const uid = execSync('id -u', { encoding: 'utf-8' }).trim();
    const gid = execSync('id -g', { encoding: 'utf-8' }).trim();
    args.push('--user', `${uid}:${gid}`);
  } catch { /* skip if id command fails */ }

  // GPU support (auto-detect nvidia)
  try {
    const dockerInfo = execSync('docker info 2>/dev/null', { encoding: 'utf-8' });
    if (/nvidia/i.test(dockerInfo)) {
      args.push('--gpus', 'all');
    }
  } catch { /* no GPU */ }

  // Environment file
  const envFile = path.join(ideaExplorerPath, '.env');
  if (fs.existsSync(envFile)) {
    args.push('--env-file', envFile);
  }

  // Workspace env var
  args.push('-e', 'IDEA_EXPLORER_WORKSPACE=/workspaces');

  // Resolve workspace dir from config or default
  const workspaceDir = resolveWorkspaceDir(ideaExplorerPath);
  fs.mkdirSync(workspaceDir, { recursive: true });

  // Standard volume mounts (mirrors docker/run.sh)
  args.push('-v', `${workspaceDir}:/workspaces`);

  // Ensure ideas subdirectories exist on the host so the container user can write to them
  const ideasDir = path.join(ideaExplorerPath, 'ideas');
  for (const sub of ['submitted', 'running', 'completed', 'failed']) {
    fs.mkdirSync(path.join(ideasDir, sub), { recursive: true });
  }
  args.push('-v', `${ideasDir}:/app/ideas`);

  const logsDir = path.join(ideaExplorerPath, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  args.push('-v', `${logsDir}:/app/logs`);

  const configDir = path.join(ideaExplorerPath, 'config');
  if (fs.existsSync(configDir)) {
    args.push('-v', `${configDir}:/app/config:ro`);
  }

  const templatesDir = path.join(ideaExplorerPath, 'templates');
  if (fs.existsSync(templatesDir)) {
    args.push('-v', `${templatesDir}:/app/templates:ro`);
  }

  // CLI credential mounts (Claude, Codex, Gemini)
  const home = process.env.HOME || '';
  for (const cred of ['.claude', '.codex', '.gemini']) {
    const credPath = path.join(home, cred);
    if (fs.existsSync(credPath)) {
      args.push('-v', `${credPath}:/tmp/${cred}`);
    }
  }

  args.push('-w', '/app');

  return args;
}

/** Resolve the workspace directory from idea-explorer's config. */
function resolveWorkspaceDir(ideaExplorerPath: string): string {
  // Try workspace.yaml, then workspace.yaml.example
  for (const fname of ['config/workspace.yaml', 'config/workspace.yaml.example']) {
    const configPath = path.join(ideaExplorerPath, fname);
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      const match = content.match(/parent_dir:\s*["']?([^"'\n]+)/);
      if (match) {
        const dir = match[1].trim();
        if (path.isAbsolute(dir)) return dir;
        return path.join(ideaExplorerPath, dir);
      }
    }
  }
  return path.join(ideaExplorerPath, 'workspaces');
}

/**
 * Spawn a docker command and capture output. Returns { stdout, stderr, code }.
 */
function spawnDocker(
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const child = spawn('docker', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
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
      // Filter out Docker credential-check noise
      if (!/\[OK\]/.test(text)) {
        process.stderr.write(chalk.yellow(text));
      }
    });

    child.on('close', (code) => resolve({ stdout, stderr, code }));
    child.on('error', (err) => {
      resolve({ stdout, stderr: err.message, code: 1 });
    });
  });
}

/**
 * Run Idea Explorer via Docker, using the two-step flow:
 *   1. submit <yaml>  – registers the idea, creates GitHub repo
 *   2. run <idea_id>  – runs the research agent
 *
 * Calls docker directly (bypassing the bash wrapper) so we can omit the -t
 * flag that causes "not a TTY" errors when running as a daemon.
 */
export async function runIdeaExplorer(
  ideaExplorerPath: string,
  params: IdeaExplorerParams,
): Promise<IdeaExplorerResult> {
  const {
    source,
    provider = 'claude',
    autoRun = true,
    writePaper = true,
    noGithub = false,
  } = params;

  // Verify Docker is available
  try {
    execSync('docker info', { stdio: 'ignore' });
  } catch {
    return { success: false, error: 'Docker is not available. idea-explorer requires Docker.' };
  }

  // Verify Docker image exists
  try {
    execSync(`docker image inspect ${DOCKER_IMAGE}`, { stdio: 'ignore' });
  } catch {
    return {
      success: false,
      error: `Docker image ${DOCKER_IMAGE} not found. Run: docker pull ghcr.io/chicagohai/idea-explorer:latest && docker tag ghcr.io/chicagohai/idea-explorer:latest ${DOCKER_IMAGE}`,
    };
  }

  const baseArgs = buildDockerArgs(ideaExplorerPath);

  // ── Step 1: Submit the idea YAML ──
  logger.info({ source }, 'Submitting idea to Idea Explorer');

  const yamlDir = path.dirname(source);
  const yamlName = path.basename(source);
  const submitArgs = [
    ...baseArgs,
    '-v', `${yamlDir}:/input:ro`,
    DOCKER_IMAGE,
    'python', '/app/src/cli/submit.py', `/input/${yamlName}`,
    '--provider', provider,
  ];
  if (noGithub) submitArgs.push('--no-github');

  const submitResult = await spawnDocker(submitArgs, 120_000); // 2 min for submit

  if (submitResult.code !== 0) {
    logger.error({ code: submitResult.code }, 'Idea Explorer submit failed');
    return {
      success: false,
      error: `idea-explorer submit failed (code ${submitResult.code}): ${submitResult.stderr.slice(-500)}`,
    };
  }

  // Parse the idea ID from submit output (e.g. "Idea ID: abc123" or filename-based)
  const ideaId = parseIdeaId(submitResult.stdout);
  if (!ideaId) {
    // If we can't parse the ID, try to find the most recent idea in ideas/submitted/
    const submittedDir = path.join(ideaExplorerPath, 'ideas', 'submitted');
    const fallbackId = findLatestIdeaId(submittedDir);
    if (!fallbackId) {
      return {
        success: false,
        error: 'Could not determine idea ID after submit. Check idea-explorer logs.',
      };
    }
    logger.info({ ideaId: fallbackId }, 'Found idea ID from submitted directory');
    return autoRun
      ? runIdeaById(ideaExplorerPath, baseArgs, fallbackId, provider, writePaper, noGithub)
      : { success: true, title: fallbackId };
  }

  logger.info({ ideaId }, 'Idea submitted successfully');

  if (!autoRun) {
    return { success: true, title: ideaId };
  }

  // ── Step 2: Run the idea ──
  return runIdeaById(ideaExplorerPath, baseArgs, ideaId, provider, writePaper, noGithub);
}

/** Run an already-submitted idea by its ID. */
async function runIdeaById(
  ideaExplorerPath: string,
  baseArgs: string[],
  ideaId: string,
  provider: string,
  writePaper: boolean,
  noGithub: boolean,
): Promise<IdeaExplorerResult> {
  logger.info({ ideaId, provider, writePaper }, 'Running Idea Explorer research agent');

  const runArgs = [
    ...baseArgs,
    DOCKER_IMAGE,
    'python', '/app/src/core/runner.py', ideaId,
    '--provider', provider,
    '--full-permissions',
  ];
  if (writePaper) runArgs.push('--write-paper');
  if (noGithub) runArgs.push('--no-github');

  // No explicit timeout — let idea-explorer run to completion
  // Use a generous 6-hour cap to prevent zombie processes
  const runResult = await spawnDocker(runArgs, 6 * 3600 * 1000);

  if (runResult.code !== 0 && runResult.code !== null) {
    logger.error({ code: runResult.code }, 'Idea Explorer run failed');
    return {
      success: false,
      error: `idea-explorer run failed (code ${runResult.code}): ${runResult.stderr.slice(-500)}`,
    };
  }

  return parseIdeaExplorerOutput(runResult.stdout, ideaExplorerPath);
}

/** Parse the idea ID from submit.py output. */
function parseIdeaId(output: string): string | null {
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
 * Parse Idea Explorer output and workspace files to extract paper metadata.
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
function parseIdeaExplorerOutput(stdout: string, basePath: string): IdeaExplorerResult {
  // Look for workspace location (container path like /workspaces/<name>)
  const locationMatch = stdout.match(/Location:\s*(.+)/);
  const containerWorkDir = locationMatch?.[1]?.trim();

  // Translate container path → host path
  // Container: /workspaces/<name> → Host: <basePath>/workspaces/<name>
  const hostWorkspacesDir = resolveWorkspaceDir(basePath);
  let hostWorkDir: string | undefined;

  if (containerWorkDir) {
    const workspaceName = containerWorkDir.replace(/^\/workspaces\//, '');
    hostWorkDir = path.join(hostWorkspacesDir, workspaceName);
    if (!fs.existsSync(hostWorkDir)) {
      hostWorkDir = findLatestWorkspace(hostWorkspacesDir);
    }
  } else {
    hostWorkDir = findLatestWorkspace(hostWorkspacesDir);
  }

  // ── Read workspace files for metadata ──
  let title: string | undefined;
  let abstract: string | undefined;
  let domain: string | undefined;
  let tags: string[] | undefined;
  let githubUrl: string | undefined;
  let references: Array<{ authors: string; year: number; title: string; venue?: string; arxivId?: string }> | undefined;

  if (hostWorkDir && fs.existsSync(hostWorkDir)) {
    logger.info({ hostWorkDir }, 'Reading workspace files');

    // ── idea.yaml — primary source for GitHub URL, title, domain ──
    const ideaYamlPath = path.join(hostWorkDir, '.idea-explorer', 'idea.yaml');
    if (fs.existsSync(ideaYamlPath)) {
      try {
        const ideaContent = fs.readFileSync(ideaYamlPath, 'utf-8');
        githubUrl = extractYamlField(ideaContent, 'github_repo_url');
        title = extractYamlField(ideaContent, 'title');
        domain = extractYamlField(ideaContent, 'domain');
        const hypothesis = extractYamlField(ideaContent, 'hypothesis');
        if (hypothesis) abstract = hypothesis;

        // Extract tags list from YAML
        const tagsMatch = ideaContent.match(/tags:\s*\n((?:\s*-\s*.+\n?)+)/);
        if (tagsMatch) {
          tags = tagsMatch[1]
            .split('\n')
            .map(line => line.replace(/^\s*-\s*["']?/, '').replace(/["']?\s*$/, '').trim())
            .filter(t => t.length > 0);
        }
      } catch { /* ignore */ }
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
          if (reportTitle) title = reportTitle;

          // Extract references deterministically (LLMs are bad at precise reference parsing)
          references = extractReportReferences(report);
          if (references.length > 0) {
            logger.info({ count: references.length }, 'Extracted references from REPORT.md');
          }
        }
      } catch { /* ignore */ }
    }

    // Fallback: try README.md
    if (!abstract) {
      const readmePath = path.join(hostWorkDir, 'README.md');
      if (fs.existsSync(readmePath)) {
        try {
          const readme = fs.readFileSync(readmePath, 'utf-8');
          const paragraphs = readme.split('\n\n').filter(p => !p.startsWith('#') && p.trim().length > 50);
          if (paragraphs.length > 0) abstract = paragraphs[0].trim().slice(0, 2000);
        } catch { /* ignore */ }
      }
    }
  }

  // ── Fallback GitHub URL: use LAST match in stdout ──
  // The runner.py prints the correct URL at the end, but earlier output
  // (resource_finder agent output, search results) may contain unrelated GitHub URLs.
  if (!githubUrl) {
    githubUrl = extractLastGithubUrl(stdout);
  }

  // Strip trailing punctuation/quotes that might have been captured
  if (githubUrl) {
    githubUrl = githubUrl.replace(/[)}\].,;"']+$/, '');
  }

  // Construct pdfUrl from githubUrl (paper is always at paper_draft/main.pdf)
  const pdfUrl = githubUrl ? `${githubUrl}/blob/main/paper_draft/main.pdf` : undefined;

  if (!hostWorkDir && !githubUrl) {
    return {
      success: false,
      error: 'Could not find workspace or GitHub URL in idea-explorer output',
    };
  }

  return {
    success: true,
    workDir: hostWorkDir,
    githubUrl: githubUrl || undefined,
    pdfUrl,
    title,
    abstract,
    domain,
    tags: tags || (domain ? [domain] : undefined),
    references: references && references.length > 0 ? references : undefined,
  };
}

/**
 * Extract the LAST GitHub URL from stdout using multiple patterns.
 * We want the last match because runner.py prints the correct URL at the end,
 * while earlier output may contain unrelated GitHub URLs from search results.
 */
function extractLastGithubUrl(stdout: string): string | undefined {
  const patterns = [
    /GitHub:\s*(https:\/\/github\.com\/[^\s]+)/gi,
    /github_repo_url:\s*(https:\/\/github\.com\/[^\s]+)/gi,
    /Results published to GitHub!\s*\n?\s*(https:\/\/github\.com\/[^\s]+)/gi,
  ];

  let lastUrl: string | undefined;
  for (const pattern of patterns) {
    for (const match of stdout.matchAll(pattern)) {
      // Skip the ChicagoHAI/idea-explorer boilerplate URL
      if (match[1] && !match[1].includes('ChicagoHAI/idea-explorer')) {
        lastUrl = match[1];
      }
    }
    // If we found matches with this pattern, use the last one
    if (lastUrl) return lastUrl;
  }
  return undefined;
}

/** Extract the title from a REPORT.md's first `# Title` heading. */
function extractReportTitle(report: string): string | undefined {
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
function extractReportReferences(report: string): Array<{ authors: string; year: number; title: string; venue?: string; arxivId?: string }> {
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
  const refs: Array<{ authors: string; year: number; title: string; venue?: string; arxivId?: string }> = [];

  for (const line of refLines) {
    const trimmed = line.trim();
    const stripped = trimmed.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '');
    if (stripped.length < 10) continue;

    // Pattern: "Authors (Year). Title. Venue."
    const match = stripped.match(/^(.+?)\s*\((\d{4})\)\.\s*(.+)/);
    if (!match) continue;

    const authors = match[1].trim();
    const year = parseInt(match[2], 10);
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
function extractYamlField(content: string, field: string): string | undefined {
  const regex = new RegExp(`^\\s*${field}:\\s*["']?(.+?)["']?\\s*$`, 'm');
  const match = content.match(regex);
  return match?.[1]?.trim();
}

// ============================================================================
// Publish to Agent4Science
// ============================================================================

/**
 * Publish a paper to Agent4Science using the existing Agent4ScienceClient.
 * This is the final step after either Math Agent or Idea Explorer produces results.
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

/** Resolve the idea-explorer installation path from env or defaults. */
export function resolveIdeaExplorerPath(): string | null {
  /** Check if a directory looks like an idea-explorer installation. */
  const isIdeaExplorerDir = (dir: string) =>
    fs.existsSync(path.join(dir, 'pyproject.toml')) &&
    fs.existsSync(path.join(dir, 'src', 'core', 'runner.py'));

  // Check env var first
  if (process.env.IDEA_EXPLORER_PATH) {
    const p = process.env.IDEA_EXPLORER_PATH;
    // Direct path to idea-explorer dir (preferred)
    if (isIdeaExplorerDir(p)) return p;
    // Parent dir containing idea-explorer/ subdir (backward compat)
    const sub = path.join(p, 'idea-explorer');
    if (isIdeaExplorerDir(sub)) return sub;
  }

  // Common locations
  const candidates = [
    path.join(process.env.HOME || '', 'idea-explorer'),
    path.join(process.cwd(), 'idea-explorer'),
    path.join(process.cwd(), '..', 'idea-explorer'),
  ];

  for (const p of candidates) {
    if (isIdeaExplorerDir(p)) return p;
  }

  return null;
}
