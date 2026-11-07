/**
 * List Agents Command
 * Shows all configured agents
 */

import chalk from 'chalk';
import { loadConfig } from '../../config/config.js';
import { createDatabase, tryGetDatabase } from '../../db/database.js';
import { decryptApiKey } from '../../agents/agent-manager.js';
import type { AgentConfig, AgentLLMOverride } from '../../types.js';
import { describeWorkProfile, harnessFor, resolveWorkSettings } from '../../llm/work-style.js';
import { describeFocus, focusOf } from '../../utils/focus.js';

interface ListOptions {
  verbose?: boolean;
  json?: boolean;
}

/** Last 4 characters of a key, masked. Never more. */
export function maskApiKey(key: string | undefined | null): string | null {
  if (!key) return null;
  return key.length > 8 ? `****${key.slice(-4)}` : '****';
}

/**
 * One agent for `flamebird list --json`. The decrypted key is never included:
 * only `apiKeyLast4` (masked) so owners can tell keys apart.
 */
export function agentJsonRecord(
  a: AgentConfig & { apiKeyEncrypted: string },
  llm: { provider: string; model: string },
  decrypt: (encrypted: string) => string,
) {
  let apiKeyLast4: string | null = null;
  try {
    apiKeyLast4 = maskApiKey(decrypt(a.apiKeyEncrypted));
  } catch {
    apiKeyLast4 = null;
  }
  return {
    id: a.id,
    handle: a.handle,
    displayName: a.displayName,
    apiKeyLast4,
    model: a.llmOverride ? `${a.llmOverride.provider}/${a.llmOverride.model}` : `${llm.provider}/${llm.model}`,
    llmOverride: a.llmOverride ?? null,
    workStyle: a.persona.workStyle ?? null,
    domain: harnessFor(a.persona).domain ?? null,
    workSettings: resolveWorkSettings(a.persona),
    focus: focusOf(a.persona) ?? null,
  };
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

    // --json: agent list for scripting. API keys are masked to the last 4 characters.
    if (options.json) {
      const decrypt = (enc: string) => decryptApiKey(enc, config.security.encryptionKey);
      const out = agents.map(a => agentJsonRecord(a, config.llm, decrypt));
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    console.log(chalk.bold(`\nConfigured Agents (${agents.length}):\n`));

    for (const agent of agents) {
      const status = agent.enabled ? chalk.green('●') : chalk.gray('○');
      const modelStr = formatModel(agent.llmOverride, config.llm.model, config.llm.provider);

      console.log(`${status} ${chalk.cyan('@' + agent.handle)} - ${agent.displayName}  ${chalk.gray('model:')} ${modelStr}`);
      console.log(`    ${chalk.gray('style:')} ${describeWorkProfile(agent.persona)}`);
      if (focusOf(agent.persona)) console.log(`    ${chalk.gray('focus:')} ${describeFocus(agent.persona)}`);

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
      console.log(chalk.gray('Use "flamebird set-style <handle> <style>" to set how an agent solves and reviews'));
    }

  } catch (error) {
    console.error(chalk.red('\nFailed to list agents:'), error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
