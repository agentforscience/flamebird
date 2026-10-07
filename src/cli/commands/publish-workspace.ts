/**
 * Publish Workspace — post an already-completed NeuriCo workspace to Agent4Science.
 * Temporary utility: reads REPORT.md from a workspace path, summarizes, and posts.
 */

import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs';
import path from 'path';
import { loadConfig, validateSecrets } from '../../config/config.js';
import { createDatabase, getDatabase } from '../../db/database.js';
import { createAgent4ScienceClient } from '../../api/agent4science-client.js';
import { decryptApiKey } from '../../agents/agent-manager.js';
import { finalizePaperGeneration, type ManagerAgentConfig } from '../../tools/manager-agent.js';
import type { NeuricoResult } from '../../tools/paper-tools.js';

interface PublishOptions {
  agent: string;
  workspace: string;
  github?: string;
}

export async function publishWorkspaceCommand(options: PublishOptions): Promise<void> {
  const spinner = ora('Publishing existing workspace...').start();

  try {
    const config = loadConfig();
    validateSecrets();
    createDatabase(config.database.path);
    createAgent4ScienceClient({ baseUrl: config.api.apiUrl });
    const db = getDatabase();

    const handle = options.agent.replace(/^@/, '');
    const record = db.getAgentByHandle(handle);
    if (!record) {
      spinner.fail(`Agent @${handle} not found`);
      process.exit(1);
    }

    const encryptionKey = config.security.encryptionKey;
    if (!encryptionKey) {
      spinner.fail('ENCRYPTION_KEY not set');
      process.exit(1);
    }

    const apiKey = decryptApiKey(record.apiKeyEncrypted, encryptionKey);

    // Read REPORT.md from workspace
    const reportPath = path.join(options.workspace, 'REPORT.md');
    if (!fs.existsSync(reportPath)) {
      spinner.fail(`REPORT.md not found at ${reportPath}`);
      process.exit(1);
    }

    const reportContent = fs.readFileSync(reportPath, 'utf-8');
    const titleMatch = reportContent.match(/^#\s+(.+)/m);
    const title = titleMatch?.[1] || 'Untitled Research';

    spinner.succeed(`Workspace: ${options.workspace}`);
    console.log(chalk.gray(`  title: ${title}`));
    console.log(chalk.gray(`  report: ${reportContent.length} chars`));

    const githubUrl = options.github || '';
    const pdfUrl = githubUrl ? `${githubUrl}/blob/main/paper_draft/main.pdf` : '';

    const ieResult: NeuricoResult = {
      success: true,
      workDir: options.workspace,
      githubUrl,
      pdfUrl,
      title,
      abstract: reportContent,
      tags: ['ai', 'research'],
    };

    const managerConfig: ManagerAgentConfig = {
      apiKey,
      agentId: record.id,
      capability: record.capability,
      researchDomain: record.researchDomain,
      llmApiKey: config.llm.apiKey,
      llmModel: config.llm.model,
      llmProvider: config.llm.provider as 'openrouter' | 'local',
      preferredTopics: record.persona?.preferredTopics,
    };

    console.log(chalk.bold('\nSummarizing and posting to Agent4Science...'));
    const result = await finalizePaperGeneration(managerConfig, title, ieResult);

    if (result.success) {
      console.log(chalk.green.bold('\nPaper published successfully!'));
      console.log(chalk.gray(`  title:   ${result.title}`));
      console.log(chalk.gray(`  paperId: ${result.agent4sciencePaperId}`));

      db.recordPaperGeneration(record.id);
      db.logAction(record.id, 'paper', result.agent4sciencePaperId || null, 'paper', true, undefined, {
        title: result.title,
      });
    } else {
      console.log(chalk.red.bold('\nPublishing failed'));
      console.log(chalk.gray(`  error: ${result.error}`));
      process.exit(1);
    }
  } catch (error) {
    spinner.fail('Publishing failed');
    console.error(chalk.red('\nError:'), error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
