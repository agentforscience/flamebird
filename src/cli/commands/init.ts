/**
 * Init Command
 * One-liner setup wizard for new users:
 *   npx agent4science-agent-runtime init
 *
 * Steps:
 *   1. Choose agent tier (base / idea-explorer)
 *   2. Collect credentials per tier
 *   3. Create agent persona
 *   4. Register agent on Agent4Science
 *   5. Write .env
 *   6. (idea-explorer tier) Run idea-explorer installer
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import { existsSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { spawnSync } from 'child_process';
import { createDatabase, getDatabase } from '../../db/database.js';
import { encryptApiKey } from '../../agents/agent-manager.js';
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
  'idea-explorer': {
    label: 'Idea Explorer',
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
      error?: string;
    };

    if (!result.success) {
      spinner.fail(`Registration failed: ${result.error}`);
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
  githubToken?: string;
  githubOrg?: string;
  ideaExplorerPath?: string;
  ideaExplorerProvider?: string;
}): string {
  const lines: string[] = [
    '# ============================================',
    '# Agent4Science Agent Runtime - Configuration',
    '# Generated by: npx agent4science-agent-runtime init',
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

  if (options.githubToken) {
    lines.push('', '# GitHub (for paper generation)');
    lines.push(`GITHUB_TOKEN=${options.githubToken}`);
    if (options.githubOrg) {
      lines.push(`GITHUB_ORG=${options.githubOrg}`);
    }
  }

  if (options.ideaExplorerPath) {
    lines.push('', '# Idea Explorer');
    lines.push(`IDEA_EXPLORER_PATH=${options.ideaExplorerPath}`);
    if (options.ideaExplorerProvider) {
      lines.push(`IDEA_EXPLORER_PROVIDER=${options.ideaExplorerProvider}`);
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
      { name: `${chalk.magenta('Idea Explorer')} - all of Base + generates and publishes research papers`, value: 'idea-explorer' },
    ],
  }]);

  return tier;
}

async function collectCredentials(tier: AgentCapability): Promise<{
  llmApiKey: string;
  llmModel: string;
  githubToken?: string;
  githubOrg?: string;
  ideaExplorerProvider?: string;
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
    message: 'LLM model:',
    default: 'anthropic/claude-sonnet-4',
  }]);

  const result: {
    llmApiKey: string;
    llmModel: string;
    githubToken?: string;
    githubOrg?: string;
    ideaExplorerProvider?: string;
    researchDomain?: string;
  } = { llmApiKey, llmModel };

  // GitHub token (idea-explorer)
  if (tier === 'idea-explorer') {
    console.log(chalk.gray('\n  GitHub token is needed to push generated paper repos.'));
    console.log(chalk.gray('  Create one at: https://github.com/settings/tokens\n'));

    const { githubToken } = await inquirer.prompt<{ githubToken: string }>([{
      type: 'password',
      name: 'githubToken',
      message: 'GitHub Personal Access Token:',
      mask: '*',
      validate: (v: string) => v.length > 0 || 'Required for paper generation',
    }]);
    result.githubToken = githubToken;

    const { githubOrg } = await inquirer.prompt<{ githubOrg: string }>([{
      type: 'input',
      name: 'githubOrg',
      message: 'GitHub org (leave blank to use personal account):',
      default: '',
    }]);
    if (githubOrg) result.githubOrg = githubOrg;
  }

  // Idea Explorer provider
  if (tier === 'idea-explorer') {
    const { provider } = await inquirer.prompt<{ provider: string }>([{
      type: 'list',
      name: 'provider',
      message: 'AI provider for Idea Explorer:',
      choices: [
        { name: 'Claude (Anthropic)', value: 'claude' },
        { name: 'Codex (OpenAI)', value: 'codex' },
        { name: 'Gemini (Google)', value: 'gemini' },
      ],
    }]);
    result.ideaExplorerProvider = provider;

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

async function installIdeaExplorer(): Promise<string | null> {
  console.log(chalk.bold('\n  Idea Explorer Setup\n'));

  // Check if already installed
  const commonPaths = [
    resolve(process.env.HOME || '~', 'idea-explorer'),
    resolve('.', 'idea-explorer'),
    process.env.IDEA_EXPLORER_PATH || '',
  ].filter(Boolean);

  const isIeDir = (dir: string) =>
    existsSync(resolve(dir, 'pyproject.toml')) &&
    existsSync(resolve(dir, 'src', 'core', 'runner.py'));

  for (const p of commonPaths) {
    const resolved = isIeDir(p) ? p
      : isIeDir(resolve(p, 'idea-explorer')) ? resolve(p, 'idea-explorer')
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
    message: 'Idea Explorer is not installed. Install it now?',
    default: true,
  }]);

  if (!install) {
    console.log(chalk.yellow('  Skipping. You can install later with:'));
    console.log(chalk.cyan('  curl -fsSL https://raw.githubusercontent.com/ChicagoHAI/idea-explorer/main/install.sh | bash'));
    return null;
  }

  console.log(chalk.gray('\n  Running idea-explorer installer...\n'));

  try {
    // Run the installer in interactive mode (inherits stdio for user input)
    spawnSync('bash', ['-c', 'curl -fsSL https://raw.githubusercontent.com/ChicagoHAI/idea-explorer/main/install.sh | bash'], {
      stdio: 'inherit',
      timeout: 600000, // 10 minutes
    });

    // Check common install location
    const homePath = resolve(process.env.HOME || '~', 'idea-explorer');
    if (isIeDir(homePath)) {
      console.log(chalk.green(`\n  Idea Explorer installed at ${homePath}`));
      return homePath;
    }

    // Ask where it was installed
    const { iePath } = await inquirer.prompt<{ iePath: string }>([{
      type: 'input',
      name: 'iePath',
      message: 'Where was idea-explorer installed?',
      default: homePath,
    }]);
    return iePath;
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

  // Check if .env already exists
  const envPath = resolve('.env');
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

  // Step 4: Idea Explorer setup (if applicable)
  let ideaExplorerPath: string | null = null;
  if (tier === 'idea-explorer') {
    ideaExplorerPath = await installIdeaExplorer();
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

  // Step 6: Generate and write .env
  const encryptionKey = generateEncryptionKey();
  const dbPath = './data/runtime.db';

  const envContent = generateEnvFile({
    apiUrl: AGENT4SCIENCE_PROD_URL,
    llmApiKey: creds.llmApiKey,
    llmModel: creds.llmModel,
    dbPath,
    encryptionKey,
    githubToken: creds.githubToken,
    githubOrg: creds.githubOrg,
    ideaExplorerPath: ideaExplorerPath || undefined,
    ideaExplorerProvider: creds.ideaExplorerProvider,
  });

  writeFileSync(envPath, envContent);
  console.log(chalk.green('  .env written'));

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

    ${chalk.hex('#8b0021')('./start.sh')}       ${chalk.gray('or')}       ${chalk.hex('#8b0021')('npx tsx src/cli/index.ts')}

  ${chalk.gray('Tip: Use tmux or screen for long-running sessions.')}
  ${tier !== 'base' ? chalk.gray('     Paper-generating agents default to 1 paper per day.') : ''}
`);
}
