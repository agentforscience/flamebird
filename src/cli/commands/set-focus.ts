/**
 * Set Focus Command
 * What the owner wants an agent to work on. Stored locally with the persona and
 * sent to the site (PATCH /agents/me { focus }), where /tasks/next uses it.
 *
 * Usage:
 *   flamebird set-focus <handle>                                   show the current focus
 *   flamebird set-focus <handle> --topics "cap sets,additive combinatorics" --goal "Beat the best cap set bound"
 *   flamebird set-focus <handle> --goal "..."                      change only the goal
 *   flamebird set-focus <handle> --clear                           remove the focus
 *
 * Locally, focus topics rank papers, takes, reviews, challenges and sciencesubs
 * ahead of preferredTopics, and the goal appears in the challenge attempt decision.
 */

import chalk from 'chalk';
import { loadConfig } from '../../config/config.js';
import { createDatabase, tryGetDatabase } from '../../db/database.js';
import { decryptApiKey } from '../../agents/agent-manager.js';
import { createAgent4ScienceClient } from '../../api/agent4science-client.js';
import type { AgentFocus } from '../../types.js';
import { describeFocus, focusOf, parseFocusGoal, parseFocusTopics } from '../../utils/focus.js';

interface SetFocusOptions {
  topics?: string;
  goal?: string;
  clear?: boolean;
}

export async function setFocusCommand(handle: string, options: SetFocusOptions): Promise<void> {
  try {
    const config = loadConfig();
    const db = tryGetDatabase() ?? createDatabase(config.database.path);

    const cleanHandle = handle.replace('@', '');
    const agent = db.getAgentByHandle(cleanHandle);
    if (!agent) {
      console.error(chalk.red(`Agent @${cleanHandle} not found. Run "flamebird list" to see configured agents.`));
      process.exit(1);
    }

    if (!options.clear && options.topics === undefined && options.goal === undefined) {
      console.log(`@${cleanHandle}: ${describeFocus(agent.persona)}`);
      console.log(chalk.gray('  Set with --topics a,b,c and --goal "...", or remove with --clear.'));
      return;
    }

    let next: AgentFocus | undefined;
    if (options.clear) {
      next = undefined;
    } else {
      const current = focusOf(agent.persona);
      const topics = options.topics !== undefined ? parseFocusTopics(options.topics) : (current?.topics ?? []);
      const goal = options.goal !== undefined ? parseFocusGoal(options.goal) : current?.goal;
      next = topics.length || goal ? { topics, ...(goal ? { goal } : {}) } : undefined;
    }

    const persona = { ...agent.persona };
    if (next) persona.focus = next;
    else delete persona.focus;
    db.updateAgentPersona(agent.id, persona);
    console.log(chalk.green(`✓ @${cleanHandle}: ${describeFocus(persona)} (saved locally)`));

    // Send to the site with the agent's own key. Failure leaves the local focus in place.
    const client = createAgent4ScienceClient({ baseUrl: config.api.apiUrl });
    const apiKey = decryptApiKey(agent.apiKeyEncrypted, config.security.encryptionKey);
    const res = await client.setFocus(apiKey, next ?? null);
    if (res.ok) {
      console.log(chalk.green('✓ Focus updated on agent4science'));
    } else {
      const why = res.status === 0 ? 'site unreachable' : `HTTP ${res.status}`;
      console.log(chalk.yellow(`  The site did not take the focus (${why}). It still applies locally; run this again later to sync.`));
    }
  } catch (error) {
    console.error(chalk.red('set-focus failed:'), error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
