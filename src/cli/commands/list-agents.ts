/**
 * List Agents Command
 * Shows all configured agents
 */

import chalk from 'chalk';
import { loadConfig } from '../../config/config.js';
import { createDatabase, tryGetDatabase } from '../../db/database.js';
import { decryptApiKey } from '../../agents/agent-manager.js';
import type { AgentLLMOverride } from '../../types.js';

interface ListOptions {
  verbose?: boolean;
  json?: boolean;
}

function formatModel(llmOverride: AgentLLMOverride | undefined, globalModel: string, globalProvider: string): string {
  if (llmOverride) {
    return chalk.cyan(`${llmOverride.provider}/${llmOverride.model}`);
  }
  return chalk.gray(`[global] ${globalProvider}/${globalModel}`);
}

export async function listAgentsCommand(options: ListOptions): Promise<void> {
  try {
    // Suppress info logs for machine-readable output
    if (options.json) process.env.LOG_LEVEL = 'error';

    // Initialize database if not already
    const config = loadConfig();
    let db = tryGetDatabase();
    if (!db) {
      db = createDatabase(config.database.path);
    }

    const agents = db.getAllAgents();

    if (agents.length === 0) {
      if (options.json) {
        console.log('[]');
        return;
      }
      console.log(chalk.yellow('\nNo agents configured.'));
      console.log(chalk.gray('Use "flamebird create" to create an agent.\n'));
      return;
    }

    // --json: output raw agent list for scripting (used by CLAUDE.md one-liner)
    if (options.json) {
      const out = agents.map(a => ({
        id: a.id,
        handle: a.handle,
        displayName: a.displayName,
        apiKey: decryptApiKey(a.apiKeyEncrypted, config.security.encryptionKey),
        model: a.llmOverride ? `${a.llmOverride.provider}/${a.llmOverride.model}` : `${config.llm.provider}/${config.llm.model}`,
        llmOverride: a.llmOverride ?? null,
      }));
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    console.log(chalk.bold(`\nConfigured Agents (${agents.length}):\n`));

    for (const agent of agents) {
      const status = agent.enabled ? chalk.green('●') : chalk.gray('○');
      const modelStr = formatModel(agent.llmOverride, config.llm.model, config.llm.provider);

      console.log(`${status} ${chalk.cyan('@' + agent.handle)} - ${agent.displayName}  ${chalk.gray('model:')} ${modelStr}`);

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
      console.log(chalk.gray('Use "flamebird set-model <handle> <provider/model>" to configure per-agent model'));
    }

  } catch (error) {
    console.error(chalk.red('\nFailed to list agents:'), error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
