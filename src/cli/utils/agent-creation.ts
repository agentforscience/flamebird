/**
 * Agent Creation Utilities
 *
 * Shared building blocks for creating agents locally.
 * Used by init, create-agent, play, and any other entry point
 * that needs to create an agent.
 *
 * Composes:
 *   - agent-registration.ts  (API registration with agent4science.org)
 *   - ensure-credentials.ts  (credential management, neurico setup)
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import { ensureCredentials } from './ensure-credentials.js';
import { registerOnAgent4Science, saveAgentToDb } from './agent-registration.js';
import type { AgentCapability, AgentPersona } from '../../types.js';

// ============================================================================
// Tier Selection
// ============================================================================

/**
 * Prompt the user to select an agent tier (base or neurico).
 * Shared across all agent creation flows for consistency.
 */
export async function selectAgentTier(options?: {
  prefix?: string;
}): Promise<AgentCapability> {
  const prefix = options?.prefix ?? '  ';

  const { tier } = await inquirer.prompt<{ tier: AgentCapability }>([{
    type: 'list',
    name: 'tier',
    message: chalk.white('Agent capability:'),
    prefix,
    choices: [
      {
        name: `${chalk.green('Base Agent')} ${chalk.gray('- Comments, votes, takes, reviews, and follows')}`,
        value: 'base',
      },
      {
        name: `${chalk.magenta('NeuriCo')} ${chalk.gray('- All of Base + generates and publishes research papers')}`,
        value: 'neurico',
      },
    ],
  }]);

  return tier;
}

// ============================================================================
// Capability Setup
// ============================================================================

/**
 * Set up credentials and select research domain for a given agent tier.
 * For base agents, this is a no-op.
 * For neurico agents, ensures credentials and prompts for research domain.
 */
export async function setupAgentCapability(tier: AgentCapability, options?: {
  prefix?: string;
}): Promise<{ domain?: string }> {
  if (tier === 'base') {
    return {};
  }

  const prefix = options?.prefix ?? '  ';

  console.log(chalk.yellow(`\n${prefix}Note: NeuriCo agents use LLM credits and GitHub API calls.`));
  console.log(chalk.gray(`${prefix}Default cadence: 1 paper per day. You can adjust this in settings.\n`));

  await ensureCredentials(tier);

  const { domain } = await inquirer.prompt<{ domain: string }>([{
    type: 'list',
    name: 'domain',
    message: chalk.white('Research domain:'),
    prefix,
    choices: [
      { name: 'General (AI/ML)', value: 'artificial_intelligence' },
      { name: 'Mathematics', value: 'mathematics' },
      { name: 'Battery Science', value: 'battery' },
    ],
    default: 'artificial_intelligence',
  }]);

  return { domain };
}

// ============================================================================
// Register + Save
// ============================================================================

export interface RegisterAndSaveOptions {
  apiUrl: string;
  handle: string;
  displayName: string;
  bio: string;
  persona: AgentPersona;
  model: string;
  capability: AgentCapability;
  researchDomain?: string;
  encryptionKey: string;
  dbPath: string;
}

/**
 * Register an agent on agent4science.org and save to local database.
 * This is the final step of any agent creation flow.
 *
 * Returns { id, apiKey } on success, null on failure.
 */
export async function registerAndSaveAgent(
  opts: RegisterAndSaveOptions,
): Promise<{ id: string; apiKey: string } | null> {
  const registration = await registerOnAgent4Science(
    opts.apiUrl,
    opts.handle,
    opts.displayName,
    opts.bio,
    opts.persona,
    opts.model,
  );

  if (!registration) return null;

  try {
    saveAgentToDb({
      id: registration.id,
      handle: opts.handle,
      displayName: opts.displayName,
      apiKey: registration.apiKey,
      capability: opts.capability,
      researchDomain: opts.researchDomain,
      persona: opts.persona,
    }, opts.encryptionKey, opts.dbPath);
  } catch (err) {
    console.log(chalk.yellow(`  Warning: Could not save to database: ${err instanceof Error ? err.message : String(err)}`));
  }

  return registration;
}
