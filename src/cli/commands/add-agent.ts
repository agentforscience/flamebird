/**
 * Add Agent Command
 * Adds a new agent to the runtime using their Agent4Science API key
 *
 * The agent info (handle, displayName, persona) is fetched from the Agent4Science API.
 * Agents must first be created on Agent4Science before they can be added to the runtime.
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import { loadConfig, validateSecrets } from '../../config/config.js';
import { createDatabase, getDatabase } from '../../db/database.js';
import { createAgentManager, getAgentManager } from '../../agents/agent-manager.js';
import { createAgent4ScienceClient } from '../../api/agent4science-client.js';

interface AddAgentOptions {
  apiKey?: string;
}

export async function addAgentCommand(handle: string, options: AddAgentOptions): Promise<void> {
  console.log(chalk.bold('\nAdding agent to runtime...'));

  try {
    const config = loadConfig();
    validateSecrets({ requireLlm: false }); // add only needs API URL + encryption

    // Initialize database (must be done before agent manager)
    try {
      getDatabase();
    } catch {
      createDatabase(config.database.path);
    }

    // Initialize Agent4Science client
    createAgent4ScienceClient({ baseUrl: config.api.apiUrl });

    // Initialize agent manager
    let manager: ReturnType<typeof createAgentManager>;
    try {
      manager = getAgentManager();
    } catch {
      manager = createAgentManager(config.security.encryptionKey);
    }

    // Get API key
    let apiKey = options.apiKey;
    if (!apiKey) {
      const answers = await inquirer.prompt([
        {
          type: 'password',
          name: 'apiKey',
          message: `Agent4Science API key for @${handle}:`,
          validate: (input) => input.length > 0 || 'API key is required',
        },
      ]);
      apiKey = answers.apiKey;
    }

    if (!apiKey) {
      throw new Error('API key is required');
    }

    console.log(chalk.gray('\nVerifying API key and fetching agent info from Agent4Science...'));

    // Add agent (manager fetches agent info from Agent4Science API)
    const agentConfig = await manager.addAgent(apiKey);

    // Verify handle matches (if provided)
    const expectedHandle = handle.replace('@', '');
    if (expectedHandle && agentConfig.handle !== expectedHandle) {
      console.log(chalk.yellow(`\nNote: API key belongs to @${agentConfig.handle}, not @${expectedHandle}`));
    }

    console.log(chalk.green('\n✓ Agent added successfully!\n'));
    console.log(chalk.bold('Agent Details:'));
    console.log(`  ID:          ${chalk.gray(agentConfig.id)}`);
    console.log(`  Handle:      ${chalk.cyan('@' + agentConfig.handle)}`);
    console.log(`  Name:        ${agentConfig.displayName}`);
    console.log(`  Voice:       ${agentConfig.persona.voice}`);
    console.log(`  Epistemics:  ${agentConfig.persona.epistemics}`);
    console.log(`  Topics:      ${agentConfig.persona.preferredTopics.join(', ') || 'none set'}`);
    console.log(`  Spice:       ${agentConfig.persona.spiceLevel}/10`);

    console.log(chalk.gray('\nRun "flamebird start" to begin autonomous operation.'));

  } catch (error) {
    console.error(chalk.red('\nFailed to add agent:'), error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
