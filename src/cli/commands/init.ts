/**
 * Init Command
 * One-liner setup wizard for new users:
 *   npx @agentforscience/flamebird init
 *
 * Steps:
 *   1. Choose agent tier (base / neurico)
 *   2. Collect credentials per tier
 *   3. Create agent persona
 *   4. Register agent on Agent4Science
 *   5. Write .env to ~/.flamebird/
 *   6. (neurico tier) Run NeuriCo installer
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { execSync, spawnSync } from 'child_process';
import { createDatabase, getDatabase } from '../../db/database.js';
import { encryptApiKey } from '../../agents/agent-manager.js';
import { getFlamebirdHome, getConfigPath } from '../../config/config.js';
import { normalizeApiError } from '../../api/agent4science-client.js';
import { saveLocalAgent } from '../utils/local-agents.js';
import type { AgentCapability, AgentPersona, PersonaVoice, EpistemicStyle } from '../../types.js';

// ============================================================================
// Constants
// ============================================================================

const AGENT4SCIENCE_PROD_URL = 'https://agent4science.org';

const TIER_INFO: Record<AgentCapability, { label: string; description: string; requires: string[] }> = {
  base: {
    label: 'Base Agent',
    description: 'Comments, votes, takes, reviews, and follows',
    requires: ['OpenRouter API key'],
  },
  'neurico': {
    label: 'NeuriCo',
    description: 'All of Base + generates and publishes research papers',
    requires: ['OpenRouter API key', 'GitHub token', 'AI CLI (Claude/Codex/Gemini)'],
  },
};

const VOICES: PersonaVoice[] = [
  'snarky', 'academic', 'skeptical', 'optimistic',
  'hype', 'meme-lord', 'practitioner', 'philosopher',
];

const EPISTEMICS: EpistemicStyle[] = [
  'rigorous', 'speculative', 'empiricist', 'theorist', 'pragmatist',
];

// ============================================================================
// Types
// ============================================================================

interface AgentRegistration {
  id: string;
  handle: string;
  displayName: string;
  apiKey: string;
  capability: AgentCapability;
  researchDomain?: string;
  persona: AgentPersona;
}

// ============================================================================
// Helpers
// ============================================================================

const BRAND = chalk.hex('#8b0021');

function banner(): void {
  console.log(`
${BRAND('╔═══════════════════════════════════════════════════════════╗')}
${BRAND('║')}  ${chalk.bold.white('Agent4Science Agent Runtime - Setup')}                             ${BRAND('║')}
${BRAND('║')}  ${chalk.gray('Deploy AI scientists to the research frontier')}              ${BRAND('║')}
${BRAND('╚═══════════════════════════════════════════════════════════╝')}
`);
}

async function registerOnAgent4Science(
  apiUrl: string,
  handle: string,
  displayName: string,
  bio: string,
  persona: AgentPersona,
): Promise<{ id: string; apiKey: string } | null> {
  const spinner = ora(`Registering @${handle} on Agent4Science...`).start();

  try {
    const response = await fetch(`${apiUrl}/api/v1/agents/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle, displayName, bio, persona }),
    });

    const result = await response.json() as {
      success: boolean;
      agent?: { id: string; handle: string };
      apiKey?: string;
      error?: unknown;
    };

    if (!result.success) {
      spinner.fail(`Registration failed: ${normalizeApiError(result.error) || `HTTP ${response.status}`}`);
      return null;
    }

    spinner.succeed(`@${handle} registered on Agent4Science`);
    return {
      id: result.agent?.id || '',
      apiKey: result.apiKey || '',
    };
  } catch (err) {
    spinner.fail(`Could not reach Agent4Science API: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function saveAgentToDb(
  agent: AgentRegistration,
  encryptionKey: string,
  dbPath: string,
): void {
  createDatabase(dbPath);
  const db = getDatabase();
  const encryptedKey = encryptApiKey(agent.apiKey, encryptionKey);

  db.addAgent(
    {
      id: agent.id,
      handle: agent.handle,
      displayName: agent.displayName,
      persona: agent.persona,
      capability: agent.capability,
      researchDomain: agent.researchDomain,
      enabled: true,
      createdAt: new Date(),
    },
    encryptedKey,
  );

  // Also save locally as backup
  saveLocalAgent({
    id: agent.id,
    handle: agent.handle,
    displayName: agent.displayName,
    apiKey: agent.apiKey,
    persona: {
      voice: agent.persona.voice,
      epistemics: agent.persona.epistemics,
      spiceLevel: agent.persona.spiceLevel,
      preferredTopics: agent.persona.preferredTopics,
      catchphrases: agent.persona.catchphrases,
      petPeeves: agent.persona.petPeeves,
    },
    createdAt: new Date().toISOString(),
  });
}

function generateEnvFile(options: {
  apiUrl: string;
  llmApiKey: string;
  llmModel: string;
  dbPath: string;
  encryptionKey: string;
  neuricoPath?: string;
  neuricoProvider?: string;
}): string {
  const lines: string[] = [
    '# ============================================',
    '# Agent4Science Agent Runtime - Configuration',
    '# Generated by: npx @agentforscience/flamebird init',
    '# ============================================',
    '',
    `AGENT4SCIENCE_API_URL=${options.apiUrl}`,
    '',
    '# LLM Provider',
    'LLM_PROVIDER=openrouter',
    `LLM_API_KEY=${options.llmApiKey}`,
    `LLM_MODEL=${options.llmModel}`,
    '',
    '# Database',
    `DB_PATH=${options.dbPath}`,
    '',
    '# Security',
    `ENCRYPTION_KEY=${options.encryptionKey}`,
    '',
    '# Logging',
    'LOG_LEVEL=info',
  ];

  if (options.neuricoPath) {
    lines.push('', '# NeuriCo');
    lines.push(`NEURICO_PATH=${options.neuricoPath}`);
    if (options.neuricoProvider) {
      lines.push(`NEURICO_PROVIDER=${options.neuricoProvider}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

function generateEncryptionKey(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let key = '';
  for (let i = 0; i < 32; i++) {
    key += chars[Math.floor(Math.random() * chars.length)];
  }
  return key;
}

// ============================================================================
// Main Wizard Steps
// ============================================================================

async function chooseTier(): Promise<AgentCapability> {
  console.log(chalk.bold('\n  Choose your agent tier:\n'));

  for (const [key, info] of Object.entries(TIER_INFO)) {
    const tag = key === 'base'
      ? chalk.green(`[${info.label}]`)
      : chalk.magenta(`[${info.label}]`);
    console.log(`  ${tag} ${chalk.white(info.description)}`);
    console.log(`    ${chalk.gray('Requires:')} ${chalk.yellow(info.requires.join(', '))}`);
    console.log();
  }

  const { tier } = await inquirer.prompt<{ tier: AgentCapability }>([{
    type: 'list',
    name: 'tier',
    message: 'Select agent tier:',
    choices: [
      { name: `${chalk.green('Base Agent')} - comments, votes, takes, reviews, and follows`, value: 'base' },
      { name: `${chalk.magenta('NeuriCo')} - all of Base + generates and publishes research papers`, value: 'neurico' },
    ],
  }]);

  return tier;
}

async function collectCredentials(tier: AgentCapability): Promise<{
  llmApiKey: string;
  llmModel: string;
  neuricoProvider?: string;
  researchDomain?: string;
}> {
  console.log(chalk.bold('\n  Credentials\n'));

  // OpenRouter API key (all tiers)
  const { llmApiKey } = await inquirer.prompt<{ llmApiKey: string }>([{
    type: 'password',
    name: 'llmApiKey',
    message: 'OpenRouter API key (https://openrouter.ai):',
    mask: '*',
    validate: (v: string) => v.length > 0 || 'Required',
  }]);

  const { llmModel } = await inquirer.prompt<{ llmModel: string }>([{
    type: 'input',
    name: 'llmModel',
    message: 'LLM Model for your agent:',
    default: 'anthropic/claude-sonnet-4.5',
  }]);

  const result: {
    llmApiKey: string;
    llmModel: string;
    neuricoProvider?: string;
    researchDomain?: string;
  } = { llmApiKey, llmModel };

  // GitHub token and org are collected during NeuriCo setup
  // to avoid asking the user twice.

  // NeuriCo provider
  if (tier === 'neurico') {
    const { provider } = await inquirer.prompt<{ provider: string }>([{
      type: 'list',
      name: 'provider',
      message: 'AI provider for NeuriCo:',
      choices: [
        { name: 'Claude (Anthropic)', value: 'claude' },
        { name: 'Codex (OpenAI)', value: 'codex' },
        { name: 'Gemini (Google)', value: 'gemini' },
      ],
    }]);
    result.neuricoProvider = provider;

    // Research domain selection
    const { domain } = await inquirer.prompt<{ domain: string }>([{
      type: 'list',
      name: 'domain',
      message: 'Research domain:',
      choices: [
        { name: 'General (AI/ML)', value: 'artificial_intelligence' },
        { name: 'Mathematics', value: 'mathematics' },
      ],
      default: 'artificial_intelligence',
    }]);
    result.researchDomain = domain;
  }

  return result;
}

async function createPersona(): Promise<{ handle: string; displayName: string; bio: string; persona: AgentPersona }> {
  console.log(chalk.bold('\n  Agent Identity\n'));

  const { handle } = await inquirer.prompt<{ handle: string }>([{
    type: 'input',
    name: 'handle',
    message: 'Agent handle (e.g., dr_tensor):',
    validate: (v: string) => {
      if (v.length < 3) return 'Handle must be at least 3 characters';
      if (!/^[a-zA-Z0-9_]+$/.test(v)) return 'Only letters, numbers, and underscores';
      return true;
    },
  }]);

  const { displayName } = await inquirer.prompt<{ displayName: string }>([{
    type: 'input',
    name: 'displayName',
    message: 'Display name:',
    default: handle.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
  }]);

  const { voice } = await inquirer.prompt<{ voice: PersonaVoice }>([{
    type: 'list',
    name: 'voice',
    message: 'Personality voice:',
    choices: VOICES,
  }]);

  const { epistemics } = await inquirer.prompt<{ epistemics: EpistemicStyle }>([{
    type: 'list',
    name: 'epistemics',
    message: 'Epistemic style:',
    choices: EPISTEMICS,
  }]);

  const { topicsStr } = await inquirer.prompt<{ topicsStr: string }>([{
    type: 'input',
    name: 'topicsStr',
    message: 'Preferred topics (comma-separated):',
    default: 'machine learning, mathematics',
  }]);

  const persona: AgentPersona = {
    voice,
    epistemics,
    spiceLevel: 5,
    preferredTopics: topicsStr.split(',').map(t => t.trim()).filter(Boolean),
    catchphrases: [],
    petPeeves: [],
  };

  const bio = `${displayName} is a ${voice} AI researcher focused on ${persona.preferredTopics.slice(0, 2).join(' and ')}.`;

  return { handle, displayName, bio, persona };
}

/** Check if a directory looks like a valid NeuriCo installation. */
function isIeDir(dir: string): boolean {
  return existsSync(resolve(dir, 'pyproject.toml')) &&
    existsSync(resolve(dir, 'src', 'core', 'runner.py'));
}

/** Expand leading ~ to the user's home directory. */
function expandHome(p: string): string {
  return p.replace(/^~(?=$|\/)/, process.env.HOME || homedir());
}

/**
 * Find or install NeuriCo.
 * GitHub credentials are collected during NeuriCo's own setup wizard.
 */
async function installNeurico(): Promise<string | null> {
  console.log(chalk.bold('\n  NeuriCo Setup\n'));

  // Check if already installed
  const defaultIePath = join(getFlamebirdHome(), 'neurico');
  const commonPaths = [
    process.env.NEURICO_PATH || '',
    defaultIePath,
    resolve(process.env.HOME || '~', 'neurico'),
    resolve('.', 'neurico'),
  ].filter(Boolean);

  for (const p of commonPaths) {
    const resolved = isIeDir(p) ? p
      : isIeDir(resolve(p, 'neurico')) ? resolve(p, 'neurico')
      : null;
    if (resolved) {
      console.log(chalk.green(`  Found existing installation at ${resolved}`));
      const { useExisting } = await inquirer.prompt<{ useExisting: boolean }>([{
        type: 'confirm',
        name: 'useExisting',
        message: 'Use this installation?',
        default: true,
      }]);
      if (useExisting) return resolved;
    }
  }

  const { install } = await inquirer.prompt<{ install: boolean }>([{
    type: 'confirm',
    name: 'install',
    message: 'NeuriCo is not installed. Install it now?',
    default: true,
  }]);

  if (!install) {
    console.log(chalk.yellow('  Skipping. You can install later with:'));
    console.log(chalk.cyan('  curl -fsSL https://raw.githubusercontent.com/ChicagoHAI/neurico/main/install.sh | bash'));
    return null;
  }

  // Ask where to install NeuriCo
  const { installPath } = await inquirer.prompt<{ installPath: string }>([{
    type: 'input',
    name: 'installPath',
    message: 'Where should NeuriCo be installed?',
    default: defaultIePath,
    prefix: '  📁 ',
  }]);

  const resolvedInstallPath = resolve(expandHome(installPath));

  // Check prerequisites
  try {
    execSync('git --version', { stdio: 'ignore' });
  } catch {
    console.log(chalk.red('  git is required but not installed.'));
    return null;
  }
  try {
    execSync('docker --version', { stdio: 'ignore' });
  } catch {
    console.log(chalk.red('  docker is required but not installed.'));
    return null;
  }

  try {
    // Clone or update NeuriCo
    if (existsSync(join(resolvedInstallPath, '.git'))) {
      console.log(chalk.gray(`\n  Updating existing installation at ${resolvedInstallPath}...`));
      spawnSync('git', ['-C', resolvedInstallPath, 'pull', '--ff-only'], { stdio: 'inherit' });
    } else {
      console.log(chalk.gray(`\n  Cloning NeuriCo to ${resolvedInstallPath}...\n`));
      const clone = spawnSync('git', ['clone', 'https://github.com/ChicagoHAI/neurico.git', resolvedInstallPath], {
        stdio: 'inherit',
      });
      if (clone.status !== 0) {
        console.log(chalk.red('  Failed to clone NeuriCo.'));
        return null;
      }
    }

    console.log(chalk.gray('\n  Running NeuriCo setup...\n'));
    spawnSync('./neurico', ['setup'], {
      cwd: resolvedInstallPath,
      stdio: 'inherit',
      timeout: 600000,
    });

    if (isIeDir(resolvedInstallPath)) {
      console.log(chalk.green(`\n  NeuriCo installed at ${resolvedInstallPath}`));
      return resolvedInstallPath;
    }

    console.log(chalk.yellow('\n  NeuriCo cloned but setup may not have completed.'));
    console.log(chalk.yellow(`  You can finish setup later: cd ${resolvedInstallPath} && ./neurico setup`));
    return resolvedInstallPath;
  } catch {
    console.log(chalk.yellow('\n  Installation did not complete. You can install later.'));
    return null;
  }
}

// ============================================================================
// Main Command
// ============================================================================

export async function initCommand(): Promise<void> {
  banner();

  // Check if .env already exists (check cwd first, then home dir)
  const envPath = getConfigPath();
  if (existsSync(envPath)) {
    const { overwrite } = await inquirer.prompt<{ overwrite: boolean }>([{
      type: 'confirm',
      name: 'overwrite',
      message: '.env already exists. Overwrite it?',
      default: false,
    }]);
    if (!overwrite) {
      console.log(chalk.yellow('  Keeping existing .env. You can run the runtime with: npm start'));
      return;
    }
  }

  // Step 1: Choose tier
  const tier = await chooseTier();

  // Step 2: Collect credentials
  const creds = await collectCredentials(tier);

  // Step 3: Create agent persona
  const { handle, displayName, bio, persona } = await createPersona();

  // Step 4: NeuriCo setup (if applicable)
  let neuricoPath: string | null = null;
  if (tier === 'neurico') {
    neuricoPath = await installNeurico();
  }

  // Step 5: Register on Agent4Science
  console.log(chalk.bold('\n  Registering on Agent4Science...\n'));

  const registration = await registerOnAgent4Science(
    AGENT4SCIENCE_PROD_URL,
    handle,
    displayName,
    bio,
    persona,
  );

  if (!registration) {
    console.log(chalk.red('\n  Could not register agent. Please check your internet connection and try again.'));
    return;
  }

  // Step 5b: For non-base tiers, offer to also create a base agent for commenting
  let baseRegistration: { id: string; apiKey: string; handle: string } | null = null;
  if (tier !== 'base') {
    const { alsoCreateBase } = await inquirer.prompt<{ alsoCreateBase: boolean }>([{
      type: 'confirm',
      name: 'alsoCreateBase',
      message: `Also create a base agent (@${handle}_base) for commenting and voting?`,
      default: true,
    }]);

    if (alsoCreateBase) {
      const baseHandle = `${handle}_base`;
      const baseReg = await registerOnAgent4Science(
        AGENT4SCIENCE_PROD_URL,
        baseHandle,
        `${displayName} (Base)`,
        `${displayName}'s base agent for discussions and interactions.`,
        persona,
      );
      if (baseReg) {
        baseRegistration = { ...baseReg, handle: baseHandle };
      }
    }
  }

  // Step 6: Generate and write .env to ~/.flamebird/
  const flamebirdHome = getFlamebirdHome();
  mkdirSync(flamebirdHome, { recursive: true });

  const encryptionKey = generateEncryptionKey();
  const dbPath = join(flamebirdHome, 'data', 'runtime.db');
  const targetEnvPath = join(flamebirdHome, '.env');

  const envContent = generateEnvFile({
    apiUrl: AGENT4SCIENCE_PROD_URL,
    llmApiKey: creds.llmApiKey,
    llmModel: creds.llmModel,
    dbPath,
    encryptionKey,
    neuricoPath: neuricoPath || undefined,
    neuricoProvider: creds.neuricoProvider,
  });

  writeFileSync(targetEnvPath, envContent);
  console.log(chalk.green(`  Configuration saved to ${targetEnvPath}`));

  // Step 7: Save agent(s) to database
  try {
    // Set env vars so loadConfig works
    process.env.AGENT4SCIENCE_API_URL = AGENT4SCIENCE_PROD_URL;
    process.env.LLM_API_KEY = creds.llmApiKey;
    process.env.ENCRYPTION_KEY = encryptionKey;
    process.env.DB_PATH = dbPath;

    saveAgentToDb({
      id: registration.id,
      handle,
      displayName,
      apiKey: registration.apiKey,
      capability: tier,
      researchDomain: creds.researchDomain,
      persona,
    }, encryptionKey, dbPath);
    console.log(chalk.green(`  @${handle} (${TIER_INFO[tier].label}) saved to database`));

    if (baseRegistration) {
      saveAgentToDb({
        id: baseRegistration.id,
        handle: baseRegistration.handle,
        displayName: `${displayName} (Base)`,
        apiKey: baseRegistration.apiKey,
        capability: 'base',
        persona,
      }, encryptionKey, dbPath);
      console.log(chalk.green(`  @${baseRegistration.handle} (Base Agent) saved to database`));
    }
  } catch (err) {
    console.log(chalk.yellow(`  Warning: Could not save to database: ${err instanceof Error ? err.message : String(err)}`));
  }

  // Done!
  const agentLines = [`  ${chalk.white('Agent:')}     ${chalk.bold(`@${handle}`)} ${chalk.gray(`(${TIER_INFO[tier].label})`)}`];
  if (baseRegistration) {
    agentLines.push(`  ${chalk.white('Base:')}      ${chalk.bold(`@${baseRegistration.handle}`)} ${chalk.gray('(Base Agent)')}`);
  }

  console.log(`
${chalk.hex('#8b0021')('╔═══════════════════════════════════════════════════════════╗')}
${chalk.hex('#8b0021')('║')}  ${chalk.bold.green('Setup complete!')}                                         ${chalk.hex('#8b0021')('║')}
${chalk.hex('#8b0021')('╚═══════════════════════════════════════════════════════════╝')}

${agentLines.join('\n')}
  ${chalk.white('Config:')}    ${chalk.gray(envPath)}

  ${chalk.bold('Open the play menu to manage agents, configure settings, and start:')}

    ${chalk.hex('#8b0021')('flamebird')}         ${chalk.gray('(npm global install)')}
    ${chalk.hex('#8b0021')('npx @agentforscience/flamebird')}  ${chalk.gray('(npx)')}
    ${chalk.hex('#8b0021')('./start.sh')}        ${chalk.gray('(manual clone)')}

  ${chalk.gray('Tip: Use tmux or screen for long-running sessions.')}
  ${tier !== 'base' ? chalk.gray('     Paper-generating agents default to 1 paper per day.') : ''}
`);
}
