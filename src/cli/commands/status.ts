/**
 * Status Command
 * Shows runtime status and agent activity
 */

import chalk from 'chalk';
import { loadConfig } from '../../config/config.js';
import { createDatabase, getDatabase } from '../../db/database.js';
import { createAgentManager, getAgentManager } from '../../agents/agent-manager.js';
import { getEventLoop } from '../../runtime/event-loop.js';

interface StatusOptions {
  watch?: boolean;
}

export async function statusCommand(options: StatusOptions): Promise<void> {
  const displayStatus = () => {
    // Clear screen in watch mode
    if (options.watch) {
      console.clear();
    }

    try {
      const config = loadConfig();
      let db = getDatabase();
      if (!db) {
        db = createDatabase(config.database.path);
      }

      let manager = getAgentManager();
      if (!manager) {
        manager = createAgentManager(config.security.encryptionKey);
      }

      // Header
      console.log(chalk.bold('\n═══════════════════════════════════════'));
      console.log(chalk.bold('  Agent4Science Agent Runtime Status'));
      console.log(chalk.bold('═══════════════════════════════════════\n'));

      // Runtime status
      const eventLoop = getEventLoop();
      if (eventLoop) {
        const stats = eventLoop.getStats();
        const uptime = Math.floor((Date.now() - stats.startTime.getTime()) / 1000);
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = uptime % 60;

        console.log(chalk.bold('Runtime:'));
        console.log(`  Status:     ${chalk.green('● Running')}`);
        console.log(`  Uptime:     ${hours}h ${minutes}m ${seconds}s`);
        console.log(`  Ticks:      ${stats.tickCount}`);
        console.log(`  Actions:    ${stats.actionsExecuted}`);
        console.log(`  Errors:     ${stats.errorsCount > 0 ? chalk.red(stats.errorsCount) : chalk.green(stats.errorsCount)}`);
      } else {
        console.log(chalk.bold('Runtime:'));
        console.log(`  Status:     ${chalk.gray('○ Stopped')}`);
      }

      // Agent status
      console.log('\n' + chalk.bold('Agents:'));
      const agentIds = manager.getAgentIds();

      if (agentIds.length === 0) {
        console.log(chalk.gray('  No agents configured'));
      } else {
        for (const agentId of agentIds) {
          const runtime = manager.getRuntime(agentId);
          if (!runtime) continue;

          const { config: agentConfig, state, lastPollTime, lastActionTime } = runtime;
          const status = agentConfig.enabled ? chalk.green('●') : chalk.gray('○');

          const stateEmoji = {
            idle: '💤',
            polling: '🔄',
            thinking: '🤔',
            acting: '⚡',
            cooldown: '⏳',
            error: '❌',
          }[state] || '❓';

          console.log(`  ${status} ${chalk.cyan('@' + agentConfig.handle)} ${stateEmoji} ${state}`);

          // Activity summary
          const activity = db.getAgentActivitySummary(agentConfig.id);
          const lastPoll = lastPollTime ? formatTimeAgo(lastPollTime) : 'never';
          const lastAction = lastActionTime ? formatTimeAgo(lastActionTime) : 'never';

          console.log(chalk.gray(`      Last poll: ${lastPoll} | Last action: ${lastAction}`));
          console.log(chalk.gray(`      Generated: `) +
            chalk.magenta(`${activity.papers} papers`) + chalk.gray(' | ') +
            chalk.cyan(`${activity.takes} takes`) + chalk.gray(' | ') +
            chalk.blue(`${activity.comments} comments`) + chalk.gray(' | ') +
            chalk.green(`${activity.votes} votes`));
        }
      }

      // Configuration summary
      console.log('\n' + chalk.bold('Configuration:'));
      console.log(`  API URL:    ${config.api.apiUrl}`);
      console.log(`  LLM:        ${config.llm.provider}/${config.llm.model}`);
      console.log(`  Poll:       ${config.polling.baseIntervalMs}ms - ${config.polling.maxIntervalMs}ms`);
      console.log(`  DB:         ${config.database.path}`);

      if (options.watch) {
        console.log(chalk.gray('\nRefreshing every 5s... Press Ctrl+C to exit'));
      }

    } catch (error) {
      console.error(chalk.red('\nFailed to get status:'), error instanceof Error ? error.message : error);
      if (!options.watch) {
        process.exit(1);
      }
    }
  };

  // Display once or watch
  displayStatus();

  if (options.watch) {
    setInterval(displayStatus, 5000);

    // Keep process alive
    process.on('SIGINT', () => {
      console.log(chalk.yellow('\nStopped watching.'));
      process.exit(0);
    });
  }
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
