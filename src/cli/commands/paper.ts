/**
 * Paper Command
 *
 * One-shot paper generation: pick topic, launch NeuriCo, wait for completion,
 * post to Agent4Science, then exit. Designed for cron or manual use —
 * does NOT start the full event loop.
 */

import chalk from 'chalk';
import ora from 'ora';
import { loadConfig, validateSecrets } from '../../config/config.js';
import { createDatabase, getDatabase } from '../../db/database.js';
import { createAgent4ScienceClient } from '../../api/agent4science-client.js';
import { decryptApiKey } from '../../agents/agent-manager.js';
import { runNeuricoFlow, type ManagerAgentConfig } from '../../tools/manager-agent.js';
import { createLogger } from '../../logging/logger.js';

const logger = createLogger('cli:paper');

interface PaperOptions {
  agent?: string;
}

export async function paperCommand(options: PaperOptions): Promise<void> {
  const spinner = ora('Preparing one-shot paper generation...').start();

  try {
    spinner.text = 'Loading configuration...';
    const config = loadConfig();
    validateSecrets();

    // Initialize database and API client (normally the event loop does this)
    createDatabase(config.database.path);
    createAgent4ScienceClient({ baseUrl: config.api.apiUrl });
    const db = getDatabase();

    // Find the agent
    const handle = options.agent?.replace(/^@/, '');
    if (!handle) {
      spinner.fail('Missing --agent flag');
      console.log(chalk.yellow('\nUsage:'));
      console.log(chalk.gray('  flamebird paper --agent dr_falsify'));
      process.exit(1);
    }

    const record = db.getAgentByHandle(handle);
    if (!record) {
      spinner.fail(`Agent @${handle} not found`);
      console.log(chalk.gray('Run "flamebird list" to see available agents.'));
      process.exit(1);
    }

    if (record.capability !== 'neurico') {
      spinner.fail(`Agent @${handle} has capability "${record.capability}" — paper generation requires "neurico"`);
      process.exit(1);
    }

    const encryptionKey = config.security.encryptionKey;
    if (!encryptionKey) {
      spinner.fail('ENCRYPTION_KEY not set — cannot decrypt agent API key');
      process.exit(1);
    }

    const apiKey = decryptApiKey(record.apiKeyEncrypted, encryptionKey);
    const neuricoProvider = (process.env.NEURICO_PROVIDER as 'claude' | 'codex' | 'gemini') || undefined;

    const managerConfig: ManagerAgentConfig = {
      apiKey,
      agentId: record.id,
      capability: record.capability,
      researchDomain: record.researchDomain,
      llmApiKey: config.llm.apiKey,
      llmModel: config.llm.model,
      llmProvider: config.llm.provider as 'openrouter' | 'local',
      githubToken: process.env.GITHUB_TOKEN,
      githubOrg: process.env.GITHUB_ORG,
      neuricoPath: process.env.NEURICO_PATH,
      neuricoProvider,
      preferredTopics: record.persona?.preferredTopics,
    };

    spinner.succeed(`Agent: @${handle} (${record.displayName || handle})`);
    console.log(chalk.gray(`  domain: ${record.researchDomain || 'not set'}`));
    console.log(chalk.gray(`  provider: ${neuricoProvider || 'claude'}`));
    console.log('');

    console.log(chalk.bold('Starting paper generation pipeline...'));
    console.log(chalk.gray('  1. Discover trending topics'));
    console.log(chalk.gray('  2. Generate research idea'));
    console.log(chalk.gray('  3. Launch NeuriCo (submit + run experiments)'));
    console.log(chalk.gray('  4. Wait for completion (polls every 30s)'));
    console.log(chalk.gray('  5. Summarize and post to Agent4Science'));
    console.log('');

    const startTime = Date.now();
    const result = await runNeuricoFlow(managerConfig);
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;

    console.log('');
    if (result.success) {
      console.log(chalk.green.bold('Paper published successfully!'));
      console.log(chalk.gray(`  title:    ${result.title}`));
      console.log(chalk.gray(`  paperId:  ${result.agent4sciencePaperId}`));
      console.log(chalk.gray(`  github:   ${result.githubUrl}`));
      console.log(chalk.gray(`  elapsed:  ${mins}m ${secs}s`));

      // Record successful generation
      db.recordPaperGeneration(record.id);
      db.logAction(record.id, 'paper', result.agent4sciencePaperId || null, 'paper', true, undefined, {
        title: result.title,
        githubUrl: result.githubUrl,
      });
    } else {
      console.log(chalk.red.bold('Paper generation failed'));
      console.log(chalk.gray(`  error:    ${result.error}`));
      if (result.githubUrl) console.log(chalk.gray(`  github:   ${result.githubUrl}`));
      console.log(chalk.gray(`  elapsed:  ${mins}m ${secs}s`));

      db.recordPaperGeneration(record.id);
      db.logAction(record.id, 'paper', null, 'paper', false, result.error);
      process.exit(1);
    }
  } catch (error) {
    spinner.fail('Paper generation failed');
    console.error(chalk.red('\nError:'), error instanceof Error ? error.message : error);
    logger.error({ error }, 'Unhandled error in paper command');
    process.exit(1);
  }
}
