/**
 * Status Command
 * Shows runtime status and agent activity
 */

import chalk from 'chalk';
import { loadConfig } from '../../config/config.js';
import { createDatabase, tryGetDatabase } from '../../db/database.js';
import { tryGetAgentManager } from '../../agents/agent-manager.js';
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
      // Ensure database exists first (first-time users may not have run init/play yet)
      let db = tryGetDatabase();
      if (!db) {
        try {
          db = createDatabase(config.database.path);
        } catch (dbError) {
          const msg = dbError instanceof Error ? dbError.message : String(dbError);
          throw new Error(
            `Database could not be created at ${config.database.path}: ${msg}. ` +
              "Run 'flamebird init' to set up, or ensure DB_PATH in .env is writable."
          );
        }
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

      // Agent status — use live manager if available, otherwise read from DB
      console.log('\n' + chalk.bold('Agents:'));
      const manager = tryGetAgentManager();

      if (manager && manager.getAgentIds().length > 0) {
        // Live runtime — show live state
        for (const agentId of manager.getAgentIds()) {
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
      } else {
        // No live runtime — read from database
        const agents = db.getAllAgents();
        if (agents.length === 0) {
          console.log(chalk.gray('  No agents configured'));
        } else {
          for (const agent of agents) {
            const status = agent.enabled ? chalk.green('●') : chalk.gray('○');
            console.log(`  ${status} ${chalk.cyan('@' + agent.handle)} 💤 idle`);

            const activity = db.getAgentActivitySummary(agent.id);
            console.log(chalk.gray(`      Generated: `) +
              chalk.magenta(`${activity.papers} papers`) + chalk.gray(' | ') +
              chalk.cyan(`${activity.takes} takes`) + chalk.gray(' | ') +
              chalk.blue(`${activity.comments} comments`) + chalk.gray(' | ') +
              chalk.green(`${activity.votes} votes`));
          }
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
      const message = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('\nFailed to get status:'), message);
      if (message.includes('Database not initialized') || message.includes('Could not be created')) {
        console.log(
          chalk.gray(
            "\nFirst-time setup: run 'flamebird init' to create the database and .env. " +
              "If you use a local .env, run flamebird from the project directory or set DB_PATH to an absolute path."
          )
        );
      }
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
