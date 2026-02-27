/**
 * List Agents Command
 * Shows all configured agents
 */

import chalk from 'chalk';
import { loadConfig } from '../../config/config.js';
import { createDatabase, getDatabase } from '../../db/database.js';
import { createAgentManager, getAgentManager } from '../../agents/agent-manager.js';

interface ListOptions {
  verbose?: boolean;
}

export async function listAgentsCommand(options: ListOptions): Promise<void> {
  try {
    // Initialize database if not already
    const config = loadConfig();
    let db = getDatabase();
    if (!db) {
      db = createDatabase(config.database.path);
    }

    let manager = getAgentManager();
    if (!manager) {
      manager = createAgentManager(config.security.encryptionKey);
    }

    const agentIds = manager.getAgentIds();

    if (agentIds.length === 0) {
      console.log(chalk.yellow('\nNo agents configured.'));
      console.log(chalk.gray('Use "npx tsx src/cli/index.ts add <handle>" to add an agent.\n'));
      return;
    }

    console.log(chalk.bold(`\nConfigured Agents (${agentIds.length}):\n`));

    for (const agentId of agentIds) {
      const runtime = manager.getRuntime(agentId);
      if (!runtime) continue;

      const { config: agentConfig, state } = runtime;
      const status = agentConfig.enabled ? chalk.green('●') : chalk.gray('○');
      const stateColor = {
        idle: chalk.gray,
        polling: chalk.blue,
        thinking: chalk.yellow,
        acting: chalk.cyan,
        cooldown: chalk.magenta,
        error: chalk.red,
      }[state] || chalk.white;

      console.log(`${status} ${chalk.cyan('@' + agentConfig.handle)} - ${agentConfig.displayName}`);

      if (options.verbose) {
        console.log(`    ${chalk.gray('ID:')}          ${agentConfig.id}`);
        console.log(`    ${chalk.gray('State:')}       ${stateColor(state)}`);
        console.log(`    ${chalk.gray('Voice:')}       ${agentConfig.persona.voice}`);
        console.log(`    ${chalk.gray('Epistemics:')}  ${agentConfig.persona.epistemics}`);
        console.log(`    ${chalk.gray('Spice:')}       ${agentConfig.persona.spiceLevel}/10`);
        console.log(`    ${chalk.gray('Topics:')}      ${agentConfig.persona.preferredTopics.join(', ')}`);

        // Get engagement stats from database
        const engagements = db.getEngagementCount(agentConfig.id);
        const following = db.getFollowingCount(agentConfig.id);
        const sciencesubs = db.getMembershipCount(agentConfig.id);

        console.log(`    ${chalk.gray('Stats:')}       ${engagements} engagements, ${following} following, ${sciencesubs} sciencesubs`);
        console.log('');
      }
    }

    if (!options.verbose) {
      console.log(chalk.gray('\nUse --verbose for detailed info'));
    }

  } catch (error) {
    console.error(chalk.red('\nFailed to list agents:'), error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
