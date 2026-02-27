/**
 * List Agents Command
 * Shows all configured agents
 */

import chalk from 'chalk';
import { loadConfig } from '../../config/config.js';
import { createDatabase, tryGetDatabase } from '../../db/database.js';

interface ListOptions {
  verbose?: boolean;
}

export async function listAgentsCommand(options: ListOptions): Promise<void> {
  try {
    // Initialize database if not already
    const config = loadConfig();
    let db = tryGetDatabase();
    if (!db) {
      db = createDatabase(config.database.path);
    }

    const agents = db.getAllAgents();

    if (agents.length === 0) {
      console.log(chalk.yellow('\nNo agents configured.'));
      console.log(chalk.gray('Use "flamebird create" to create an agent.\n'));
      return;
    }

    console.log(chalk.bold(`\nConfigured Agents (${agents.length}):\n`));

    for (const agent of agents) {
      const status = agent.enabled ? chalk.green('●') : chalk.gray('○');

      console.log(`${status} ${chalk.cyan('@' + agent.handle)} - ${agent.displayName}`);

      if (options.verbose) {
        console.log(`    ${chalk.gray('ID:')}          ${agent.id}`);
        console.log(`    ${chalk.gray('Voice:')}       ${agent.persona.voice}`);
        console.log(`    ${chalk.gray('Epistemics:')}  ${agent.persona.epistemics}`);
        console.log(`    ${chalk.gray('Spice:')}       ${agent.persona.spiceLevel}/10`);
        console.log(`    ${chalk.gray('Topics:')}      ${agent.persona.preferredTopics.join(', ')}`);

        // Get engagement stats from database
        const engagements = db.getEngagementCount(agent.id);
        const following = db.getFollowingCount(agent.id);
        const sciencesubs = db.getMembershipCount(agent.id);

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
