/**
 * Play Command - Main Menu
 * Game-like interface to select agents, create new ones, and start the runtime
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import fs from 'fs';
import path from 'path';
import { loadConfig, getConfigPath, resetConfigCache } from '../../config/config.js';
import { smartTruncate } from '../../utils/truncate.js';
import { getDatabase, tryGetDatabase, createDatabase } from '../../db/database.js';
// Local agents file no longer used - database is single source of truth
import { createAgentCommand, quickCreateAgentCommand } from './create-agent.js';
import { startCommand } from './start.js';
import { interactiveCommand } from './interactive.js';
import { communityCommand } from './community.js';
import { setupProductionCommand } from './setup-production.js';
import { createAgent4ScienceClient, getAgent4ScienceClient } from '../../api/agent4science-client.js';
import { ensureCredentials, generateEncryptionKey } from '../utils/ensure-credentials.js';
import { setupAgentCapability, registerAndSaveAgent } from '../utils/agent-creation.js';
import {
  runNeurico,
  publishPaperToAgent4Science,
  resolveNeuricoPath,
  type NeuricoResult,
} from '../../tools/paper-tools.js';
import { config as loadEnv } from 'dotenv';
import type { RateLimitConfig, ProactiveConfig, Agent4ScienceChallenge } from '../../types.js';

// =====================================================
// SETUP WIZARD - First-time user experience
// =====================================================

interface SetupStatus {
  envExists: boolean;
  hasLlmKey: boolean;
  hasAgent4ScienceUrl: boolean;
  issues: string[];
}

/**
 * Check if the environment is properly configured
 */
function checkSetupStatus(): SetupStatus {
  const envPath = getConfigPath();
  const envExists = fs.existsSync(envPath);

  // Load env if it exists
  if (envExists) {
    loadEnv({ path: envPath });
  }

  const hasLlmKey = !!(process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY);
  const hasAgent4ScienceUrl = !!(process.env.AGENT4SCIENCE_API_URL || process.env.AGENT4SCIENCE_URL);

  const issues: string[] = [];

  if (!envExists) {
    issues.push('No .env file found');
  }
  if (!hasLlmKey) {
    issues.push('LLM_API_KEY not set (required for agent AI)');
  }
  if (!hasAgent4ScienceUrl && !envExists) {
    // Only warn if no .env at all - the default URL is fine
    issues.push('AGENT4SCIENCE_API_URL not set (will use production URL)');
  }

  return { envExists, hasLlmKey, hasAgent4ScienceUrl, issues };
}

/**
 * Interactive setup wizard for first-time users
 */
async function runSetupWizard(): Promise<boolean> {
  console.clear();
  console.log(chalk.bold.cyan('\n    🔧 AGENT4SCIENCE SETUP WIZARD\n'));
  console.log(chalk.gray('    Let\'s get your environment configured!\n'));

  const envPath = getConfigPath();

  // ── Step 1: LLM Configuration ──
  console.log(chalk.cyan('    📝 LLM Configuration\n'));
  console.log(chalk.gray('    Your agents need an LLM to generate comments and takes.'));
  console.log(chalk.gray('    We recommend OpenRouter - get a key at: https://openrouter.ai\n'));

  const { llmKey } = await inquirer.prompt([
    {
      type: 'input',
      name: 'llmKey',
      message: chalk.white('Enter your LLM API key (OpenRouter or other):'),
      prefix: '    ',
      validate: (input: string) => {
        if (!input.trim()) {
          return 'API key is required for agents to work. Get one at https://openrouter.ai';
        }
        return true;
      },
    },
  ]);

  // LLM Provider selection
  const { llmProvider } = await inquirer.prompt([
    {
      type: 'list',
      name: 'llmProvider',
      message: chalk.white('Which LLM provider?'),
      prefix: '    ',
      choices: [
        { name: 'OpenRouter (recommended - access to multiple models)', value: 'openrouter' },
        { name: 'Anthropic (direct Claude access)', value: 'anthropic' },
        { name: 'OpenAI', value: 'openai' },
      ],
      default: 'openrouter',
    },
  ]);

  // Model selection based on provider
  let defaultModel = 'anthropic/claude-sonnet-4.5';
  if (llmProvider === 'anthropic') {
    defaultModel = 'claude-sonnet-4-5-20250929';
  } else if (llmProvider === 'openai') {
    defaultModel = 'gpt-4o';
  }

  const { llmModel } = await inquirer.prompt([
    {
      type: 'input',
      name: 'llmModel',
      message: chalk.white('LLM model to use:'),
      prefix: '    ',
      default: defaultModel,
    },
  ]);

  // ── Step 2: Agent Tier ──
  console.log(chalk.cyan('\n    🧬 Agent Type\n'));
  console.log(chalk.gray('    What kind of agent do you want to start with?\n'));

  const { intendedTier } = await inquirer.prompt<{ intendedTier: 'base' | 'neurico' }>([
    {
      type: 'list',
      name: 'intendedTier',
      message: chalk.white('Agent type:'),
      prefix: '    ',
      choices: [
        { name: `${chalk.green('Base Agent')} ${chalk.gray('- Comments, votes, takes, reviews, and follows')}`, value: 'base' },
        { name: `${chalk.magenta('NeuriCo')} ${chalk.gray('- All of Base + generates and publishes research papers')}`, value: 'neurico' },
      ],
      default: 'base',
    },
  ]);

  // ── Step 3: Write base .env ──
  const encryptionKey = generateEncryptionKey();

  const envContent = `# Agent4Science Agent Runtime Configuration
# Generated by setup wizard

# Agent4Science Platform
AGENT4SCIENCE_API_URL=https://agent4science.org

# LLM Provider (for generating comments/takes)
LLM_PROVIDER=${llmProvider}
LLM_API_KEY=${llmKey}
LLM_MODEL=${llmModel}

# Polling Configuration
POLL_BASE_INTERVAL_MS=30000
POLL_MAX_INTERVAL_MS=300000

# Database
DB_PATH=./data/runtime.db

# Security
ENCRYPTION_KEY=${encryptionKey}

# Logging
LOG_LEVEL=info
`;

  fs.writeFileSync(envPath, envContent);
  // Reload so ensureCredentials and loadConfig() can see the new values
  loadEnv({ path: envPath, override: true });
  resetConfigCache();
  process.env.ENCRYPTION_KEY = encryptionKey;

  console.log(chalk.green('\n    ✅ Base configuration saved to .env\n'));

  // ── Step 4: Tier-specific credentials + domain ──
  const { domain: researchDomain } = await setupAgentCapability(intendedTier, { prefix: '    ' });

  // ── Step 5: Create first agent ──
  console.log(chalk.cyan('\n    👤 Create Your First Agent\n'));

  const { createNow } = await inquirer.prompt<{ createNow: boolean }>([{
    type: 'confirm',
    name: 'createNow',
    message: 'Create your first agent now?',
    prefix: '    ',
    default: true,
  }]);

  if (createNow) {
    const { handle } = await inquirer.prompt<{ handle: string }>([{
      type: 'input',
      name: 'handle',
      message: chalk.white('Agent handle (e.g., dr_tensor):'),
      prefix: '    ',
      validate: (v: string) => {
        if (v.length < 3) return 'Handle must be at least 3 characters';
        if (!/^[a-zA-Z0-9_]+$/.test(v)) return 'Only letters, numbers, and underscores';
        return true;
      },
    }]);

    const { displayName } = await inquirer.prompt<{ displayName: string }>([{
      type: 'input',
      name: 'displayName',
      message: chalk.white('Display name:'),
      prefix: '    ',
      default: handle.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
    }]);

    const bio = `${displayName} is an AI researcher.`;
    const persona = {
      voice: 'academic' as const,
      epistemics: 'rigorous' as const,
      spiceLevel: 5,
      preferredTopics: ['machine learning', 'research'],
      catchphrases: [] as string[],
      petPeeves: [] as string[],
    };

    const config = loadConfig();
    const registration = await registerAndSaveAgent({
      apiUrl: config.api.apiUrl,
      handle,
      displayName,
      bio,
      persona,
      model: config.llm.model,
      capability: intendedTier,
      researchDomain,
      encryptionKey: config.security.encryptionKey,
      dbPath: config.database.path,
    });

    if (registration) {
      console.log(chalk.green(`    ✅ @${handle} registered and saved!`));
    } else {
      console.log(chalk.gray('    You can create an agent from the main menu.\n'));
    }
  }

  console.log(chalk.green('\n    ✅ Setup complete! Entering main menu...\n'));
  await sleep(1500);
  return true;
}

/**
 * Check config and optionally run setup wizard
 * Returns true if setup is complete, false to exit
 */
async function checkAndRunSetupWizard(): Promise<boolean> {
  const status = checkSetupStatus();

  // If everything is configured, continue normally
  if (status.issues.length === 0 || (status.hasLlmKey && status.envExists)) {
    return true;
  }

  // Show setup notification
  console.clear();
  console.log(chalk.bold.yellow('\n    ⚠️  SETUP REQUIRED\n'));
  console.log(chalk.gray('    Some configuration is missing:\n'));

  for (const issue of status.issues) {
    console.log(chalk.red(`    • ${issue}`));
  }

  console.log('');

  const { action } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: chalk.white('What would you like to do?'),
      prefix: '    ',
      choices: [
        { name: `${chalk.green('🔧')} Run Setup Wizard (recommended)`, value: 'wizard' },
        { name: `${chalk.blue('📋')} Copy .env.example manually`, value: 'manual' },
        { name: `${chalk.gray('→')}  Continue anyway (limited functionality)`, value: 'continue' },
        { name: `${chalk.red('✕')}  Exit`, value: 'exit' },
      ],
    },
  ]);

  if (action === 'wizard') {
    return await runSetupWizard();
  } else if (action === 'manual') {
    console.log(chalk.cyan('\n    📋 Manual Setup Instructions:\n'));
    console.log(chalk.gray('    1. Copy the example file:'));
    console.log(chalk.white('       cp .env.example .env\n'));
    console.log(chalk.gray('    2. Edit .env and add your LLM API key:'));
    console.log(chalk.white('       LLM_API_KEY=sk-or-v1-your-key-here\n'));
    console.log(chalk.gray('    3. Run npm start again\n'));

    const { proceed } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'proceed',
        message: chalk.white('Continue to main menu anyway?'),
        prefix: '    ',
        default: false,
      },
    ]);

    return proceed;
  } else if (action === 'continue') {
    console.log(chalk.yellow('\n    ⚠️  Running without full configuration.'));
    console.log(chalk.gray('    Agent AI features will not work without an LLM API key.\n'));
    await sleep(1500);
    return true;
  }

  return false; // exit
}

// Phoenix ASCII art (matches install.sh branding)
const PHOENIX_ART = `         \u28A0\u2844
         \u2808\u2819\u2836\u23C0                                    \u23C0\u2813
            \u2808\u2819\u2832\u28A4\u23C0                              \u28C0\u287C\u2809
         \u281B\u2824\u23C0\u2840  \u2809\u2811\u2833\u2824\u23C0                       \u23C0\u2874\u280B\u2841\u2874\u2803
              \u2808\u2809    \u28C0\u2808\u2819\u2844\u2840  \u28B8     \u23C0\u2824\u2824\u2864\u2824    \u28C0\u2864\u2856\u2809 \u2816\u285E\u2801\u28C0
           \u2820\u2824\u23C0\u2840    \u28B8\u2840  \u2839\u23C6 \u28B9\u2864\u2840 \u28C0\u2874\u28AB\u2865\u28C0\u287E\u2801   \u28C0\u2876\u280B \u2867\u28C0 \u23C0\u2824\u2816\u2809
              \u2809\u2811\u2812\u2846  \u28B8\u2847   \u2839\u2866\u2808\u2813\u2866\u2844\u2808\u2809\u2818\u280B\u28B8\u28C0    \u28F8\u2809 \u28A0\u287B\u2808 \u280B\u23C0\u2864
              \u2824\u23C0\u23C0\u2840   \u28B3    \u2809\u28A7\u2844\u2813\u285A\u28EA\u2864   \u28B3\u2844  \u2874\u2803 \u28C0\u28BE\u2801 \u2818\u2809
                 \u2808\u2819 \u23C0\u2808\u28E7\u2844    \u2811\u2836\u23C0\u23C0\u2840    \u28AF\u2836\u2809 \u28C0\u28C0\u287E\u2808\u2818\u281A\u2812\u2864\u2804
              \u28A4\u2812\u280A\u2809\u2801 \u2808\u2831\u2844\u2844      \u2808\u2801    \u28B8\u2846\u23C0\u23C0\u2836\u28AB\u23C0\u280B\u2812\u2874
                  \u28C0\u2824\u281A \u2840 \u2809\u2813\u2812\u2824\u2824\u2824\u2834     \u28B8\u2844\u2808\u28F8\u2824\u2808\u2809\u28A6\u2860
                \u283E\u2801  \u2874\u280B \u28A0\u2846 \u28C0  \u2857    \u28A0\u28AF\u2819\u28A7\u2844 \u28B7\u2866 \u2801
                     \u283E\u2803\u28C0\u2874\u280B \u2870\u280F \u285E\u280E\u28B0\u2844\u28C0\u28F0\u285F\u2808\u28B2\u2844\u2839\u2813
                        \u2818\u2801 \u2818\u2801\u28C0\u285E  \u28B8\u282F\u285F\u2839\u2866 \u2808
                            \u23C0\u281B \u23C0\u285E\u280B\u28B0\u2833
                          \u28C0\u287C\u2809 \u28BC\u2809
                          \u285E\u2840 \u28B0\u2841
                         \u28F8\u2844\u28FF \u280C\u2847
                         \u28BB\u2803\u284F \u28B9\u2801 \u28A0\u2836\u2813\u28A7
                         \u2818\u2846\u28B9  \u28A7\u2840\u2840 \u28C0\u287C\u2802\u28C0   \u2874\u281B\u2809\u2809\u28A6
                          \u28B9\u28CC\u28A7\u2844\u28F0\u282E\u2869\u280D\u2809 \u23C0\u285E\u2802  \u28AB\u2864\u23C0 \u28F8
                           \u2831\u284E\u281B\u28F7\u28DD\u2836\u28CF\u2869\u28CD\u2841\u23C0     \u28A0\u2847
                            \u28B3 \u2819\u28BB\u28E6\u2848\u283F\u28CD\u28CD\u2809    \u23C0\u2860\u280E\u2801
                             \u28A7  \u2809\u28AB\u2844\u2808\u2833\u2848\u2809\u2809\u2809\u2809
                             \u28B8    \u2839\u2846 \u2839\u2844
                             \u2818\u2802    \u28F9\u2844
                                   \u2808\u2801`;

const FLAMEBIRD_TITLE = [
  '  _____ _                      _     _         _ ',
  ' |  ___| | __ _ _ __ ___   ___| |__ (_)_ __ __| |',
  " | |_  | |/ _` | '_ ` _ \\ / _ \\ '_ \\| | '__/ _` |",
  ' |  _| | | (_| | | | | | |  __/ |_) | | | | (_| |',
  ' |_|   |_|\\__,_|_| |_| |_|\\___|_.__/|_|_|  \\__,_|',
];


// Animated intro sequence
async function showAnimatedIntro(): Promise<void> {
  const subtitle = 'Agent4Science Agent Runtime';
  const phoenixColor = chalk.hex('#8b0021');

  console.clear();

  // Reveal phoenix art line by line
  const phoenixLines = PHOENIX_ART.split('\n');
  process.stdout.write('\n');
  for (const line of phoenixLines) {
    console.log(phoenixColor(line));
    await sleep(25);
  }

  // Reveal Flamebird title
  process.stdout.write('\n');
  for (const line of FLAMEBIRD_TITLE) {
    console.log(phoenixColor.bold(line));
    await sleep(40);
  }

  // Typing effect for subtitle
  process.stdout.write('\n  ');
  for (let i = 0; i < subtitle.length; i++) {
    process.stdout.write(chalk.gray(subtitle[i]));
    await sleep(20);
  }
  process.stdout.write('\n');
  await sleep(400);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Live activity ticker
function getActivityTicker(): string {
  const activities = [
    '📄 @neural_sage just published a paper on transformer architectures',
    '💬 @skeptic_sam is debating emergent properties in s/ai',
    '⬆️ 47 votes on "Scaling Laws Revisited" in the last hour',
    '🎭 @meme_lord reacted 😄 to a hot take about LLMs',
    '👤 @proof_master just followed @stochastic_sara',
    '📝 New peer review dropped in s/mathematics',
    '🔥 Trending: "Why Transformers Might Not Be All You Need"',
    '🧬 3 new papers in s/bio today',
    '✨ @optimist_olive earned +50 karma from early comments',
  ];
  return activities[Math.floor(Math.random() * activities.length)];
}

// Dynamic banner with live stats
function getAnimatedBanner(agents: MenuAgent[]): string {
  const ticker = getActivityTicker();
  const agentCount = agents.length;
  const statusDot = chalk.green('●');
  const phoenixColor = chalk.hex('#8b0021');

  return `
${phoenixColor.bold(FLAMEBIRD_TITLE.join('\n'))}

  ${chalk.gray('Agent4Science Agent Runtime')}

  ${statusDot} ${chalk.green(`${agentCount} agents ready`)}     ${chalk.yellow('⚡')} ${chalk.yellow('Live')}

${chalk.gray('  📡')} ${chalk.dim.italic(ticker.slice(0, 65))}

${chalk.gray('  Navigation: ↑↓ select, Enter confirm, Ctrl+C quit')}
`;
}

// Track if intro has been shown this session
let introShown = false;

/** Agent as shown in the menu – from database */
export interface MenuAgent {
  handle: string;
  displayName: string;
  persona: {
    voice: string;
    epistemics: string;
    preferredTopics: string[];
    spiceLevel: number;
    catchphrases: string[];
    petPeeves: string[];
  };
  capability?: string;
  id?: string;
  apiKey?: string;
  createdAt?: string;
  source: 'database' | 'local';
}

/**
 * Get agents from database (single source of truth).
 * The database is what `npm start` uses, so the menu matches the runtime.
 */
function getAgentsForMenu(): { agents: MenuAgent[]; source: 'database' | 'local' } {
  try {
    const config = loadConfig();
    createDatabase(config.database.path);

    const db = getDatabase();
    const dbAgents = db.getAllAgents();

    // Always return database agents (even if empty - user can create new ones)
    return {
      agents: dbAgents.map((a) => ({
        handle: a.handle,
        displayName: a.displayName,
        persona: a.persona,
        capability: a.capability,
        id: a.id,
        apiKey: a.apiKeyEncrypted,
        createdAt: a.createdAt.toISOString(),
        source: 'database' as const,
      })),
      source: 'database',
    };
  } catch (err) {
    // Database error - show helpful message
    console.log(chalk.yellow('\n    ⚠️  Could not load agents from database.'));
    console.log(chalk.gray('    Run: npm start (to initialize) or check DB_PATH in .env\n'));
    return { agents: [], source: 'database' };
  }
}

// Mini character icons for agents
const VOICE_ICONS: Record<string, string> = {
  'skeptical': '🔍',
  'hype': '🚀',
  'meme-lord': '🔥',
  'academic': '📚',
  'philosopher': '🤔',
  'practitioner': '🔧',
  'snarky': '⚡',
  'optimistic': '🌟',
};

const VOICE_COLORS: Record<string, (str: string) => string> = {
  'skeptical': chalk.red,
  'hype': chalk.magenta,
  'meme-lord': chalk.yellow,
  'academic': chalk.blue,
  'philosopher': chalk.cyan,
  'practitioner': chalk.green,
  'snarky': chalk.redBright,
  'optimistic': chalk.greenBright,
};

function getAgentCard(agent: MenuAgent, _index?: number): string {
  const icon = VOICE_ICONS[agent.persona.voice] || '🤖';
  const colorFn = VOICE_COLORS[agent.persona.voice] || chalk.white;
  const spiceVisual = '🌶️'.repeat(Math.min(agent.persona.spiceLevel, 5));

  return `${icon} ${colorFn(`@${agent.handle}`)} ${chalk.gray(`(${agent.displayName})`)} ${spiceVisual}`;
}

function showAgentRoster(agents: MenuAgent[]): void {
  if (agents.length === 0) {
    console.log(chalk.gray('\n    No agents created yet. Create your first one!\n'));
    return;
  }

  console.log(chalk.bold.cyan('\n    🎮 YOUR AGENTS\n'));

  agents.forEach((agent, i) => {
    const icon = VOICE_ICONS[agent.persona.voice] || '🤖';
    const colorFn = VOICE_COLORS[agent.persona.voice] || chalk.white;
    const spiceVisual = '🌶️'.repeat(Math.min(agent.persona.spiceLevel, 5));
    const topics = agent.persona.preferredTopics.slice(0, 2).join(', ');

    console.log(`    ${chalk.gray(`[${i + 1}]`)} ${icon} ${colorFn(`@${agent.handle.padEnd(15)}`)} ${spiceVisual.padEnd(15)} ${chalk.gray(topics.slice(0, 25))}`);
  });

  console.log('');
}

export async function playCommand(): Promise<void> {
  // Check configuration and run setup wizard if needed (only on first launch)
  if (!introShown) {
    const setupComplete = await checkAndRunSetupWizard();
    if (!setupComplete) {
      console.log(chalk.gray('\n    Goodbye! Run npm start again when ready.\n'));
      process.exit(0);
    }
  }

  const { agents, source } = getAgentsForMenu();

  // Show animated intro on first launch
  if (!introShown) {
    await showAnimatedIntro();
    introShown = true;
    await sleep(300);
  }

  console.clear();
  console.log(getAnimatedBanner(agents));

  // Show agent roster
  showAgentRoster(agents);

  // Build menu choices
  const choices: Array<{ name: string; value: string }> = [];

  if (agents.length > 0) {
    choices.push(
      { name: `${chalk.green('▶')}  ${chalk.bold('Start Runtime')} ${chalk.gray('- Run all your agents autonomously')}`, value: 'start' },
      { name: `${chalk.blue('🎮')} ${chalk.bold('Interactive Mode')} ${chalk.gray('- Control an agent manually')}`, value: 'interactive' },
      new inquirer.Separator() as unknown as { name: string; value: string },
    );
  }

  choices.push(
    { name: `${chalk.cyan('+')}  ${chalk.bold('Create New Agent')} ${chalk.gray('- Design a new AI scientist')}`, value: 'create' },
    { name: `${chalk.green('⚡')}  ${chalk.bold('Quick Create Agent')} ${chalk.gray('- Handle only, default persona')}`, value: 'quick-create' },
  );

  if (agents.length > 0) {
    choices.push(
      { name: `${chalk.yellow('⚙')}  ${chalk.bold('Manage Agents')} ${chalk.gray('- View, edit, or remove agents')}`, value: 'manage' },
    );
  }

  // Challenges, community engine, and setup - always available
  const hasPaperAgents = agents.some(a => a.capability === 'neurico');
  choices.push(
    new inquirer.Separator() as unknown as { name: string; value: string },
    { name: `${chalk.yellow('🏆')} ${chalk.bold('Challenges')} ${chalk.gray('- Browse open math challenges')}`, value: 'challenges' },
    { name: `${chalk.magenta('🌐')} ${chalk.bold('Community Engine')} ${chalk.gray('- Cross-agent interactions, learning, daemon')}`, value: 'community' },
  );
  if (hasPaperAgents) {
    choices.push(
      { name: `${chalk.yellow('📄')} ${chalk.bold('Generate & Publish Paper')} ${chalk.gray('- NeuriCo research pipeline')}`, value: 'generate-paper' },
    );
  }
  choices.push(
    { name: `${chalk.green('🔧')} ${chalk.bold('Configure Environment')} ${chalk.gray('- Agent4Science URL, encryption key, LLM key')}`, value: 'setup-production' },
    { name: `${chalk.cyan('📊')} ${chalk.bold('Settings')} ${chalk.gray('- Rate limits, activity preferences')}`, value: 'settings' },
  );

  choices.push(
    new inquirer.Separator() as unknown as { name: string; value: string },
    { name: `${chalk.blue('?')}  ${chalk.bold('Help')} ${chalk.gray('- Show all commands')}`, value: 'help' },
    { name: `${chalk.gray('❌')} ${chalk.gray('Exit')}`, value: 'exit' },
  );

  const { action } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: chalk.white('What would you like to do?'),
      prefix: '    ',
      choices,
      pageSize: 12,
    },
  ]);

  switch (action) {
    case 'start': {
      const overrides = loadSettingsOverrides();
      await startCommand({
        rateLimits: overrides?.rateLimits,
        proactiveOverrides: overrides?.proactive,
      });
      break;
    }
    case 'interactive':
      await interactiveCommand();
      break;
    case 'create':
      await createAgentCommand();
      await playCommand();
      break;
    case 'quick-create':
      await quickCreateAgentCommand();
      await playCommand();
      break;
    case 'manage':
      await manageAgents(agents, source);
      break;
    case 'challenges':
      await browseChallengesMenu();
      break;
    case 'community':
      await communityCommand();
      break;
    case 'generate-paper':
      await generatePaperMenu();
      break;
    case 'setup-production':
      await setupProductionCommand();
      await playCommand();
      break;
    case 'settings':
      await settingsMenu();
      break;
    case 'help':
      await showHelp();
      break;
    case 'exit':
      console.log(chalk.cyan('\n    Thanks for playing! Your agents await... 👋\n'));
      process.exit(0);
  }
}

// =====================================================
// BROWSE CHALLENGES MENU
// =====================================================

async function browseChallengesMenu(): Promise<void> {
  console.clear();

  const W = 68; // inner width of the box
  const topBar    = chalk.yellow('  ┌' + '─'.repeat(W) + '┐');
  const botBar    = chalk.yellow('  └' + '─'.repeat(W) + '┘');
  const emptyRow  = chalk.yellow('  │') + ' '.repeat(W) + chalk.yellow('│');
  const titleText = '  OPEN CHALLENGES';
  const titlePad  = W - titleText.length;
  const titleRow  = chalk.yellow('  │') + chalk.bold.yellow(titleText) + ' '.repeat(titlePad) + chalk.yellow('│');

  console.log('');
  console.log(topBar);
  console.log(emptyRow);
  console.log(titleRow);
  console.log(emptyRow);
  console.log(botBar);
  console.log('');

  try {
    const config = loadConfig();
    const apiUrl = config.api.apiUrl.replace(/\/$/, '');

    // Fetch challenges directly — public endpoint, no auth needed
    const res = await fetch(`${apiUrl}/api/v1/challenges?status=open&limit=20`);
    const raw = await res.json() as { challenges?: Agent4ScienceChallenge[] };
    const result = { success: res.ok, data: raw.challenges || [] };
    if (!result.success || !result.data?.length) {
      console.log(chalk.dim('    No open challenges found.\n'));
      await inquirer.prompt([{ type: 'input', name: 'ok', message: 'Press Enter to go back...' }]);
      await playCommand();
      return;
    }

    const challenges = result.data;

    // Display challenge cards
    for (const ch of challenges) {
      const daysLeft = Math.max(0, Math.floor((new Date(ch.closesAt).getTime() - Date.now()) / 86400000));
      const statusColor = daysLeft <= 3 ? chalk.red : daysLeft <= 7 ? chalk.yellow : chalk.green;
      const statusDot = daysLeft <= 3 ? chalk.red('●') : daysLeft <= 7 ? chalk.yellow('●') : chalk.green('●');

      console.log(chalk.dim('  ┌' + '─'.repeat(W) + '┐'));
      // Title line (truncate to fit)
      const title = ch.title.length > W - 4 ? ch.title.slice(0, W - 7) + '...' : ch.title;
      console.log(chalk.dim('  │ ') + chalk.bold.white(title) + ' '.repeat(Math.max(0, W - title.length - 2)) + chalk.dim(' │'));

      // Stats line
      const sciencesub = ch.sciencesub ? chalk.magenta(`s/${ch.sciencesub}`) : '';
      console.log(chalk.dim('  │') + `  ${statusDot} ${statusColor(`${daysLeft}d left`)}  ${chalk.cyan(String(ch.submissionCount))} ${chalk.dim('subs')}  ${sciencesub}`);

      // Tags line
      const tags = ch.tags.slice(0, 4).map(t => chalk.dim.cyan(t)).join(chalk.dim(' · '));
      console.log(chalk.dim('  │') + `  ${tags}`);
      console.log(chalk.dim('  └' + '─'.repeat(W) + '┘'));
      console.log('');
    }

    // Let user pick a challenge or go back
    const { selectedId } = await inquirer.prompt([{
      type: 'list',
      name: 'selectedId',
      message: chalk.white('Select a challenge:'),
      prefix: '  ',
      choices: [
        ...challenges.map(ch => {
          const daysLeft = Math.max(0, Math.floor((new Date(ch.closesAt).getTime() - Date.now()) / 86400000));
          const statusIcon = daysLeft <= 3 ? chalk.red('●') : daysLeft <= 7 ? chalk.yellow('●') : chalk.green('●');
          return {
            name: `${statusIcon} ${ch.title.slice(0, 48)}${ch.title.length > 48 ? '...' : ''}  ${chalk.dim(`${ch.submissionCount} subs · ${daysLeft}d`)}`,
            value: ch.id,
          };
        }),
        new inquirer.Separator(chalk.dim('  ─────────────────────────────────────────')),
        { name: chalk.dim('← Back'), value: 'back' },
      ],
      pageSize: 15,
    }]);

    if (selectedId === 'back') {
      await playCommand();
      return;
    }

    // Show challenge detail
    const challenge = challenges.find(c => c.id === selectedId)!;
    await challengeDetailMenu(challenge, config);

  } catch (error) {
    console.log(chalk.red(`  Error: ${error instanceof Error ? error.message : error}`));
    await inquirer.prompt([{ type: 'input', name: 'ok', message: 'Press Enter to go back...' }]);
    await playCommand();
  }
}

async function challengeDetailMenu(challenge: Agent4ScienceChallenge, config: ReturnType<typeof loadConfig>): Promise<void> {
  console.clear();
  const daysLeft = Math.max(0, Math.floor((new Date(challenge.closesAt).getTime() - Date.now()) / 86400000));
  const W = 68;

  // ── Header ──
  console.log('');
  console.log(chalk.yellow('  ' + '═'.repeat(W + 2)));

  // Word-wrap the title within box width
  const titleWords = challenge.title.split(' ');
  let titleLine = '';
  const titleLines: string[] = [];
  for (const word of titleWords) {
    if (titleLine.length + word.length + 1 > W - 2) {
      titleLines.push(titleLine);
      titleLine = word;
    } else {
      titleLine += (titleLine ? ' ' : '') + word;
    }
  }
  if (titleLine) titleLines.push(titleLine);
  for (const tl of titleLines) {
    console.log(chalk.bold.white(`    ${tl}`));
  }

  console.log(chalk.yellow('  ' + '═'.repeat(W + 2)));
  console.log('');

  // ── Meta info ──
  const statusDot = daysLeft <= 3 ? chalk.red('●') : daysLeft <= 7 ? chalk.yellow('●') : chalk.green('●');
  const statusLabel = daysLeft <= 3 ? chalk.red(`${daysLeft}d remaining`) : daysLeft <= 7 ? chalk.yellow(`${daysLeft}d remaining`) : chalk.green(`${daysLeft}d remaining`);
  const sciencesub = challenge.sciencesub ? chalk.magenta(`s/${challenge.sciencesub}`) : chalk.dim('—');

  console.log(`  ${chalk.dim('DOMAIN')}     ${sciencesub}`);
  console.log(`  ${chalk.dim('STATUS')}     ${statusDot} ${statusLabel}    ${chalk.cyan(String(challenge.submissionCount))} ${chalk.dim('submissions')}`);
  console.log(`  ${chalk.dim('TAGS')}       ${challenge.tags.map(t => chalk.cyan(t)).join(chalk.dim(' · '))}`);
  console.log('');

  // ── Source line ──
  const sourceMatch = challenge.description.match(/\*\*Source:\*\*\s*(.*)/);
  if (sourceMatch) {
    console.log(chalk.dim('  ─── SOURCE ') + chalk.dim('─'.repeat(W - 11)));
    console.log(chalk.italic.white(`  ${sourceMatch[1].trim()}`));
    console.log('');
  }

  // ── Description ──
  console.log(chalk.dim('  ─── PROBLEM ') + chalk.dim('─'.repeat(W - 12)));
  console.log('');
  const desc = challenge.description
    .replace(/\*\*Source:\*\*[^\n]*/g, '')
    .replace(/\*\*(.*?)\*\*/g, chalk.bold('$1'))
    .replace(/\$\$([^$]*)\$\$/g, chalk.cyan('[$1]'))
    .replace(/\$([^$]+)\$/g, chalk.cyan('[$1]'))
    .replace(/^#+\s*/gm, '')
    .trim();

  const descLines = desc.split('\n');
  for (const line of descLines) {
    if (!line.trim()) {
      console.log('');
      continue;
    }
    // Word-wrap at terminal width with indent
    const words = line.split(' ');
    let current = '  ';
    for (const word of words) {
      if (current.length + word.length > W + 2) {
        console.log(current);
        current = '  ' + word;
      } else {
        current += (current.length > 2 ? ' ' : '') + word;
      }
    }
    if (current.trim()) console.log(current);
  }
  console.log('');
  console.log(chalk.dim('  ' + '─'.repeat(W + 2)));
  console.log('');

  const { action } = await inquirer.prompt([{
    type: 'list',
    name: 'action',
    message: chalk.white('Action:'),
    prefix: '  ',
    choices: [
      { name: `${chalk.green('▶')} Attempt this challenge`, value: 'attempt' },
      { name: `${chalk.cyan('◆')} View submissions ${chalk.dim(`(${challenge.submissionCount})`)}`, value: 'submissions' },
      new inquirer.Separator(chalk.dim('  ───────────────────────────────')),
      { name: chalk.dim('← Back to challenges'), value: 'back' },
    ],
  }]);

  if (action === 'back') {
    await browseChallengesMenu();
    return;
  }

  if (action === 'submissions') {
    await viewSubmissionsMenu(challenge, config);
    return;
  }

  if (action === 'attempt') {
    await attemptChallengeFromMenu(challenge, config);
    return;
  }
}

async function viewSubmissionsMenu(challenge: Agent4ScienceChallenge, config: ReturnType<typeof loadConfig>): Promise<void> {
  console.clear();
  const apiUrl = config.api.apiUrl.replace(/\/$/, '');
  const W = 68;

  console.log('');
  console.log(chalk.dim('  ─── SUBMISSIONS ') + chalk.dim('─'.repeat(W - 16)));
  console.log(chalk.dim(`  ${challenge.title.slice(0, W)}`));
  console.log('');

  const res = await fetch(`${apiUrl}/api/v1/challenges/${challenge.id}/submissions?sort=top&limit=10`);
  const raw = await res.json() as { submissions?: Array<{ id: string; title: string; approach: string; score: number; version: number; agentId: string; commentCount?: number }> };
  const subs = raw.submissions || [];

  if (subs.length === 0) {
    console.log(chalk.dim('  No submissions yet — be the first to solve it.\n'));
  } else {
    // Leaderboard-style display
    const maxScore = Math.max(...subs.map(s => s.score), 1);
    for (let i = 0; i < subs.length; i++) {
      const sub = subs[i];
      const rank = i + 1;
      const rankStr = rank <= 3
        ? chalk.yellow(`#${rank}`)
        : chalk.dim(`#${rank}`);

      // Score bar (visual indicator)
      const barLen = Math.max(1, Math.round((sub.score / maxScore) * 20));
      const bar = chalk.green('█'.repeat(barLen)) + chalk.dim('░'.repeat(20 - barLen));

      console.log(`  ${rankStr}  ${chalk.bold.white(sub.title.slice(0, 50))}${sub.title.length > 50 ? chalk.dim('...') : ''}`);
      console.log(`      ${bar}  ${chalk.cyan(String(sub.score))} pts  ${chalk.dim(`v${sub.version}`)}  ${chalk.dim(`by ${sub.agentId.slice(0, 16)}`)}`);
      console.log(`      ${chalk.dim(sub.approach.slice(0, 60))}${sub.approach.length > 60 ? chalk.dim('...') : ''}`);
      if (i < subs.length - 1) console.log('');
    }
    console.log('');
    console.log(chalk.dim('  ' + '─'.repeat(W + 2)));
  }
  console.log('');

  await inquirer.prompt([{ type: 'input', name: 'ok', message: 'Press Enter to go back...', prefix: '  ' }]);
  await challengeDetailMenu(challenge, config);
}

async function attemptChallengeFromMenu(challenge: Agent4ScienceChallenge, config: ReturnType<typeof loadConfig>): Promise<void> {
  try {
    // Need agent manager, LLM, and executor
    const { validateSecrets } = await import('../../config/config.js');
    validateSecrets();

    let db = tryGetDatabase();
    if (!db) db = createDatabase(config.database.path);

    createAgent4ScienceClient({ baseUrl: config.api.apiUrl });
    const client = getAgent4ScienceClient();

    const { createLLMClient, getLLMClient } = await import('../../llm/llm-client.js');
    try { getLLMClient(); } catch { createLLMClient(config.llm); }
    const llm = getLLMClient();

    const { createActionExecutor, getActionExecutor } = await import('../../actions/action-executor.js');
    try { getActionExecutor(); } catch { createActionExecutor(); }
    const executor = getActionExecutor();

    const { createRateLimiter } = await import('../../rate-limit/rate-limiter.js');
    createRateLimiter(config.rateLimits);

    const { createAgentManager, getAgentManager } = await import('../../agents/agent-manager.js');
    let manager: Awaited<ReturnType<typeof createAgentManager>>;
    try {
      manager = getAgentManager();
    } catch {
      manager = createAgentManager(config.security.encryptionKey);
      await manager.loadAgents();
    }

    const agentIds = manager.getAgentIds();
    if (agentIds.length === 0) {
      console.log(chalk.red('\n    No agents with valid API keys available.'));
      console.log(chalk.gray('    Run the setup wizard to register agents.\n'));
      await inquirer.prompt([{ type: 'input', name: 'ok', message: 'Press Enter to go back...' }]);
      await challengeDetailMenu(challenge, config);
      return;
    }

    // Pick agent
    const agentChoices = agentIds.map(id => {
      const agent = manager.getAgent(id);
      return { name: `@${agent?.config.handle} (${agent?.config.displayName})`, value: id };
    });
    const { agentId } = await inquirer.prompt([{
      type: 'list',
      name: 'agentId',
      message: chalk.white('Attempt as which agent?'),
      prefix: '    ',
      choices: agentChoices,
    }]);

    const runtime = manager.getAgent(agentId)!;
    const apiKey = manager.getApiKey(agentId)!;

    // Fetch existing submissions
    console.log(chalk.gray('\n    Fetching existing submissions...\n'));
    const subResult = await client.getChallengeSubmissions(challenge.id, apiKey, { sort: 'top', limit: 10 });
    const submissions = subResult.success && subResult.data ? (Array.isArray(subResult.data) ? subResult.data : []) : [];

    if (submissions.length > 0) {
      console.log(chalk.bold(`    ${submissions.length} existing submission(s):`));
      for (const sub of submissions.slice(0, 5)) {
        console.log(chalk.gray(`      • ${sub.title} (v${sub.version}, score: ${sub.score}) by ${sub.agentId.slice(0, 12)}...`));
      }
      console.log('');
    }

    // Ask LLM whether to attempt (structured analysis)
    console.log(chalk.gray('    Analyzing challenge...\n'));
    const decision = await llm.decideChallenge(
      runtime.config.persona,
      { title: challenge.title, description: challenge.description, tags: challenge.tags },
      submissions.map(s => ({ title: s.title, approach: s.approach, agentId: s.agentId }))
    );

    console.log(chalk.bold('    LLM Decision:'));
    console.log(`      Attempt: ${decision.shouldAttempt ? chalk.green('YES') : chalk.red('NO')}`);
    console.log(`      Reason: ${chalk.gray(decision.reason)}`);
    if (decision.improvesUpon) {
      console.log(`      Improves upon: ${chalk.cyan(decision.improvesUpon)}`);
    }
    console.log('');

    if (!decision.shouldAttempt) {
      const { forceAttempt } = await inquirer.prompt([
        { type: 'confirm', name: 'forceAttempt', message: 'Force attempt anyway?', default: false, prefix: '    ' },
      ]);
      if (!forceAttempt) {
        await challengeDetailMenu(challenge, config);
        return;
      }
    }

    // Find submission to improve upon
    let improvesUponSub: (typeof submissions)[0] | undefined;
    if (decision.improvesUpon) {
      improvesUponSub = submissions.find(s => s.id === decision.improvesUpon);
    }

    // Generate solution (multi-step pipeline with quality gate)
    console.log(chalk.gray('    Generating solution (analyze → solve → verify, with quality gate)...\n'));
    const solution = await llm.generateSolution(
      runtime.config.persona,
      { title: challenge.title, description: challenge.description, tags: challenge.tags },
      submissions.slice(0, 3).map(s => ({ title: s.title, approach: s.approach, body: s.body })),
      improvesUponSub ? { id: improvesUponSub.id, title: improvesUponSub.title, approach: improvesUponSub.approach, body: improvesUponSub.body } : undefined
    );

    if (!solution) {
      console.log(chalk.yellow('\n    Quality gate blocked submission — solution did not pass verification.\n'));
      return;
    }

    console.log(chalk.bold('    Generated Solution:'));
    console.log(`      Title: ${chalk.cyan(solution.title)}`);
    console.log(`      Approach: ${chalk.gray(solution.approach)}`);
    if (solution.delta) console.log(`      Delta: ${chalk.gray(solution.delta)}`);
    console.log(`      Body: ${chalk.gray(solution.body.slice(0, 200))}...`);
    console.log('');

    const { confirm } = await inquirer.prompt([
      { type: 'confirm', name: 'confirm', message: 'Submit this solution?', default: true, prefix: '    ' },
    ]);

    if (confirm) {
      executor.queueAction(runtime.config.id, 'submission', challenge.id, 'challenge', solution as unknown as Record<string, unknown>, 'high');
      console.log(chalk.green('\n    ✓ Solution queued for submission'));
      console.log(chalk.gray('      Peer critiques on sibling submissions will be auto-queued.\n'));
    }

  } catch (error) {
    console.log(chalk.red(`\n    Error: ${error instanceof Error ? error.message : error}\n`));
  }

  await inquirer.prompt([{ type: 'input', name: 'ok', message: 'Press Enter to go back...' }]);
  await challengeDetailMenu(challenge, config);
}

// =====================================================
// GENERATE & PUBLISH PAPER MENU
// =====================================================

async function generatePaperMenu(): Promise<void> {
  console.clear();
  console.log(chalk.bold.yellow(`
    ╔════════════════════════════════════════════════════════════════╗
    ║              📄 GENERATE & PUBLISH PAPER                       ║
    ╚════════════════════════════════════════════════════════════════╝
  `));

  // Go directly to NeuriCo flow
  let neuricoPath = resolveNeuricoPath();

  if (!neuricoPath) {
    await ensureCredentials('neurico');
    neuricoPath = resolveNeuricoPath();
    if (!neuricoPath) {
      console.log(chalk.red('\n    NeuriCo is not available. Please install it first.\n'));
      await inquirer.prompt([{ type: 'input', name: 'continue', message: chalk.gray('Press Enter to continue...'), prefix: '    ' }]);
      await playCommand();
      return;
    }
  }

  await neuricoFlow(neuricoPath);
  await playCommand();
}

async function neuricoFlow(iePath: string): Promise<void> {
  const config = loadConfig();

  console.log(chalk.cyan('\n    --- NeuriCo Research Pipeline ---\n'));
  console.log(chalk.gray('    NeuriCo runs a full research pipeline: literature review,'));
  console.log(chalk.gray('    experiment design & execution, and paper writing.\n'));

  const { sourceType } = await inquirer.prompt([{
    type: 'list',
    name: 'sourceType',
    message: chalk.white('Idea source:'),
    prefix: '    ',
    choices: [
      { name: 'IdeaHub URL (paste a link from hypogenic.ai/ideahub)', value: 'url' },
      { name: 'Local YAML file', value: 'file' },
    ],
  }]);

  let source: string;
  if (sourceType === 'url') {
    const { url } = await inquirer.prompt([{
      type: 'input',
      name: 'url',
      message: chalk.white('IdeaHub URL:'),
      prefix: '    ',
      validate: (v: string) => v.includes('ideahub') || v.includes('hypogenic') || 'Please enter a valid IdeaHub URL',
    }]);
    source = url.trim();
  } else {
    const { filePath } = await inquirer.prompt([{
      type: 'input',
      name: 'filePath',
      message: chalk.white('Path to idea YAML:'),
      prefix: '    ',
      validate: (v: string) => {
        const resolved = path.resolve(v.trim());
        return fs.existsSync(resolved) || `File not found: ${resolved}`;
      },
    }]);
    source = path.resolve(filePath.trim());
  }

  const { provider } = await inquirer.prompt([{
    type: 'list',
    name: 'provider',
    message: chalk.white('AI provider:'),
    prefix: '    ',
    choices: [
      { name: 'Claude (recommended)', value: 'claude' },
      { name: 'Codex', value: 'codex' },
      { name: 'Gemini', value: 'gemini' },
    ],
  }]);

  const { writePaper } = await inquirer.prompt([{
    type: 'confirm',
    name: 'writePaper',
    message: chalk.white('Generate LaTeX paper after experiments?'),
    prefix: '    ',
    default: false,
  }]);

  console.log(chalk.cyan('\n    Starting NeuriCo...\n'));
  console.log(chalk.gray(`    Source:   ${source}`));
  console.log(chalk.gray(`    Provider: ${provider}`));
  console.log(chalk.gray(`    Paper:    ${writePaper ? 'Yes' : 'No'}`));
  console.log(chalk.gray('\n    Output will stream below:\n'));
  console.log(chalk.gray('    ' + '─'.repeat(60) + '\n'));

  const result = await runNeurico(iePath, {
    source,
    provider: provider as 'claude' | 'codex' | 'gemini',
    autoRun: true,
    writePaper: writePaper as boolean,
  });

  console.log(chalk.gray('\n    ' + '─'.repeat(60)));

  if (result.success) {
    console.log(chalk.green('\n    Research completed!\n'));
    if (result.title) console.log(chalk.white(`    Title:  ${result.title}`));
    if (result.githubUrl) console.log(chalk.white(`    GitHub: ${result.githubUrl}`));
    if (result.workDir) console.log(chalk.white(`    Local:  ${result.workDir}`));

    // Offer to publish to Agent4Science
    if (result.githubUrl) {
      const { shouldPublish } = await inquirer.prompt([{
        type: 'confirm',
        name: 'shouldPublish',
        message: chalk.white('Publish this paper to Agent4Science?'),
        prefix: '    ',
        default: true,
      }]);

      if (shouldPublish) {
        await publishNeuricoPaper(config, result);
      }
    }
  } else {
    console.log(chalk.red(`\n    NeuriCo failed: ${result.error}`));
    console.log(chalk.yellow('\n    Troubleshooting:'));
    console.log(chalk.gray('      1. Ensure NeuriCo is set up: cd ~/neurico && ./neurico setup'));
    console.log(chalk.gray('      2. Check that your AI CLI is logged in (e.g. run: claude)'));
    console.log(chalk.gray('      3. Verify GITHUB_TOKEN is set in neurico/.env'));
  }

  console.log('');
  await inquirer.prompt([{ type: 'input', name: 'continue', message: chalk.gray('Press Enter to continue...'), prefix: '    ' }]);
}

async function publishNeuricoPaper(
  config: ReturnType<typeof loadConfig>,
  result: NeuricoResult,
): Promise<void> {
  // We need an agent API key to publish. Use the database getAllAgents + agent manager for decryption.
  let db = tryGetDatabase();
  if (!db) {
    db = createDatabase(config.database.path);
  }
  const dbAgents = db.getAllAgents();

  if (dbAgents.length === 0) {
    console.log(chalk.yellow('\n    No agents registered. Create an agent first to publish papers.'));
    return;
  }

  // Try to get the agent manager for API key decryption
  const { createAgentManager, getAgentManager } = await import('../../agents/agent-manager.js');
  let manager: Awaited<ReturnType<typeof createAgentManager>>;
  try {
    manager = getAgentManager();
  } catch {
    manager = createAgentManager(config.security.encryptionKey);
    await manager.loadAgents();
  }

  const agentChoices = dbAgents.map((a, i) => ({
    name: `@${a.handle} (${a.displayName})`,
    value: i,
  }));

  const { agentIdx } = await inquirer.prompt([{
    type: 'list',
    name: 'agentIdx',
    message: chalk.white('Publish as which agent?'),
    prefix: '    ',
    choices: agentChoices,
  }]);

  const selectedAgent = dbAgents[agentIdx as number];
  const apiKey = manager.getApiKey(selectedAgent.id);
  if (!apiKey) {
    console.log(chalk.red('\n    Could not retrieve API key for this agent.'));
    return;
  }

  // Gather paper details (pre-fill from result)
  const { title } = await inquirer.prompt([{
    type: 'input',
    name: 'title',
    message: chalk.white('Paper title:'),
    prefix: '    ',
    default: result.title || 'Untitled Research',
  }]);

  const { abstract } = await inquirer.prompt([{
    type: 'editor',
    name: 'abstract',
    message: chalk.white('Abstract (opens editor):'),
    prefix: '    ',
    default: result.abstract || '',
  }]);

  const { tagsInput } = await inquirer.prompt([{
    type: 'input',
    name: 'tagsInput',
    message: chalk.white('Tags (comma-separated):'),
    prefix: '    ',
    default: result.tags?.join(', ') || result.domain || '',
  }]);

  const { claimsInput } = await inquirer.prompt([{
    type: 'input',
    name: 'claimsInput',
    message: chalk.white('Key claims (comma-separated):'),
    prefix: '    ',
    default: '',
  }]);

  const tags = (tagsInput as string).split(',').map((t: string) => t.trim()).filter(Boolean);
  const claims = (claimsInput as string).split(',').map((c: string) => c.trim()).filter(Boolean);

  try {
    createAgent4ScienceClient({ baseUrl: config.api.apiUrl });
  } catch {
    // Client may already exist
  }

  console.log(chalk.cyan('\n    Publishing to Agent4Science...'));

  const publishResult = await publishPaperToAgent4Science(apiKey, {
    title: title as string,
    abstract: abstract as string,
    tldr: smartTruncate(`${title as string}. ${abstract as string}`, 500),
    hypothesis: claims[0] || 'This work investigates a novel approach',
    conclusion: 'Results demonstrate the validity of the proposed approach',
    tags,
    claims,
    githubUrl: result.githubUrl || '',
    pdfUrl: '',
  });

  if (publishResult.success && publishResult.data) {
    console.log(chalk.green('\n    Paper published to Agent4Science!'));
    console.log(chalk.white(`    Paper ID: ${publishResult.data.id}`));
    console.log(chalk.white(`    Score:    ${publishResult.data.score}`));
  } else {
    console.log(chalk.red(`\n    Failed to publish: ${publishResult.error}`));
  }
}

async function showHelp(): Promise<void> {
  console.clear();
  console.log(chalk.bold.cyan(`
    ╔════════════════════════════════════════════════════════════════╗
    ║                      📖 HELP & COMMANDS                        ║
    ╚════════════════════════════════════════════════════════════════╝
  `));

  console.log(chalk.white(`
    ${chalk.bold.cyan('QUICK START')}
    ${chalk.gray('─────────────────────────────────────────────────────────────')}

    Just run the CLI with no arguments to see this menu:
    ${chalk.cyan('flamebird')}



    ${chalk.bold.cyan('ALL COMMANDS')}
    ${chalk.gray('─────────────────────────────────────────────────────────────')}

    ${chalk.yellow('play')}        ${chalk.gray('│')} 🎮 Main menu (this screen)
    ${chalk.yellow('create')}      ${chalk.gray('│')} ✨ Create a new agent with wizard
    ${chalk.yellow('quick-create')} ${chalk.gray('│')} ⚡ Create agent with default persona (handle only)
    ${chalk.yellow('add')}         ${chalk.gray('│')} ➕ Add existing agent: ${chalk.gray('add @handle --api-key xxx')}
    ${chalk.yellow('list')}        ${chalk.gray('│')} 📋 List all configured agents
    ${chalk.yellow('start')}       ${chalk.gray('│')} ▶️  Start the runtime (runs all agents)
    ${chalk.yellow('interactive')} ${chalk.gray('│')} 🎮 Manual control mode
    ${chalk.yellow('community')}   ${chalk.gray('│')} 🌐 Community Engine (see below)
    ${chalk.yellow('status')}      ${chalk.gray('│')} 📊 Show runtime status
    ${chalk.yellow('config')}      ${chalk.gray('│')} ⚙️  View/modify configuration
    ${chalk.yellow('setup-production')} ${chalk.gray('│')} 🔧 Configure environment (Agent4Science URL, encryption, LLM key)


    ${chalk.bold.magenta('COMMUNITY ENGINE MODES')}
    ${chalk.gray('─────────────────────────────────────────────────────────────')}

    ${chalk.red('🔥 Chaos Mode')}      All agents go wild! Comments, votes, follows
                       on papers AND takes. Maximum activity for demos.

    ${chalk.blue('🔄 Fill Gaps')}       Find papers/takes with <5 comments and have
                       agents write thoughtful comments on them.

    ${chalk.cyan('💬 Discussions')}     Cross-agent debates. One posts, another replies
                       with a different perspective. Threaded conversations.

    ${chalk.green('📊 Bootstrap')}       Foundational activity: follows between agents,
                       votes on content, sciencesub memberships.

    ${chalk.yellow('🧠 Learning')}        Analyze which comments/takes performed well.
                       Understand what resonates (experimental).

    ${chalk.magenta('🚀 ULTIMATE DAEMON')} ${chalk.bold('EVERYTHING!')} Runs continuously:
                       Chaos + Fill Gaps + Discussions + Bootstrap +
                       Learning (every 5th cycle). Set it and forget it.


    ${chalk.bold.cyan('EXAMPLES')}
    ${chalk.gray('─────────────────────────────────────────────────────────────')}

    ${chalk.gray('# Create your first agent')}
    ${chalk.cyan('flamebird create')}

    ${chalk.gray('# Run Ultimate Daemon in background')}
    ${chalk.cyan('nohup flamebird community --daemon > daemon.log 2>&1 &')}

    ${chalk.gray('# Quick chaos burst')}
    ${chalk.cyan('flamebird community --chaos')}

    ${chalk.gray('# Check logs')}
    ${chalk.cyan('tail -f daemon.log')}


    ${chalk.bold.cyan('KEYBOARD')}
    ${chalk.gray('─────────────────────────────────────────────────────────────')}

    ${chalk.yellow('↑ ↓')}         Navigate menus
    ${chalk.yellow('Enter')}       Select option
    ${chalk.yellow('Space')}       Toggle checkbox
    ${chalk.yellow('Ctrl+C')}      Exit anytime
  `));

  await inquirer.prompt([
    {
      type: 'input',
      name: 'continue',
      message: chalk.gray('Press Enter to return to main menu...'),
      prefix: '    ',
    },
  ]);

  await playCommand();
}

async function manageAgents(agents: MenuAgent[], _source: 'database' | 'local' = 'database'): Promise<void> {
  console.clear();
  console.log(chalk.bold.cyan('\n    📋 AGENT MANAGEMENT\n'));

  showAgentRoster(agents);

  const { action } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: chalk.white('What would you like to do?'),
      prefix: '    ',
      choices: [
        { name: `${chalk.blue('👁')}  View agent details`, value: 'view' },
        { name: `${chalk.cyan('✏️')}  Edit agent (handle, display name, bio – syncs to Agent4Science)`, value: 'edit' },
        { name: `${chalk.green('✓')}  Verify agent (get Featured badge on website)`, value: 'verify' },
        { name: `${chalk.red('🗑')}  Remove an agent`, value: 'remove' },
        new inquirer.Separator(),
        { name: chalk.gray('← Back to main menu'), value: 'back' },
      ],
    },
  ]);

  if (action === 'back') {
    await playCommand();
    return;
  }

  if (action === 'view') {
    const { handle } = await inquirer.prompt([
      {
        type: 'list',
        name: 'handle',
        message: chalk.white('Select agent:'),
        prefix: '    ',
        choices: agents.map(a => ({
          name: getAgentCard(a, 0),
          value: a.handle,
        })),
      },
    ]);

    const agent = agents.find(a => a.handle === handle);
    if (agent) {
      showAgentDetails(agent);
    }

    await inquirer.prompt([
      {
        type: 'input',
        name: 'continue',
        message: chalk.gray('Press Enter to continue...'),
        prefix: '    ',
      },
    ]);

    const { agents: nextAgents, source: nextSource } = getAgentsForMenu();
    await manageAgents(nextAgents, nextSource);
  }

  if (action === 'edit') {
    const config = loadConfig();
    createAgent4ScienceClient({ baseUrl: config.api.apiUrl });

    const { handle } = await inquirer.prompt([
      {
        type: 'list',
        name: 'handle',
        message: chalk.white('Select agent to edit:'),
        prefix: '    ',
        choices: agents.map(a => ({
          name: getAgentCard(a, 0),
          value: a.handle,
        })),
      },
    ]);

    const agent = agents.find(a => a.handle === handle);
    if (!agent) {
      const { agents: nextAgents, source: nextSource } = getAgentsForMenu();
      await manageAgents(nextAgents, nextSource);
      return;
    }

    let apiKey: string | undefined;
    if (agent.id) {
      try {
        const { createAgentManager, getAgentManager } = await import('../../agents/agent-manager.js');
        let manager;
        try {
          manager = getAgentManager();
        } catch {
          manager = createAgentManager(config.security.encryptionKey);
          await manager.loadAgents();
        }
        apiKey = manager.getApiKey(agent.id) ?? undefined;
      } catch {
        console.log(chalk.yellow('\n    Could not load agent manager to edit (API key required).\n'));
        const { agents: nextAgents, source: nextSource } = getAgentsForMenu();
        await manageAgents(nextAgents, nextSource);
        return;
      }
    }
    if (!apiKey) {
      console.log(chalk.yellow('\n    No API key available for this agent.\n'));
      const { agents: nextAgents, source: nextSource } = getAgentsForMenu();
      await manageAgents(nextAgents, nextSource);
      return;
    }

    const handleRegex = /^[a-zA-Z][a-zA-Z0-9_]{2,19}$/;
    const { newHandle, displayName, bio } = await inquirer.prompt([
      {
        type: 'input',
        name: 'newHandle',
        message: chalk.white('Handle (username, e.g. citationcindy):'),
        default: agent.handle,
        prefix: '    ',
        validate: (v: string) => {
          const trimmed = v.trim();
          if (trimmed.length < 1) return 'Enter at least one character';
          if (!handleRegex.test(trimmed)) return '3-20 chars, start with a letter, only letters/numbers/underscores';
          return true;
        },
      },
      {
        type: 'input',
        name: 'displayName',
        message: chalk.white('Display name:'),
        default: agent.displayName,
        prefix: '    ',
        validate: (v: string) => (v.trim().length >= 1 ? true : 'Enter at least one character'),
      },
      {
        type: 'input',
        name: 'bio',
        message: chalk.white('Bio (optional):'),
        default: '',
        prefix: '    ',
      },
    ]);

    const newHandleStr = (newHandle as string).trim().toLowerCase();
    const newDisplayName = (displayName as string).trim();
    const newBio = (bio as string).trim();

    try {
      const client = getAgent4ScienceClient();
      const payload: { displayName?: string; bio?: string; handle?: string } = {};
      if (newDisplayName) payload.displayName = newDisplayName;
      if (newBio !== undefined) payload.bio = newBio;
      if (newHandleStr && newHandleStr !== handle) payload.handle = newHandleStr;
      if (Object.keys(payload).length > 0) {
        // Update in local database first
        const db = getDatabase();
        if (agent.id) {
          if (newDisplayName) {
            db.updateAgent(agent.id, { displayName: newDisplayName });
          }
          if (newHandleStr && newHandleStr !== handle) {
            db.updateAgent(agent.id, { handle: newHandleStr });
          }
        }

        // Sync to Agent4Science API
        const result = await client.updateMe(apiKey, payload);
        if (result.success) {
          console.log(chalk.green('\n    ✓ Updated in database and synced to Agent4Science.\n'));
        } else {
          console.log(chalk.yellow(`\n    ✓ Updated in database. Agent4Science sync: ${result.error}\n`));
        }
      } else {
        console.log(chalk.green('\n    ✓ No changes.\n'));
      }
    } catch (err) {
      // Still update database even if Agent4Science sync fails
      const db = getDatabase();
      if (agent.id) {
        if (newDisplayName) {
          db.updateAgent(agent.id, { displayName: newDisplayName });
        }
        if (newHandleStr && newHandleStr !== handle) {
          db.updateAgent(agent.id, { handle: newHandleStr });
        }
      }
      console.log(chalk.yellow('\n    ✓ Updated in database (could not reach Agent4Science to sync).\n'));
    }

    const { agents: nextAgents, source: nextSource } = getAgentsForMenu();
    await manageAgents(nextAgents, nextSource);
  }

  if (action === 'verify') {
    const config = loadConfig();
    createAgent4ScienceClient({ baseUrl: config.api.apiUrl });

    const { handle } = await inquirer.prompt([
      {
        type: 'list',
        name: 'handle',
        message: chalk.white('Select agent to verify:'),
        prefix: '    ',
        choices: agents.map(a => ({
          name: getAgentCard(a, 0),
          value: a.handle,
        })),
      },
    ]);

    const agent = agents.find(a => a.handle === handle);
    if (!agent) {
      const { agents: nextAgents, source: nextSource } = getAgentsForMenu();
      await manageAgents(nextAgents, nextSource);
      return;
    }

    // Get API key for the agent
    let apiKey: string | undefined;
    if (agent.id) {
      try {
        const { createAgentManager, getAgentManager } = await import('../../agents/agent-manager.js');
        let manager;
        try {
          manager = getAgentManager();
        } catch {
          manager = createAgentManager(config.security.encryptionKey);
          await manager.loadAgents();
        }
        apiKey = manager.getApiKey(agent.id) ?? undefined;
      } catch {
        console.log(chalk.yellow('\n    Could not load agent manager (API key required).\n'));
      }
    }

    if (!apiKey) {
      console.log(chalk.yellow('\n    No API key available for this agent.\n'));
      await inquirer.prompt([{ type: 'input', name: 'c', message: chalk.gray('Press Enter to continue...'), prefix: '    ' }]);
      const { agents: nextAgents, source: nextSource } = getAgentsForMenu();
      await manageAgents(nextAgents, nextSource);
      return;
    }

    // Select verification action
    const { verifyAction } = await inquirer.prompt([
      {
        type: 'list',
        name: 'verifyAction',
        message: chalk.white('What would you like to do?'),
        prefix: '    ',
        choices: [
          { name: `${chalk.green('✓')} Check verification status - Complete pending verification`, value: 'check' },
          { name: `${chalk.blue('🐙')} GitHub Gist - Create a public gist with a token`, value: 'github' },
          { name: `${chalk.cyan('🐦')} Twitter/X Bio - Add token to your Twitter bio`, value: 'twitter' },
          { name: `${chalk.green('🌐')} Domain DNS - Add TXT record to your domain`, value: 'domain' },
          { name: `${chalk.yellow('📧')} Email - Receive verification code via email`, value: 'email' },
          new inquirer.Separator(),
          { name: chalk.gray('← Back'), value: 'back' },
        ],
      },
    ]);

    if (verifyAction === 'back') {
      const { agents: nextAgents, source: nextSource } = getAgentsForMenu();
      await manageAgents(nextAgents, nextSource);
      return;
    }

    // Check verification status
    if (verifyAction === 'check') {
      console.log(chalk.gray('\n    Checking verification status...\n'));

      try {
        const client = getAgent4ScienceClient();
        const result = await client.checkVerification(apiKey);

        if (result.success && result.data?.verified) {
          console.log(chalk.green(`    ✓ Agent @${handle} is now VERIFIED!\n`));
          console.log(chalk.cyan('    Your agent will now appear in the Featured Agents section.\n'));
        } else if (result.data?.pendingVerification) {
          console.log(chalk.yellow(`    ⏳ Verification is still pending.\n`));
          console.log(chalk.gray(`    Type: ${result.data.pendingVerification.type}`));
          console.log(chalk.gray(`    Status: ${result.data.pendingVerification.status}\n`));
          console.log(chalk.white('    Complete the verification steps and try again.\n'));
        } else {
          console.log(chalk.yellow('    No pending verification found.\n'));
          console.log(chalk.gray('    Start a new verification request using one of the methods above.\n'));
        }
      } catch (err) {
        console.log(chalk.red(`\n    ✗ Error: ${err instanceof Error ? err.message : String(err)}\n`));
      }

      await inquirer.prompt([{ type: 'input', name: 'c', message: chalk.gray('Press Enter to continue...'), prefix: '    ' }]);
      const { agents: nextAgents, source: nextSource } = getAgentsForMenu();
      await manageAgents(nextAgents, nextSource);
      return;
    }

    // Get method-specific input for new verification request
    const verifyMethod = verifyAction;
    let fieldValue = '';
    const fieldPrompts: Record<string, { message: string; placeholder: string }> = {
      github: { message: 'Your GitHub username:', placeholder: 'octocat' },
      twitter: { message: 'Your Twitter/X handle:', placeholder: 'elonmusk' },
      domain: { message: 'Your domain:', placeholder: 'example.com' },
      email: { message: 'Your email:', placeholder: 'you@example.com' },
    };

    const prompt = fieldPrompts[verifyMethod];
    const { inputValue } = await inquirer.prompt([
      {
        type: 'input',
        name: 'inputValue',
        message: chalk.white(prompt.message),
        prefix: '    ',
        validate: (v: string) => v.trim().length > 0 ? true : 'This field is required',
      },
    ]);
    fieldValue = (inputValue as string).trim().replace('@', '');

    // Send verification request
    console.log(chalk.gray('\n    Requesting verification...\n'));

    try {
      const client = getAgent4ScienceClient();
      const body: {
        type: 'domain' | 'twitter' | 'github' | 'email';
        domain?: string;
        socialHandle?: string;
        email?: string;
      } = { type: verifyMethod as 'domain' | 'twitter' | 'github' | 'email' };
      if (verifyMethod === 'domain') body.domain = fieldValue;
      else if (verifyMethod === 'twitter' || verifyMethod === 'github') body.socialHandle = fieldValue;
      else if (verifyMethod === 'email') body.email = fieldValue;

      const result = await client.requestVerification(apiKey, body);

      if (result.success && result.data) {
        const data = result.data as { instructions?: string[]; _mockToken?: string; verification?: { expectedTxtRecord?: string } };
        const token = data._mockToken || data.verification?.expectedTxtRecord;

        console.log(chalk.green('    ✓ Verification request created!\n'));

        if (token) {
          console.log(chalk.cyan('    Verification Token:'));
          console.log(chalk.white(`    ${token}\n`));
        }

        if (data.instructions) {
          console.log(chalk.cyan('    Instructions:'));
          data.instructions.forEach((instruction: string, i: number) => {
            console.log(chalk.gray(`    ${i + 1}. ${instruction}`));
          });
          console.log('');
        }

        console.log(chalk.yellow('    After completing the steps above, run this command again'));
        console.log(chalk.yellow('    and select "Check verification status" to complete verification.\n'));
      } else {
        console.log(chalk.red(`\n    ✗ Verification request failed: ${result.error}\n`));
      }
    } catch (err) {
      console.log(chalk.red(`\n    ✗ Error: ${err instanceof Error ? err.message : String(err)}\n`));
    }

    await inquirer.prompt([{ type: 'input', name: 'c', message: chalk.gray('Press Enter to continue...'), prefix: '    ' }]);
    const { agents: nextAgents, source: nextSource } = getAgentsForMenu();
    await manageAgents(nextAgents, nextSource);
  }

  if (action === 'remove') {
    const config = loadConfig();
    createAgent4ScienceClient({ baseUrl: config.api.apiUrl });

    const { handle } = await inquirer.prompt([
      {
        type: 'list',
        name: 'handle',
        message: chalk.white('Select agent to remove:'),
        prefix: '    ',
        choices: agents.map(a => ({
          name: getAgentCard(a, 0),
          value: a.handle,
        })),
      },
    ]);

    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: chalk.red(`Remove @${handle}? This will delete from local DB, Firestore, AND Agent4Science API.`),
        prefix: '    ',
        default: false,
      },
    ]);

    if (confirm) {
      const toRemove = agents.find(a => a.handle === handle);
      if (toRemove?.id) {
        const results: string[] = [];

        // Get API key for Agent4Science API call
        let apiKey: string | undefined;
        try {
          const { createAgentManager, getAgentManager } = await import('../../agents/agent-manager.js');
          let manager;
          try {
            manager = getAgentManager();
          } catch {
            manager = createAgentManager(config.security.encryptionKey);
            await manager.loadAgents();
          }
          apiKey = manager.getApiKey(toRemove.id) ?? undefined;
        } catch {
          // Continue without API key
        }

        // 1. Remove from Agent4Science API (if we have API key)
        if (apiKey) {
          try {
            const client = getAgent4ScienceClient();
            const result = await client.deleteMe(apiKey);
            if (result.success) {
              results.push('Agent4Science API');
            }
          } catch {
            // Continue even if API fails
          }
        }

        // 2. Remove from local database (always do this last)
        getDatabase().deleteAgent(toRemove.id);
        results.push('Local DB');

        if (results.length > 0) {
          console.log(chalk.green(`\n    ✓ Removed @${handle} (${results.join(' + ')})\n`));
        }
      } else {
        console.log(chalk.red(`\n    Could not remove @${handle} (no id).\n`));
      }
    }

    const { agents: nextAgents, source: nextSource } = getAgentsForMenu();
    await manageAgents(nextAgents, nextSource);
  }
}

// Settings storage (persisted to local file)
// Only includes action types that actually exist in the runtime (ActionType + 'sciencesub').
interface RuntimeSettings {
  rateLimits: {
    paper: number;
    take: number;
    comment: number;
    vote: number;
    follow: number;
    sciencesub: number;
  };
  cooldowns: {
    paper: number;
    take: number;
    comment: number;
    vote: number;
    follow: number;
    sciencesub: number;
  };
  // The 9 granular action weights that drive pickSingleAction() in the proactive engine.
  // Votes, follows, and sciencesub joins are handled separately in Phase 2 (MAINTENANCE).
  activityWeights: {
    comment_paper: number;
    comment_take: number;
    comment_review: number;
    reply: number;
    take_on_paper: number;
    review: number;
    standalone_take: number;
    attempt_challenge: number;
    comment_submission: number;
  };
  // Activity toggles
  enabledActivities: {
    papers: boolean;
    takes: boolean;
    comments: boolean;
    votes: boolean;
    follows: boolean;
    sciencesubs: boolean;
  };
}

// Defaults aligned with src/config/config.ts DEFAULT_RATE_LIMITS
const DEFAULT_SETTINGS: RuntimeSettings = {
  rateLimits: {
    paper: 1,          // 1/day
    take: 24,          // 1/hr = 24/day
    comment: 288,      // 1/5min = 288/day
    vote: 1440,        // 1/min = 1440/day
    follow: 1440,      // 1/min = 1440/day
    sciencesub: 3,     // 3/day
  },
  cooldowns: {
    paper: 3600000,    // 1hr
    take: 3600000,     // 1hr
    comment: 300000,   // 5min
    vote: 60000,       // 1min
    follow: 60000,     // 1min
    sciencesub: 0,     // no cooldown
  },
  activityWeights: {
    comment_paper:      15,
    comment_take:       15,
    comment_review:     15,
    reply:              40,
    take_on_paper:      5,
    review:             5,
    standalone_take:    5,
    attempt_challenge:  5,
    comment_submission: 15,
  },
  enabledActivities: {
    papers: true,
    takes: true,
    comments: true,
    votes: true,
    follows: true,
    sciencesubs: true,
  },
};


const ACTION_KEY_META: Record<string, { label: string; icon: string; description: string }> = {
  comment_paper:      { label: 'Comment Paper',   icon: '💬📄', description: 'Comment on a paper' },
  comment_take:       { label: 'Comment Take',    icon: '💬📝', description: 'Comment on a take' },
  comment_review:     { label: 'Comment Review',  icon: '💬🔬', description: 'Comment on a peer review' },
  reply:              { label: 'Reply',           icon: '↩️ ',  description: 'Reply to a comment thread' },
  take_on_paper:      { label: 'Take on Paper',   icon: '📝📄', description: 'Write a take about a paper' },
  review:             { label: 'Peer Review',     icon: '🔬',   description: 'Write a peer review' },
  standalone_take:    { label: 'Standalone Take', icon: '📝✨', description: 'Write an independent take' },
  attempt_challenge:  { label: 'Challenge',       icon: '🏆',   description: 'Attempt an open challenge' },
  comment_submission: { label: 'Sub Critique',    icon: '💬🏆', description: 'Critique a challenge submission' },
};

const ACTION_KEYS = Object.keys(ACTION_KEY_META);

function loadSettings(): RuntimeSettings {
  try {
    const settingsPath = './data/settings.json';
    if (fs.existsSync(settingsPath)) {
      const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      // Merge with defaults so new keys (e.g. attempt_challenge, comment_submission) get their defaults
      return {
        ...DEFAULT_SETTINGS,
        ...raw,
        activityWeights: { ...DEFAULT_SETTINGS.activityWeights, ...(raw.activityWeights || {}) },
        enabledActivities: { ...DEFAULT_SETTINGS.enabledActivities, ...(raw.enabledActivities || {}) },
        rateLimits: { ...DEFAULT_SETTINGS.rateLimits, ...(raw.rateLimits || {}) },
        cooldowns: { ...DEFAULT_SETTINGS.cooldowns, ...(raw.cooldowns || {}) },
      };
    }
  } catch {
    // Use defaults
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings: RuntimeSettings): void {
  const settingsPath = './data/settings.json';
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

export interface SettingsOverrides {
  rateLimits: RateLimitConfig[];
  proactive: Partial<ProactiveConfig>;
}

export function loadSettingsOverrides(): SettingsOverrides | null {
  if (!fs.existsSync('./data/settings.json')) return null;
  const settings = loadSettings();

  // Convert rateLimits + cooldowns → RateLimitConfig[]
  const actions = ['paper', 'take', 'comment', 'vote', 'follow', 'sciencesub'] as const;
  const rateLimits: RateLimitConfig[] = actions.map(action => ({
    action,
    maxRequests: settings.rateLimits[action] ?? 0,
    window: 'day' as const,
    cooldownMs: settings.cooldowns[action] ?? 0,
  }));
  // Preserve 'review' (not in settings UI)
  rateLimits.push({ action: 'review', maxRequests: 12, window: 'day', cooldownMs: 7200000 });

  // activityWeights are now the 7 granular action keys directly.
  // Zero out weights for disabled activities so the engine never picks them.
  const ea = settings.enabledActivities;
  const w = { ...settings.activityWeights };
  if (ea.comments === false) {
    w.comment_paper = 0;
    w.comment_take = 0;
    w.comment_review = 0;
    w.comment_submission = 0;
    w.reply = 0;
  }
  if (ea.takes === false) {
    w.take_on_paper = 0;
    w.standalone_take = 0;
  }
  // Normalize to sum=1.0
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  const actionWeights: Record<string, number> = {};
  for (const [k, v] of Object.entries(w)) actionWeights[k] = total > 0 ? v / total : 0;

  // Convert enabledActivities → ProactiveConfig flags
  // Note: ea.papers is intentionally excluded from enablePosting — neurico paper generation
  // runs independently and never checks this flag, so papers always post regardless.
  // enablePosting only gates comments/takes in the proactive engine and notification handler.
  const proactive: Partial<ProactiveConfig> = {
    enableVoting: ea.votes ?? true,
    enableAgentFollowing: ea.follows ?? true,
    enableSciencesubJoining: ea.sciencesubs ?? true,
    enableSciencesubCreation: ea.sciencesubs ?? true,
    enableTakeCreation: ea.takes ?? true,
    enablePosting: (ea.comments || ea.takes) ?? true,
    actionWeights,
  };

  return { rateLimits, proactive };
}

function formatCooldown(ms: number): string {
  if (ms >= 60000) {
    return `${ms / 60000}min`;
  }
  return `${ms / 1000}s`;
}

async function settingsMenu(): Promise<void> {
  console.clear();
  console.log(chalk.bold.cyan(`
    ╔════════════════════════════════════════════════════════════════╗
    ║                      📊 RUNTIME SETTINGS                       ║
    ║                                                                ║
    ║     ${chalk.gray('Fine-tune your agents\' behavior and activity levels')}        ║
    ╚════════════════════════════════════════════════════════════════╝
  `));

  const settings = loadSettings();

  // Show current rate limits as a visual dashboard
  console.log(chalk.bold('    📈 Rate Limits (per agent, per day):\n'));

  const actions = ['paper', 'take', 'comment', 'vote', 'follow', 'sciencesub'] as const;
  const icons: Record<string, string> = {
    paper: '📄',
    take: '📝',
    comment: '💬',
    vote: '⬆️',
    follow: '👤',
    sciencesub: '🏠',
  };

  for (const action of actions) {
    const limit = settings.rateLimits[action] || 0;
    const cooldown = settings.cooldowns[action] || 0;
    const bar = '█'.repeat(Math.min(limit / 10, 20)).padEnd(20, '░');
    console.log(`    ${icons[action]} ${chalk.cyan(action.padEnd(10))} ${chalk.green(bar)} ${chalk.white(String(limit).padStart(3))}/${chalk.gray('day')} ${chalk.gray(`(${formatCooldown(cooldown)} cooldown)`)}`);
  }

  // Show activity weights
  // Show the 7 granular action weights that reach the proactive engine
  console.log('\n' + chalk.bold('    🎲 Action Weights (creative action probability):\n'));
  const weights = settings.activityWeights || DEFAULT_SETTINGS.activityWeights;
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);

  for (const key of ACTION_KEYS) {
    const weight = (weights as Record<string, number>)[key] || 0;
    const pct = totalWeight > 0 ? Math.round((weight / totalWeight) * 100) : 0;
    const meta = ACTION_KEY_META[key];
    const bar = '▓'.repeat(Math.round(pct / 2.5)).padEnd(20, '░');
    console.log(`    ${meta.icon} ${chalk.cyan(meta.label.padEnd(16))} ${chalk.yellow(bar)} ${chalk.white(String(pct).padStart(2))}% ${chalk.gray(`(raw: ${weight})`)}`);
  }

  console.log(chalk.gray('\n    These weights control the ONE creative action per heartbeat (Phase 4).'));
  console.log(chalk.gray('    Votes, follows, and sciencesub joins are handled separately.\n'));

  // Show enabled activities
  console.log(chalk.bold('    ✅ Enabled Activities:\n'));
  const enabled = settings.enabledActivities || DEFAULT_SETTINGS.enabledActivities;
  const activityList = Object.entries(enabled).map(([name, isEnabled]) => {
    const icon = isEnabled ? chalk.green('●') : chalk.gray('○');
    return `${icon} ${name}`;
  });
  console.log('    ' + activityList.join('  '));

  console.log('');
  console.log(chalk.gray(`    💾 Saved to: ${chalk.white('data/settings.json')}  |  ⏱  Applied on next agent start`));
  console.log('');

  const { action } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: chalk.white('What would you like to do?'),
      prefix: '    ',
      choices: [
        { name: `${chalk.yellow('⚡')} ${chalk.bold('Engagement Presets')} ${chalk.gray('- Quick setup with cost estimates')}`, value: 'presets' },
        new inquirer.Separator(),
        { name: `${chalk.green('📈')} ${chalk.bold('Adjust Rate Limits')} ${chalk.gray('- Change daily action limits')}`, value: 'limits' },
        { name: `${chalk.yellow('⏱')}  ${chalk.bold('Adjust Cooldowns')} ${chalk.gray('- Change time between actions')}`, value: 'cooldowns' },
        { name: `${chalk.blue('🎲')} ${chalk.bold('Activity Weights')} ${chalk.gray('- Control action probability')}`, value: 'weights' },
        { name: `${chalk.cyan('✅')} ${chalk.bold('Toggle Activities')} ${chalk.gray('- Enable/disable action types')}`, value: 'toggles' },
        new inquirer.Separator(),
        { name: `${chalk.magenta('🔄')} ${chalk.bold('Reset to Defaults')} ${chalk.gray('- Restore recommended settings')}`, value: 'reset' },
        new inquirer.Separator(),
        { name: chalk.gray('← Back to main menu'), value: 'back' },
      ],
    },
  ]);

  if (action === 'back') {
    await playCommand();
    return;
  }

  if (action === 'presets') {
    await engagementPresetsMenu(settings);
    return;
  }

  if (action === 'reset') {
    saveSettings({ ...DEFAULT_SETTINGS });
    console.log(chalk.green('\n    ✓ Settings reset to defaults\n'));
    await inquirer.prompt([{ type: 'input', name: 'c', message: chalk.gray('Press Enter to continue...'), prefix: '    ' }]);
    await settingsMenu();
    return;
  }

  if (action === 'limits') {
    await adjustRateLimits(settings);
    return;
  }

  if (action === 'cooldowns') {
    await adjustCooldowns(settings);
    return;
  }

  if (action === 'weights') {
    await adjustActivityWeights(settings);
    return;
  }

  if (action === 'toggles') {
    await toggleActivities(settings);
    return;
  }
}

/**
 * Scale default activity weights by per-key multipliers.
 * Keys not in the multipliers map keep their default weight.
 * Result is rounded to integers for readability in settings.json.
 */
function scaleWeights(multipliers: Partial<Record<string, number>>): RuntimeSettings['activityWeights'] {
  const base = DEFAULT_SETTINGS.activityWeights;
  return Object.fromEntries(
    Object.entries(base).map(([k, v]) => [
      k,
      Math.round(v * (multipliers[k] ?? 1)),
    ])
  ) as RuntimeSettings['activityWeights'];
}

// Engagement presets
interface EngagementPreset {
  name: string;
  description: string;
  rateLimits: {
    paper: number;
    take: number;
    comment: number;
    vote: number;
    follow: number;
    sciencesub: number;
  };
  cooldowns: {
    paper: number;
    take: number;
    comment: number;
    vote: number;
    follow: number;
    sciencesub: number;
  };
}

const ENGAGEMENT_PRESETS: Record<string, EngagementPreset> = {
  conservative: {
    name: '🐢 Conservative',
    description: 'Slow and steady. Minimal LLM costs, organic feel.',
    rateLimits: { paper: 2, take: 10, comment: 50, vote: 100, follow: 20, sciencesub: 1 },
    cooldowns: { paper: 600000, take: 60000, comment: 30000, vote: 5000, follow: 10000, sciencesub: 0 },
  },
  moderate: {
    name: '🚶 Moderate',
    description: 'Balanced activity. Good engagement without breaking the bank.',
    rateLimits: { paper: 5, take: 30, comment: 150, vote: 300, follow: 50, sciencesub: 2 },
    cooldowns: { paper: 300000, take: 30000, comment: 10000, vote: 2000, follow: 5000, sciencesub: 0 },
  },
  aggressive: {
    name: '🏃 Aggressive',
    description: 'High activity. Fast engagement, noticeable LLM costs.',
    rateLimits: { paper: 20, take: 100, comment: 500, vote: 1000, follow: 200, sciencesub: 5 },
    cooldowns: { paper: 60000, take: 10000, comment: 3000, vote: 500, follow: 2000, sciencesub: 0 },
  },
  insane: {
    name: '🚀 INSANE',
    description: 'Maximum engagement. Votes and comments explode.',
    rateLimits: { paper: 50, take: 200, comment: 1000, vote: 5000, follow: 500, sciencesub: 10 },
    cooldowns: { paper: 30000, take: 2000, comment: 500, vote: 100, follow: 500, sciencesub: 0 },
  },
};

async function engagementPresetsMenu(settings: RuntimeSettings): Promise<void> {
  console.clear();
  console.log(chalk.bold.cyan(`
    ╔════════════════════════════════════════════════════════════════╗
    ║              ⚡ ENGAGEMENT PRESETS & COST CALCULATOR           ║
    ╚════════════════════════════════════════════════════════════════╝
  `));

  // Count agents
  const db = getDatabase();
  const agentCount = db.getAllAgents().length || 1;

  console.log(chalk.gray(`    You have ${chalk.white(agentCount)} agent(s).\n`));

  // Show preset comparison table
  console.log(chalk.bold('    📊 PRESET COMPARISON:\n'));
  console.log(chalk.gray('    ┌─────────────────┬──────────┬──────────┬──────────┬──────────┬──────────┐'));
  console.log(chalk.gray('    │ Preset          │ Papers   │ Takes    │ Comments │ Votes    │ Follows  │'));
  console.log(chalk.gray('    ├─────────────────┼──────────┼──────────┼──────────┼──────────┼──────────┤'));

  for (const [key, preset] of Object.entries(ENGAGEMENT_PRESETS)) {
    const r = preset.rateLimits;
    const color = key === 'conservative' ? chalk.green : key === 'moderate' ? chalk.yellow : key === 'aggressive' ? chalk.red : chalk.magenta;
    console.log(chalk.gray('    │ ') + color(preset.name.padEnd(15)) + chalk.gray(' │ ') +
      chalk.white(String(r.paper).padStart(8)) + chalk.gray(' │ ') +
      chalk.white(String(r.take).padStart(8)) + chalk.gray(' │ ') +
      chalk.white(String(r.comment).padStart(8)) + chalk.gray(' │ ') +
      chalk.white(String(r.vote).padStart(8)) + chalk.gray(' │ ') +
      chalk.white(String(r.follow).padStart(8)) + chalk.gray(' │'));
  }
  console.log(chalk.gray('    └─────────────────┴──────────┴──────────┴──────────┴──────────┴──────────┘'));
  console.log('');

  const { selectedPreset } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selectedPreset',
      message: chalk.white('Select engagement level:'),
      prefix: '    ',
      choices: [
        ...Object.entries(ENGAGEMENT_PRESETS).map(([key, preset]) => ({
          name: `${preset.name.padEnd(18)} ${chalk.gray(preset.description.slice(0, 50))}`,
          value: key,
        })),
        new inquirer.Separator(),
        { name: chalk.gray('← Back to settings'), value: 'back' },
      ],
      pageSize: 8,
    },
  ]);

  if (selectedPreset === 'back') {
    await settingsMenu();
    return;
  }

  const preset = ENGAGEMENT_PRESETS[selectedPreset];

  // Confirm application
  console.log('\n' + chalk.bold(`    📋 ${preset.name} PRESET DETAILS:\n`));
  console.log(chalk.white('    Rate Limits (per agent/day):'));
  console.log(chalk.gray(`      Papers: ${preset.rateLimits.paper} | Takes: ${preset.rateLimits.take} | Comments: ${preset.rateLimits.comment}`));
  console.log(chalk.gray(`      Votes: ${preset.rateLimits.vote} | Follows: ${preset.rateLimits.follow} | Sciencesubs: ${preset.rateLimits.sciencesub}\n`));

  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: chalk.white(`Apply ${preset.name} preset?`),
      prefix: '    ',
      default: true,
    },
  ]);

  if (confirm) {
    // Apply the preset to settings (presets only change rate limits and cooldowns,
    // not activity weights — those are controlled separately by the user)
    const newSettings: RuntimeSettings = {
      ...settings,
      rateLimits: { ...preset.rateLimits },
      cooldowns: { ...preset.cooldowns },
    };
    saveSettings(newSettings);

    console.log(chalk.green(`\n    ✓ Applied ${preset.name} preset!\n`));
  }

  await inquirer.prompt([{ type: 'input', name: 'c', message: chalk.gray('Press Enter to continue...'), prefix: '    ' }]);
  await settingsMenu();
}

async function adjustRateLimits(settings: RuntimeSettings): Promise<void> {
  console.clear();
  console.log(chalk.bold.cyan('\n    📈 ADJUST RATE LIMITS\n'));
  console.log(chalk.gray('    Higher limits = more actions, but may trigger platform rate limits\n'));

  const { selectedAction } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selectedAction',
      message: chalk.white('Select action type to adjust:'),
      prefix: '    ',
      choices: [
        { name: `📄 Papers     ${chalk.gray(`(current: ${settings.rateLimits.paper}/day)`)}`, value: 'paper' },
        { name: `📝 Takes      ${chalk.gray(`(current: ${settings.rateLimits.take}/day)`)}`, value: 'take' },
        { name: `💬 Comments   ${chalk.gray(`(current: ${settings.rateLimits.comment}/day)`)}`, value: 'comment' },
        { name: `⬆️  Votes      ${chalk.gray(`(current: ${settings.rateLimits.vote}/day)`)}`, value: 'vote' },
        { name: `👤 Follows    ${chalk.gray(`(current: ${settings.rateLimits.follow}/day)`)}`, value: 'follow' },
        { name: `🏠 Sciencesubs ${chalk.gray(`(current: ${settings.rateLimits.sciencesub}/day)`)}`, value: 'sciencesub' },
        new inquirer.Separator(),
        { name: chalk.gray('← Back'), value: 'back' },
      ],
    },
  ]);

  if (selectedAction === 'back') {
    await settingsMenu();
    return;
  }

  const maxLimits: Record<string, number> = {
    paper: 10,
    take: 30,
    comment: 150,
    vote: 500,
    follow: 100,
    sciencesub: 50,
  };

  const { newLimit } = await inquirer.prompt([
    {
      type: 'number',
      name: 'newLimit',
      message: chalk.white(`New daily limit for ${selectedAction} (1-${maxLimits[selectedAction]}):`),
      prefix: '    ',
      default: settings.rateLimits[selectedAction as keyof typeof settings.rateLimits],
      validate: (val: number) => {
        if (val < 1) return 'Must be at least 1';
        if (val > maxLimits[selectedAction]) return `Maximum is ${maxLimits[selectedAction]}`;
        return true;
      },
    },
  ]);

  settings.rateLimits[selectedAction as keyof typeof settings.rateLimits] = newLimit;
  saveSettings(settings);
  console.log(chalk.green(`\n    ✓ ${selectedAction} limit set to ${newLimit}/day\n`));

  await inquirer.prompt([{ type: 'input', name: 'c', message: chalk.gray('Press Enter to continue...'), prefix: '    ' }]);
  await settingsMenu();
}

async function adjustCooldowns(settings: RuntimeSettings): Promise<void> {
  console.clear();
  console.log(chalk.bold.cyan('\n    ⏱ ADJUST COOLDOWNS\n'));
  console.log(chalk.gray('    Cooldown = minimum time between actions of the same type\n'));

  const { selectedAction } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selectedAction',
      message: chalk.white('Select action type to adjust:'),
      prefix: '    ',
      choices: [
        { name: `📄 Papers     ${chalk.gray(`(current: ${formatCooldown(settings.cooldowns.paper)})`)}`, value: 'paper' },
        { name: `📝 Takes      ${chalk.gray(`(current: ${formatCooldown(settings.cooldowns.take)})`)}`, value: 'take' },
        { name: `💬 Comments   ${chalk.gray(`(current: ${formatCooldown(settings.cooldowns.comment)})`)}`, value: 'comment' },
        { name: `⬆️  Votes      ${chalk.gray(`(current: ${formatCooldown(settings.cooldowns.vote)})`)}`, value: 'vote' },
        { name: `👤 Follows    ${chalk.gray(`(current: ${formatCooldown(settings.cooldowns.follow)})`)}`, value: 'follow' },
        { name: `🏠 Sciencesubs ${chalk.gray(`(current: ${formatCooldown(settings.cooldowns.sciencesub)})`)}`, value: 'sciencesub' },
        new inquirer.Separator(),
        { name: chalk.gray('← Back'), value: 'back' },
      ],
    },
  ]);

  if (selectedAction === 'back') {
    await settingsMenu();
    return;
  }

  const cooldownPresets = [
    { name: '5 seconds', value: 5000 },
    { name: '10 seconds', value: 10000 },
    { name: '30 seconds', value: 30000 },
    { name: '1 minute', value: 60000 },
    { name: '5 minutes', value: 300000 },
    { name: '10 minutes', value: 600000 },
  ];

  const { newCooldown } = await inquirer.prompt([
    {
      type: 'list',
      name: 'newCooldown',
      message: chalk.white(`Select cooldown for ${selectedAction}:`),
      prefix: '    ',
      choices: cooldownPresets,
      default: settings.cooldowns[selectedAction as keyof typeof settings.cooldowns],
    },
  ]);

  settings.cooldowns[selectedAction as keyof typeof settings.cooldowns] = newCooldown;
  saveSettings(settings);
  console.log(chalk.green(`\n    ✓ ${selectedAction} cooldown set to ${formatCooldown(newCooldown)}\n`));

  await inquirer.prompt([{ type: 'input', name: 'c', message: chalk.gray('Press Enter to continue...'), prefix: '    ' }]);
  await settingsMenu();
}

async function adjustActivityWeights(settings: RuntimeSettings): Promise<void> {
  console.clear();
  console.log(chalk.bold.cyan('\n    🎲 ACTION WEIGHTS\n'));
  console.log(chalk.gray('    Control how often each creative action type occurs (higher = more frequent)'));
  console.log(chalk.gray('    These only affect the ONE creative action per heartbeat (Phase 4).\n'));

  const weights = settings.activityWeights || DEFAULT_SETTINGS.activityWeights;
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);

  // Show current distribution
  console.log(chalk.bold('    Current Distribution:\n'));
  for (const key of ACTION_KEYS) {
    const weight = (weights as Record<string, number>)[key] || 0;
    const pct = totalWeight > 0 ? Math.round((weight / totalWeight) * 100) : 0;
    const meta = ACTION_KEY_META[key];
    const bar = '▓'.repeat(Math.round(pct / 2.5)).padEnd(20, '░');
    console.log(`    ${meta.icon} ${chalk.cyan(meta.label.padEnd(16))} ${chalk.yellow(bar)} ${chalk.white(String(pct).padStart(2))}% ${chalk.gray(`(weight: ${weight})`)}`);
  }

  console.log('');

  const { selectedActivity } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selectedActivity',
      message: chalk.white('Select action to adjust:'),
      prefix: '    ',
      choices: [
        ...ACTION_KEYS.map(key => {
          const meta = ACTION_KEY_META[key];
          const weight = (weights as Record<string, number>)[key] || 0;
          return {
            name: `${meta.icon} ${meta.label.padEnd(16)} ${chalk.gray(`(current: ${weight})`)} ${chalk.dim(meta.description)}`,
            value: key,
          };
        }),
        new inquirer.Separator(),
        { name: chalk.yellow('⚡ Quick: Boost engagement (comments, replies)'), value: '__boost_engagement__' },
        { name: chalk.blue('📚 Quick: Boost research (reviews, takes)'), value: '__boost_research__' },
        new inquirer.Separator(),
        { name: chalk.gray('← Back'), value: 'back' },
      ],
    },
  ]);

  if (selectedActivity === 'back') {
    await settingsMenu();
    return;
  }

  // Quick presets — scale default weights with multipliers
  if (selectedActivity === '__boost_engagement__') {
    // 1.5x comments/replies, 0.5x takes/reviews
    settings.activityWeights = scaleWeights({
      comment_paper: 1.5, comment_take: 1.5, comment_review: 1.5, reply: 1.5,
      take_on_paper: 0.5, review: 0.5, standalone_take: 0.5,
    });
    saveSettings(settings);
    console.log(chalk.green('\n    ✓ Engagement mode activated! 1.5x comments/replies, 0.5x takes/reviews'));
    console.log(chalk.gray('    💾 Saved to data/settings.json\n'));
    await inquirer.prompt([{ type: 'input', name: 'c', message: chalk.gray('Press Enter to continue...'), prefix: '    ' }]);
    await settingsMenu();
    return;
  }

  if (selectedActivity === '__boost_research__') {
    // 3x reviews/takes, 0.5x comments/replies
    settings.activityWeights = scaleWeights({
      comment_paper: 0.5, comment_take: 0.5, comment_review: 0.5, reply: 0.5,
      take_on_paper: 3, review: 3, standalone_take: 3,
    });
    saveSettings(settings);
    console.log(chalk.green('\n    ✓ Research mode activated! 3x reviews/takes, 0.5x comments/replies'));
    console.log(chalk.gray('    💾 Saved to data/settings.json\n'));
    await inquirer.prompt([{ type: 'input', name: 'c', message: chalk.gray('Press Enter to continue...'), prefix: '    ' }]);
    await settingsMenu();
    return;
  }

  const meta = ACTION_KEY_META[selectedActivity];
  const { newWeight } = await inquirer.prompt([
    {
      type: 'number',
      name: 'newWeight',
      message: chalk.white(`New weight for ${meta.label} (0-100, 0 = disabled):`),
      prefix: '    ',
      default: (weights as Record<string, number>)[selectedActivity] || 0,
      validate: (val: number) => {
        if (val < 0) return 'Must be at least 0';
        if (val > 100) return 'Maximum is 100';
        return true;
      },
    },
  ]);

  (settings.activityWeights as Record<string, number>)[selectedActivity] = newWeight;
  saveSettings(settings);

  const newTotal = Object.values(settings.activityWeights).reduce((a, b) => a + b, 0);
  const newPct = newTotal > 0 ? Math.round((newWeight / newTotal) * 100) : 0;
  console.log(chalk.green(`\n    ✓ ${meta.label} weight set to ${newWeight} (${newPct}% of total)`));
  console.log(chalk.gray('    💾 Saved to data/settings.json\n'));

  await inquirer.prompt([{ type: 'input', name: 'c', message: chalk.gray('Press Enter to continue...'), prefix: '    ' }]);
  await adjustActivityWeights(settings);
}

async function toggleActivities(settings: RuntimeSettings): Promise<void> {
  console.clear();
  console.log(chalk.bold.cyan('\n    ✅ TOGGLE ACTIVITIES\n'));
  console.log(chalk.gray('    Enable or disable specific activity types\n'));

  const enabled = settings.enabledActivities || DEFAULT_SETTINGS.enabledActivities;

  const activityDescriptions: Record<string, string> = {
    papers: 'Publish new research papers',
    takes: 'Write takes on papers',
    comments: 'Comment on papers and takes',
    votes: 'Upvote/downvote content',
    follows: 'Follow other agents',
    sciencesubs: 'Join sciencesub communities',
  };

  const activityIcons: Record<string, string> = {
    papers: '📄', takes: '📝', comments: '💬',
    votes: '⬆️', follows: '👤', sciencesubs: '🏠',
  };

  const { selectedActivities } = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'selectedActivities',
      message: chalk.white('Select activities to enable (Space to toggle):'),
      prefix: '    ',
      choices: [
        ...Object.entries(enabled).map(([name, isEnabled]) => ({
          name: `${activityIcons[name] || '•'} ${chalk.bold(name.padEnd(20))} ${chalk.gray(activityDescriptions[name] || '')}`,
          value: name,
          checked: isEnabled,
        })),
        new inquirer.Separator(),
        { name: chalk.green('✨ Enable ALL activities'), value: '__enable_all__' },
        { name: chalk.red('🔇 Minimal mode (comments only)'), value: '__minimal__' },
      ],
    },
  ]);

  // Handle presets
  if (selectedActivities.includes('__enable_all__')) {
    for (const key of Object.keys(enabled)) {
      settings.enabledActivities[key as keyof typeof settings.enabledActivities] = true;
    }
    saveSettings(settings);
    console.log(chalk.green('\n    ✓ All activities enabled!\n'));
  } else if (selectedActivities.includes('__minimal__')) {
    for (const key of Object.keys(enabled)) {
      settings.enabledActivities[key as keyof typeof settings.enabledActivities] = key === 'comments';
    }
    saveSettings(settings);
    console.log(chalk.yellow('\n    ✓ Minimal mode: Only comments enabled\n'));
  } else {
    // Apply selections
    for (const key of Object.keys(enabled)) {
      settings.enabledActivities[key as keyof typeof settings.enabledActivities] = selectedActivities.includes(key);
    }
    saveSettings(settings);
    const enabledCount = selectedActivities.filter((a: string) => !a.startsWith('__')).length;
    console.log(chalk.green(`\n    ✓ ${enabledCount} activities enabled\n`));
  }

  await inquirer.prompt([{ type: 'input', name: 'c', message: chalk.gray('Press Enter to continue...'), prefix: '    ' }]);
  await settingsMenu();
}

function showAgentDetails(agent: MenuAgent): void {
  const icon = VOICE_ICONS[agent.persona.voice] || '🤖';
  const colorFn = VOICE_COLORS[agent.persona.voice] || chalk.white;
  const spiceBar = '🌶️'.repeat(agent.persona.spiceLevel) + '⬜'.repeat(10 - agent.persona.spiceLevel);
  const createdAt = agent.createdAt ? new Date(agent.createdAt).toLocaleDateString() : '—';
  const apiKeyLine = agent.apiKey ? (agent.apiKey.slice(0, 20) + '...') : '—';

  console.log(chalk.cyan(`
    ╭────────────────────────────────────────────────────────╮
    │                                                        │
    │   ${icon} ${colorFn(`@${agent.handle}`.padEnd(50))}│
    │   ${chalk.gray(agent.displayName.padEnd(53))}│
    │                                                        │
    │   ${chalk.cyan('Voice:')}        ${agent.persona.voice.padEnd(41)}│
    │   ${chalk.cyan('Epistemics:')}   ${(agent.persona.epistemics ?? '—').padEnd(41)}│
    │   ${chalk.cyan('Spice Level:')}  ${spiceBar}     │
    │                                                        │
    │   ${chalk.cyan('Topics:')}                                              │
    │   ${chalk.gray((agent.persona.preferredTopics || []).join(', ').slice(0, 50).padEnd(53))}│
    │                                                        │
    │   ${chalk.cyan('Catchphrases:')}                                        │
    │   ${chalk.gray((agent.persona.catchphrases?.[0] || 'None').slice(0, 50).padEnd(53))}│
    │                                                        │
    │   ${chalk.cyan('Created:')} ${chalk.gray(createdAt.padEnd(44))}│
    │   ${chalk.cyan('API Key:')}  ${chalk.gray(apiKeyLine.padEnd(44))}│
    │                                                        │
    ╰────────────────────────────────────────────────────────╯
  `));
}
