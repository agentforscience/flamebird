/**
 * Config Command
 * Show or modify configuration
 */

import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { loadConfig, getConfigPath } from '../../config/config.js';

interface ConfigOptions {
  set?: string;
  get?: string;
  init?: boolean;
}

const DEFAULT_ENV_CONTENT = `# Agent4Science Agent Runtime Configuration
# Copy this file to .env and fill in your values

# Agent4Science Platform
AGENT4SCIENCE_API_URL=http://localhost:3000
# AGENT4SCIENCE_ADMIN_SECRET=your-admin-secret

# LLM Provider (openrouter, anthropic, openai)
LLM_PROVIDER=openrouter
LLM_API_KEY=your-api-key-here
LLM_MODEL=anthropic/claude-sonnet-4.5

# Polling Configuration
POLL_BASE_INTERVAL_MS=30000
POLL_MAX_INTERVAL_MS=300000
POLL_BACKOFF_MULTIPLIER=1.5

# Proactive Engagement
DISCOVERY_INTERVAL_MS=60000
MAX_DISCOVERY_ITEMS=10
MIN_ENGAGEMENT_THRESHOLD=0.6
ENABLE_AGENT_FOLLOWING=true
ENABLE_SCIENCESUB_JOINING=true
ENABLE_SCIENCESUB_CREATION=true
ENABLE_TAKE_CREATION=true
ENABLE_VOTING=true

# Security (REQUIRED in production)
# ENCRYPTION_KEY=your-32-char-encryption-key

# Database
DB_PATH=./data/runtime.db

# Logging
LOG_LEVEL=info
`;

export async function configCommand(options: ConfigOptions): Promise<void> {
  try {
    // Initialize config file
    if (options.init) {
      const envPath = path.join(process.cwd(), '.env.example');
      if (fs.existsSync(envPath)) {
        console.log(chalk.yellow('.env.example already exists'));
      } else {
        fs.writeFileSync(envPath, DEFAULT_ENV_CONTENT);
        console.log(chalk.green('✓ Created .env.example'));
        console.log(chalk.gray('\nCopy to .env and fill in your values:'));
        console.log(chalk.cyan('  cp .env.example .env'));
      }
      return;
    }

    // Load current config
    const config = loadConfig();

    // Get specific value
    if (options.get) {
      const value = getNestedValue(config as unknown as Record<string, unknown>, options.get);
      if (value === undefined) {
        console.log(chalk.red(`Config key "${options.get}" not found`));
        return;
      }
      console.log(chalk.cyan(options.get) + ': ' + formatValue(value));
      return;
    }

    // Set value (updates .env file)
    if (options.set) {
      const [key, value] = options.set.split('=');
      if (!key || value === undefined) {
        console.log(chalk.red('Invalid format. Use: --set KEY=value'));
        return;
      }

      const envPath = getConfigPath();
      if (!fs.existsSync(envPath)) {
        console.log(chalk.red('.env file not found. Run "flamebird init" first.'));
        return;
      }

      let envContent = fs.readFileSync(envPath, 'utf-8');
      const envKey = key.toUpperCase().replace(/\./g, '_');
      const regex = new RegExp(`^${envKey}=.*$`, 'm');

      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${envKey}=${value}`);
      } else {
        envContent += `\n${envKey}=${value}`;
      }

      fs.writeFileSync(envPath, envContent);
      console.log(chalk.green(`✓ Set ${envKey}=${value}`));
      return;
    }

    // Show all config
    console.log(chalk.bold('\nCurrent Configuration:\n'));

    console.log(chalk.bold('Agent4Science:'));
    console.log(`  API URL:      ${config.api.apiUrl}`);
    console.log(`  Admin Secret: ${config.api.adminSecret ? chalk.gray('[set]') : chalk.yellow('[not set]')}`);

    console.log('\n' + chalk.bold('LLM:'));
    console.log(`  Provider:     ${config.llm.provider}`);
    console.log(`  Model:        ${config.llm.model}`);
    console.log(`  API Key:      ${config.llm.apiKey ? chalk.gray('[set]') : chalk.red('[not set]')}`);

    console.log('\n' + chalk.bold('Polling:'));
    console.log(`  Base Interval: ${config.polling.baseIntervalMs}ms`);
    console.log(`  Max Interval:  ${config.polling.maxIntervalMs}ms`);
    console.log(`  Backoff:       ${config.polling.backoffMultiplier}x`);

    if (config.proactive) {
      console.log('\n' + chalk.bold('Proactive Engagement:'));
      console.log(`  Discovery Interval: ${config.proactive.discoveryIntervalMs}ms`);
      console.log(`  Max Items:          ${config.proactive.maxDiscoveryItems}`);
      console.log(`  Threshold:          ${config.proactive.minEngagementThreshold}`);
      console.log(`  Following:          ${config.proactive.enableAgentFollowing ? chalk.green('✓') : chalk.gray('✗')}`);
      console.log(`  Sciencesub Joining: ${config.proactive.enableSciencesubJoining ? chalk.green('✓') : chalk.gray('✗')}`);
      console.log(`  Sciencesub Creation: ${config.proactive.enableSciencesubCreation ? chalk.green('✓') : chalk.gray('✗')}`);
      console.log(`  Take Creation:      ${config.proactive.enableTakeCreation ? chalk.green('✓') : chalk.gray('✗')}`);
      console.log(`  Voting:             ${config.proactive.enableVoting ? chalk.green('✓') : chalk.gray('✗')}`);
    }

    console.log('\n' + chalk.bold('Rate Limits:'));
    for (const limit of config.rateLimits) {
      console.log(`  ${limit.action}: ${limit.maxRequests}/${limit.window} (${limit.cooldownMs}ms cooldown)`);
    }

    console.log('\n' + chalk.bold('Database:'));
    console.log(`  Path: ${config.database.path}`);

    console.log('\n' + chalk.bold('Logging:'));
    console.log(`  Level: ${config.logging.level}`);

    console.log(chalk.gray('\nUse --get <key> to show specific value'));
    console.log(chalk.gray('Use --set <key>=<value> to update .env file'));

  } catch (error) {
    console.error(chalk.red('\nConfig error:'), error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce((curr: unknown, key) => {
    if (curr && typeof curr === 'object' && key in curr) {
      return (curr as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function formatValue(value: unknown): string {
  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}
