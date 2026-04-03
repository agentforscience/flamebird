/**
 * Ensure Credentials Utility
 *
 * Checks that the runtime .env has all credentials needed for a given agent tier,
 * prompts the user for anything missing, and persists to .env.
 *
 * Also handles NeuriCo installation and credential sync.
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync, spawnSync } from 'child_process';
import { config as loadEnv } from 'dotenv';
import { getConfigPath, getFlamebirdHome } from '../../config/config.js';
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
  const target = envPath || getConfigPath();
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
export function generateEncryptionKey(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let key = '';
  for (let i = 0; i < 32; i++) {
    key += chars[Math.floor(Math.random() * chars.length)];
  }
  return key;
}

// ============================================================================
// NeuriCo
// ============================================================================

/** Check if a directory looks like a valid NeuriCo installation. */
export function isNeuricoDir(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'pyproject.toml')) &&
    fs.existsSync(path.join(dir, 'src', 'core', 'runner.py'));
}

/** Expand leading ~ to the user's home directory. */
function expandHome(p: string): string {
  return p.replace(/^~(?=$|\/)/, process.env.HOME || os.homedir());
}

/**
 * Find or install NeuriCo.
 * Returns the installation path, or null if the user declines.
 */
export async function ensureNeurico(): Promise<string | null> {
  // Check common paths
  const candidates = [
    process.env.NEURICO_PATH || '',
    path.join(getFlamebirdHome(), 'neurico'),
    path.resolve(process.env.HOME || '~', 'neurico'),
    path.resolve('.', 'neurico'),
    path.resolve('..', 'neurico'),
  ].filter(Boolean);

  for (const p of candidates) {
    // Check if p itself is NeuriCo, or if p/neurico is
    const resolved = isNeuricoDir(p) ? p
      : isNeuricoDir(path.join(p, 'neurico')) ? path.join(p, 'neurico')
      : null;
    if (resolved) {
      console.log(chalk.green(`    Found NeuriCo at ${resolved}`));
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
    message: 'NeuriCo is not installed. Install it now?',
    prefix: '    ',
    default: true,
  }]);

  if (!install) {
    console.log(chalk.yellow('    Skipping. You can install later with:'));
    console.log(chalk.cyan('    curl -fsSL https://raw.githubusercontent.com/ChicagoHAI/neurico/main/install.sh | bash'));
    return null;
  }

  // Ask where to install
  const defaultInstallPath = path.join(getFlamebirdHome(), 'neurico');
  const { installPath } = await inquirer.prompt<{ installPath: string }>([{
    type: 'input',
    name: 'installPath',
    message: 'Where should NeuriCo be installed?',
    prefix: '    ',
    default: defaultInstallPath,
  }]);

  const resolvedInstallPath = path.resolve(expandHome(installPath));

  // Check prerequisites
  try {
    execSync('git --version', { stdio: 'ignore' });
  } catch {
    console.log(chalk.red('    git is required but not installed.'));
    return null;
  }
  try {
    execSync('docker --version', { stdio: 'ignore' });
  } catch {
    console.log(chalk.red('    docker is required but not installed.'));
    return null;
  }

  try {
    // Clone or update NeuriCo
    if (fs.existsSync(path.join(resolvedInstallPath, '.git'))) {
      console.log(chalk.gray(`\n    Updating existing installation at ${resolvedInstallPath}...`));
      spawnSync('git', ['-C', resolvedInstallPath, 'pull', '--ff-only'], { stdio: 'inherit' });
    } else {
      console.log(chalk.gray(`\n    Cloning NeuriCo to ${resolvedInstallPath}...\n`));
      const clone = spawnSync('git', ['clone', 'https://github.com/ChicagoHAI/neurico.git', resolvedInstallPath], {
        stdio: 'inherit',
      });
      if (clone.status !== 0) {
        console.log(chalk.red('    Failed to clone NeuriCo.'));
        return null;
      }
    }

    console.log(chalk.gray('\n    Running NeuriCo setup...\n'));
    spawnSync('./neurico', ['setup'], {
      cwd: resolvedInstallPath,
      stdio: 'inherit',
      timeout: 600000, // 10 minutes
    });

    if (isNeuricoDir(resolvedInstallPath)) {
      console.log(chalk.green(`\n    NeuriCo installed at ${resolvedInstallPath}`));
      return resolvedInstallPath;
    }

    console.log(chalk.yellow('\n    NeuriCo cloned but setup may not have completed.'));
    console.log(chalk.yellow(`    You can finish setup later: cd ${resolvedInstallPath} && ./neurico setup`));
    return resolvedInstallPath;
  } catch {
    console.log(chalk.yellow('\n    Installation did not complete. You can install later.'));
    return null;
  }
}

/**
 * Sync credentials from the runtime .env to NeuriCo's .env.
 * Merges without overwriting existing values in NeuriCo's .env.
 */
export function syncCredentialsToNeurico(neuricoPath: string): void {
  const runtimeEnv = readEnvFile(getConfigPath());
  const ieEnvPath = path.join(neuricoPath, '.env');

  // Keys to sync from runtime → NeuriCo
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
  const envPath = getConfigPath();
  const env = readEnvFile(envPath);
  const varsToAdd: Record<string, string> = {};

  // 1. Encryption key (all tiers, generated silently)
  if (!env.ENCRYPTION_KEY && !process.env.ENCRYPTION_KEY) {
    const key = generateEncryptionKey();
    varsToAdd.ENCRYPTION_KEY = key;
    process.env.ENCRYPTION_KEY = key;
  }

  // 2. NeuriCo installation (neurico tier only)
  if (tier === 'neurico') {
    if (!env.NEURICO_PATH && !process.env.NEURICO_PATH) {
      const iePath = await ensureNeurico();
      if (iePath) {
        varsToAdd.NEURICO_PATH = iePath;
        process.env.NEURICO_PATH = iePath;
      }
    }

    // Import GitHub credentials from neurico/.env if available.
    // This runs whether neurico was just discovered OR was already configured.
    const resolvedNeuricoPath = process.env.NEURICO_PATH || env.NEURICO_PATH;
    if (resolvedNeuricoPath) {
      const ieEnvPath = path.join(resolvedNeuricoPath, '.env');
      if (fs.existsSync(ieEnvPath)) {
        const ieEnv = readEnvFile(ieEnvPath);
        if (ieEnv.GITHUB_TOKEN && !env.GITHUB_TOKEN && !process.env.GITHUB_TOKEN && !varsToAdd.GITHUB_TOKEN) {
          varsToAdd.GITHUB_TOKEN = ieEnv.GITHUB_TOKEN;
          process.env.GITHUB_TOKEN = ieEnv.GITHUB_TOKEN;
        }
        if (ieEnv.GITHUB_ORG && !env.GITHUB_ORG && !process.env.GITHUB_ORG && !varsToAdd.GITHUB_ORG) {
          varsToAdd.GITHUB_ORG = ieEnv.GITHUB_ORG;
          process.env.GITHUB_ORG = ieEnv.GITHUB_ORG;
        }
      }
    }

    if (!env.NEURICO_PROVIDER && !process.env.NEURICO_PROVIDER) {
      const { provider } = await inquirer.prompt<{ provider: string }>([{
        type: 'list',
        name: 'provider',
        message: 'AI provider for NeuriCo:',
        prefix: '    ',
        choices: [
          { name: 'Claude (Anthropic)', value: 'claude' },
          { name: 'Codex (OpenAI)', value: 'codex' },
          { name: 'Gemini (Google)', value: 'gemini' },
        ],
      }]);
      varsToAdd.NEURICO_PROVIDER = provider;
      process.env.NEURICO_PROVIDER = provider;
    }
  }

  // 3. GitHub token (NeuriCo — only prompt if not already set by neurico install)
  if (tier === 'neurico') {
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

  // Persist any new vars
  if (Object.keys(varsToAdd).length > 0) {
    upsertEnvVars(varsToAdd, envPath);

    // Reload dotenv so loadConfig() sees the new values
    loadEnv({ path: envPath, override: true });

    console.log(chalk.green('    Credentials saved to .env'));
  }

  // Sync to NeuriCo if applicable
  if (tier === 'neurico') {
    const iePath = process.env.NEURICO_PATH;
    if (iePath && fs.existsSync(iePath)) {
      syncCredentialsToNeurico(iePath);
    }
  }

  return true;
}
