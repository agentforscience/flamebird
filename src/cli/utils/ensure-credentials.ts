/**
 * Ensure Credentials Utility
 *
 * Checks that the runtime .env has all credentials needed for a given agent tier,
 * prompts the user for anything missing, and persists to .env.
 *
 * Also handles idea-explorer installation and credential sync.
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { config as loadEnv } from 'dotenv';
import type { AgentCapability } from '../../types.js';

// ============================================================================
// .env helpers
// ============================================================================

/**
 * Read an existing .env file into a key-value map.
 * Skips comments and blank lines.
 */
function readEnvFile(envPath: string): Record<string, string> {
  if (!fs.existsSync(envPath)) return {};
  const content = fs.readFileSync(envPath, 'utf-8');
  const out: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    out[key] = value;
  }
  return out;
}

/**
 * Merge new key-value pairs into an existing .env file.
 * Does NOT overwrite keys that already have a non-empty value.
 * Appends new keys at the end with a section comment.
 */
export function upsertEnvVars(
  vars: Record<string, string>,
  envPath?: string,
): void {
  const target = envPath || path.join(process.cwd(), '.env');
  const existing = readEnvFile(target);

  // Read raw content to preserve comments and formatting
  let content = fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : '';

  const toAdd: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (existing[key]) continue; // already set, don't overwrite
    toAdd[key] = value;

    // Also update in-line if the key exists but is commented out
    const commentPattern = new RegExp(`^#\\s*${key}=.*$`, 'm');
    if (commentPattern.test(content)) {
      content = content.replace(commentPattern, `${key}=${value}`);
      delete toAdd[key]; // handled via uncomment
    }
  }

  // Append remaining new keys
  const newKeys = Object.entries(toAdd);
  if (newKeys.length > 0) {
    if (content.length > 0 && !content.endsWith('\n')) {
      content += '\n';
    }
    content += '\n# Added by setup wizard\n';
    for (const [key, value] of newKeys) {
      content += `${key}=${value}\n`;
    }
  }

  // Write atomically via temp file
  const tmpPath = target + '.tmp';
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, target);
}

/** Generate a 32-char random encryption key. */
function generateEncryptionKey(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let key = '';
  for (let i = 0; i < 32; i++) {
    key += chars[Math.floor(Math.random() * chars.length)];
  }
  return key;
}

// ============================================================================
// Idea Explorer
// ============================================================================

/**
 * Find or install idea-explorer.
 * Returns the installation path, or null if the user declines.
 */
export async function ensureIdeaExplorer(): Promise<string | null> {
  // Check common paths
  const candidates = [
    process.env.IDEA_EXPLORER_PATH || '',
    path.resolve(process.env.HOME || '~', 'idea-explorer'),
    path.resolve('.', 'idea-explorer'),
    path.resolve('..', 'idea-explorer'),
  ].filter(Boolean);

  const isIdeaExplorerDir = (dir: string) =>
    fs.existsSync(path.join(dir, 'pyproject.toml')) &&
    fs.existsSync(path.join(dir, 'src', 'core', 'runner.py'));

  for (const p of candidates) {
    // Check if p itself is idea-explorer, or if p/idea-explorer is
    const resolved = isIdeaExplorerDir(p) ? p
      : isIdeaExplorerDir(path.join(p, 'idea-explorer')) ? path.join(p, 'idea-explorer')
      : null;
    if (resolved) {
      console.log(chalk.green(`    Found idea-explorer at ${resolved}`));
      const { useExisting } = await inquirer.prompt<{ useExisting: boolean }>([{
        type: 'confirm',
        name: 'useExisting',
        message: 'Use this installation?',
        prefix: '    ',
        default: true,
      }]);
      if (useExisting) return resolved;
    }
  }

  // Not found — offer to install
  const { install } = await inquirer.prompt<{ install: boolean }>([{
    type: 'confirm',
    name: 'install',
    message: 'Idea Explorer is not installed. Install it now?',
    prefix: '    ',
    default: true,
  }]);

  if (!install) {
    console.log(chalk.yellow('    Skipping. You can install later with:'));
    console.log(chalk.cyan('    curl -fsSL https://raw.githubusercontent.com/ChicagoHAI/idea-explorer/main/install.sh | bash'));
    return null;
  }

  console.log(chalk.gray('\n    Running idea-explorer installer...\n'));

  // Run the one-liner installer with inherited stdio so the user sees
  // the full interactive setup (Docker pull, CLI login, etc.)
  spawnSync('bash', ['-c', 'curl -fsSL https://raw.githubusercontent.com/ChicagoHAI/idea-explorer/main/install.sh | bash'], {
    stdio: 'inherit',
    timeout: 600000, // 10 minutes
  });

  // Check if it was installed
  const homePath = path.resolve(process.env.HOME || '~', 'idea-explorer');
  if (isIdeaExplorerDir(homePath)) {
    console.log(chalk.green(`\n    Idea Explorer installed at ${homePath}`));
    return homePath;
  }

  // Ask where it was installed
  const { iePath } = await inquirer.prompt<{ iePath: string }>([{
    type: 'input',
    name: 'iePath',
    message: 'Where was idea-explorer installed?',
    prefix: '    ',
    default: homePath,
  }]);
  return iePath || null;
}

/**
 * Sync credentials from the runtime .env to idea-explorer's .env.
 * Merges without overwriting existing values in idea-explorer's .env.
 */
export function syncCredentialsToIdeaExplorer(ideaExplorerPath: string): void {
  const runtimeEnv = readEnvFile(path.join(process.cwd(), '.env'));
  const ieEnvPath = path.join(ideaExplorerPath, '.env');

  // Keys to sync from runtime → idea-explorer
  const keysToSync = [
    'GITHUB_TOKEN',
    'GITHUB_ORG',
    'OPENAI_API_KEY',
    'OPENROUTER_KEY',
    'S2_API_KEY',
    'COHERE_API_KEY',
    'ANTHROPIC_API_KEY',
    'GOOGLE_API_KEY',
    'HF_TOKEN',
    'WANDB_API_KEY',
  ];

  const vars: Record<string, string> = {};
  for (const key of keysToSync) {
    if (runtimeEnv[key]) {
      vars[key] = runtimeEnv[key];
    }
  }

  // Also map LLM_API_KEY → OPENROUTER_KEY if applicable
  if (runtimeEnv.LLM_API_KEY && runtimeEnv.LLM_PROVIDER === 'openrouter' && !vars.OPENROUTER_KEY) {
    vars.OPENROUTER_KEY = runtimeEnv.LLM_API_KEY;
  }

  if (Object.keys(vars).length > 0) {
    upsertEnvVars(vars, ieEnvPath);
    console.log(chalk.green(`    Synced credentials to ${ieEnvPath}`));
  }
}

// ============================================================================
// Main credential check
// ============================================================================

/**
 * Ensure all credentials needed for a given agent tier are present in .env.
 * Prompts the user for anything missing and persists to .env.
 * Returns true if all required credentials are now present.
 */
export async function ensureCredentials(tier: AgentCapability): Promise<boolean> {
  const envPath = path.join(process.cwd(), '.env');
  const env = readEnvFile(envPath);
  const varsToAdd: Record<string, string> = {};

  // 1. Encryption key (all tiers, generated silently)
  if (!env.ENCRYPTION_KEY && !process.env.ENCRYPTION_KEY) {
    const key = generateEncryptionKey();
    varsToAdd.ENCRYPTION_KEY = key;
    process.env.ENCRYPTION_KEY = key;
  }

  // 2. GitHub token (idea-explorer)
  if (tier === 'idea-explorer') {
    if (!env.GITHUB_TOKEN && !process.env.GITHUB_TOKEN) {
      console.log(chalk.gray('\n    GitHub token is needed to push generated paper repos.'));
      console.log(chalk.gray('    Create one at: https://github.com/settings/tokens (repo scope)\n'));

      const { githubToken } = await inquirer.prompt<{ githubToken: string }>([{
        type: 'password',
        name: 'githubToken',
        message: 'GitHub Personal Access Token:',
        prefix: '    ',
        mask: '*',
        validate: (v: string) => v.length > 0 || 'Required for paper generation',
      }]);
      varsToAdd.GITHUB_TOKEN = githubToken;
      process.env.GITHUB_TOKEN = githubToken;

      const { githubOrg } = await inquirer.prompt<{ githubOrg: string }>([{
        type: 'input',
        name: 'githubOrg',
        message: 'GitHub org (leave blank for personal account):',
        prefix: '    ',
        default: '',
      }]);
      if (githubOrg) {
        varsToAdd.GITHUB_ORG = githubOrg;
        process.env.GITHUB_ORG = githubOrg;
      }
    }
  }

  // 3. Idea Explorer (idea-explorer tier only)
  if (tier === 'idea-explorer') {
    if (!env.IDEA_EXPLORER_PATH && !process.env.IDEA_EXPLORER_PATH) {
      const iePath = await ensureIdeaExplorer();
      if (iePath) {
        varsToAdd.IDEA_EXPLORER_PATH = iePath;
        process.env.IDEA_EXPLORER_PATH = iePath;
      }
    }

    if (!env.IDEA_EXPLORER_PROVIDER && !process.env.IDEA_EXPLORER_PROVIDER) {
      const { provider } = await inquirer.prompt<{ provider: string }>([{
        type: 'list',
        name: 'provider',
        message: 'AI provider for Idea Explorer:',
        prefix: '    ',
        choices: [
          { name: 'Claude (Anthropic)', value: 'claude' },
          { name: 'Codex (OpenAI)', value: 'codex' },
          { name: 'Gemini (Google)', value: 'gemini' },
        ],
      }]);
      varsToAdd.IDEA_EXPLORER_PROVIDER = provider;
      process.env.IDEA_EXPLORER_PROVIDER = provider;
    }
  }

  // Persist any new vars
  if (Object.keys(varsToAdd).length > 0) {
    upsertEnvVars(varsToAdd, envPath);

    // Reload dotenv so loadConfig() sees the new values
    loadEnv({ path: envPath, override: true });

    console.log(chalk.green('    Credentials saved to .env'));
  }

  // Sync to idea-explorer if applicable
  if (tier === 'idea-explorer') {
    const iePath = process.env.IDEA_EXPLORER_PATH;
    if (iePath && fs.existsSync(iePath)) {
      syncCredentialsToIdeaExplorer(iePath);
    }
  }

  return true;
}
