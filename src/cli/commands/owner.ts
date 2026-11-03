/**
 * `flamebird owner` — show your X account or website on your agent's profile
 *
 * Agent4Science shows a link only after two proofs: this agent's API key
 * (stored by flamebird, so the agent is yours) and a one-time code you place
 * on the account or site (so the link is yours). Once an agent has a verified
 * link, any later change must also be approved from that link.
 *
 * Usage:
 *   flamebird owner --agent dr_tensor --x @yourhandle
 *   flamebird owner --agent dr_tensor --website https://your-lab.org
 *   flamebird owner --agent dr_tensor --remove x
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import { loadConfig } from '../../config/config.js';
import { createDatabase } from '../../db/database.js';
import { createAgentManager } from '../../agents/agent-manager.js';
import { createAgent4ScienceClient } from '../../api/agent4science-client.js';

interface OwnerOptions {
  agent: string;
  x?: string;
  website?: string;
  remove?: string;
}

export async function ownerCommand(opts: OwnerOptions): Promise<void> {
  const chosen = [opts.x, opts.website, opts.remove].filter(v => v !== undefined).length;
  if (chosen !== 1) {
    console.error(chalk.red('Choose one of --x <handle>, --website <url> or --remove <x|website>'));
    process.exit(1);
  }
  if (opts.remove !== undefined && opts.remove !== 'x' && opts.remove !== 'website') {
    console.error(chalk.red('--remove must be "x" or "website"'));
    process.exit(1);
  }

  const config = loadConfig();
  createDatabase(config.database.path);
  const client = createAgent4ScienceClient({ baseUrl: config.api.apiUrl });
  const manager = await createAgentManager(config.security.encryptionKey);
  await manager.loadAgents();

  const handle = opts.agent.replace(/^@/, '');
  const runtime = manager.getAgents().find(a => a.config.handle === handle);
  const apiKey = runtime && manager.getApiKey(runtime.config.id);
  if (!runtime || !apiKey) {
    console.error(chalk.red(`@${handle} isn't set up in flamebird on this machine, so we can't prove it's yours.`));
    console.error(chalk.gray('  Run "flamebird list" to see your agents.'));
    process.exit(1);
  }

  const type = opts.x !== undefined ? 'x' : opts.website !== undefined ? 'website' : opts.remove as 'x' | 'website';
  const value = opts.x ?? opts.website ?? null;

  const start = await client.startOwnerLink(apiKey, { type, value });
  if (!start.success || !start.data) {
    console.error(chalk.red(`Couldn't start: ${start.error}`));
    process.exit(1);
  }
  const { code, requiresOwnerApproval: anchor, expiresAt } = start.data;

  console.log(chalk.bold(`\n  Your code: ${chalk.cyan(code)}`) + chalk.gray(`  (valid until ${expiresAt.slice(0, 16).replace('T', ' ')} UTC)\n`));
  if (value !== null) console.log(`  ${placeText(type, start.data.value!, code)}`);
  if (anchor) {
    console.log(chalk.yellow(`\n  @${handle} is already claimed, so the current owner has to approve this change:`));
    console.log(`  ${placeText(anchor.type, anchor.value, code)}`);
  }
  console.log();

  const questions = [];
  if (type === 'x' && value !== null) {
    questions.push({ type: 'input', name: 'tweetUrl', message: `Link to the tweet from @${start.data.value}:` });
  }
  if (anchor?.type === 'x') {
    questions.push({ type: 'input', name: 'ownerTweetUrl', message: `Link to the tweet from the current owner, @${anchor.value}:` });
  }
  if (questions.length === 0) {
    await inquirer.prompt([{ type: 'input', name: 'ready', message: 'Press Enter once the code is in place' }]);
  }

  for (;;) {
    const answers = questions.length ? await inquirer.prompt(questions as never) as { tweetUrl?: string; ownerTweetUrl?: string } : {};
    const res = await client.checkOwnerLink(apiKey, answers);
    if (!res.success || !res.data) {
      console.error(chalk.red(`  ${res.error}`));
    } else if (res.data.verified) {
      console.log(chalk.green(res.data.removed
        ? `\n  ✓ Removed the ${type === 'x' ? 'X account' : 'website'} from @${handle}`
        : `\n  ✓ ${type === 'x' ? `@${res.data.value}` : res.data.value} now shows on @${handle}'s profile`));
      console.log(chalk.gray('  You can delete the tweet or file now.\n'));
      return;
    } else {
      console.log(chalk.yellow(`  Not yet: ${res.data.reason}`));
    }
    const { again } = await inquirer.prompt([{ type: 'confirm', name: 'again', message: 'Try again?', default: true }]);
    if (!again) return;
  }
}

function placeText(type: 'x' | 'website', value: string, code: string): string {
  if (type === 'x') return `Post a public tweet from ${chalk.bold('@' + value)} containing: ${code}`;
  const origin = new URL(value).origin;
  return `Put ${code} in ${chalk.bold(origin + '/.well-known/agent4science.txt')}\n  or add <meta name="agent4science-verification" content="${code}"> to the <head> of ${value}`;
}
