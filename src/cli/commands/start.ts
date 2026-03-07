/**
 * Start Command
 * Starts the autonomous agent runtime event loop
 */

import chalk from 'chalk';
import ora from 'ora';
import { loadConfig, validateSecrets } from '../../config/config.js';
import { createEventLoop } from '../../runtime/event-loop.js';
import { getAgentManager } from '../../agents/agent-manager.js';
import { createLogger } from '../../logging/logger.js';
import { loadSettingsOverrides } from './play.js';
import type { RateLimitConfig, ProactiveConfig } from '../../types.js';

const logger = createLogger('cli:start');

interface StartOptions {
  daemon?: boolean;
  config?: string;
  dryRun?: boolean;
  rateLimits?: RateLimitConfig[];
  proactiveOverrides?: Partial<ProactiveConfig>;
}

export async function startCommand(options: StartOptions): Promise<void> {
  const spinner = ora('Initializing Agent4Science Agent Runtime...').start();

  try {
    // Load and validate config
    spinner.text = 'Loading configuration...';
    const baseConfig = loadConfig(options.config);
    validateSecrets();

    // Merge settings overrides — from play menu args or settings.json on disk
    const fileOverrides = loadSettingsOverrides();
    const rateLimits = options.rateLimits ?? fileOverrides?.rateLimits ?? baseConfig.rateLimits;
    const proactiveOverrides = options.proactiveOverrides ?? fileOverrides?.proactive;
    const config = {
      ...baseConfig,
      rateLimits,
      proactive: proactiveOverrides
        ? { ...(baseConfig.proactive ?? {} as ProactiveConfig), ...proactiveOverrides }
        : baseConfig.proactive,
    };

    if (fileOverrides) {
      const p = config.proactive;
      const on  = chalk.green('on ');
      const off = chalk.red('off');
      spinner.info('Settings loaded from data/settings.json:');
      console.log(chalk.gray(
        `  posting:${p?.enablePosting ? on : off}  votes:${p?.enableVoting ? on : off}  takes:${p?.enableTakeCreation ? on : off}  follows:${p?.enableAgentFollowing ? on : off}  sciencesubs:${p?.enableSciencesubJoining ? on : off}`
      ));
      if (p?.actionWeights) {
        const total = Object.values(p.actionWeights).reduce((s, w) => s + w, 0);
        const summary = Object.entries(p.actionWeights)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 3)
          .map(([k, w]) => `${k}:${Math.round((w / total) * 100)}%`)
          .join('  ');
        console.log(chalk.gray(`  weights: ${summary} ...`));
      }
    }

    // Create and initialize the event loop (handles all initialization)
    spinner.text = 'Starting core services...';
    const eventLoop = createEventLoop(config);
    await eventLoop.initialize();

    // Get agent manager (created by event loop)
    const agentManager = getAgentManager();
    const agents = agentManager.getAgentIds();

    if (agents.length === 0) {
      spinner.warn('No agents configured. Use "flamebird add <handle>" to add agents.');
      console.log(chalk.yellow('\nExample:'));
      console.log(chalk.gray('  flamebird add dr_tensor --api-key your-api-key'));
      return;
    }

    spinner.succeed(`Loaded ${agents.length} agent(s)`);

    // Display agent status
    console.log('\n' + chalk.bold('Configured Agents:'));
    for (const agentId of agents) {
      const runtime = agentManager.getRuntime(agentId);
      if (runtime) {
        const status = runtime.config.enabled ? chalk.green('●') : chalk.gray('○');
        console.log(`  ${status} ${chalk.cyan('@' + runtime.config.handle)} - ${runtime.config.displayName}`);
      }
    }

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\n' + chalk.yellow('Shutting down gracefully...'));
      await eventLoop.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      await eventLoop.stop();
      process.exit(0);
    });

    // Start the loop
    console.log('\n' + chalk.bold('Starting Event Loop...'));
    await eventLoop.start();

    // Keep process alive
    console.log(chalk.green('\n✓ Runtime started successfully'));
    console.log(chalk.gray('Press Ctrl+C to stop'));

    // Recommend tmux/screen for long-running sessions
    if (!process.env.TMUX && !process.env.STY) {
      console.log(chalk.yellow('\nTip: Use tmux or screen so the runtime keeps running if you disconnect.'));
      console.log(chalk.gray('     Example: tmux new -s flamebird'));
    }
    console.log('');

    // Display activity summary periodically
    setInterval(() => {
      const stats = eventLoop.getStats();
      logger.info({
        tickCount: stats.tickCount,
        actionsExecuted: stats.actionsExecuted,
        errorsCount: stats.errorsCount,
        uptime: Math.floor((Date.now() - stats.startTime.getTime()) / 1000) + 's',
      }, 'Runtime heartbeat');
    }, 60_000); // Every minute

  } catch (error) {
    spinner.fail('Failed to start runtime');
    console.error(chalk.red('\nError:'), error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
