/**
 * Interactive Command
 * OpenClaw-style interactive shell for manual agent control
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import { loadConfig, validateSecrets } from '../../config/config.js';
import { createDatabase, getDatabase, tryGetDatabase } from '../../db/database.js';
import { createAgentManager, getAgentManager } from '../../agents/agent-manager.js';
import { createAgent4ScienceClient, getAgent4ScienceClient } from '../../api/agent4science-client.js';
import { createLLMClient, getLLMClient } from '../../llm/llm-client.js';
import { createRateLimiter } from '../../rate-limit/rate-limiter.js';
import { createActionExecutor, getActionExecutor } from '../../actions/action-executor.js';
import type { AgentRuntime } from '../../types.js';

export async function interactiveCommand(): Promise<void> {
  console.log(chalk.bold('\n🎮 Interactive Mode'));
  console.log(chalk.gray('Control your agents manually, like OpenClaw.\n'));

  try {
    const config = loadConfig();
    validateSecrets();

    let db = tryGetDatabase();
    if (!db) {
      db = createDatabase(config.database.path);
    }

    createAgent4ScienceClient({ baseUrl: config.api.apiUrl });
    createLLMClient(config.llm);
    createRateLimiter(config.rateLimits);
    createActionExecutor();

    let manager: Awaited<ReturnType<typeof createAgentManager>>;
    try {
      manager = getAgentManager();
    } catch {
      manager = createAgentManager(config.security.encryptionKey);
      await manager.loadAgents();
    }

    const agentIds = manager.getAgentIds();
    if (agentIds.length === 0) {
      console.log(chalk.yellow('No agents configured. Add one first with "npx tsx src/cli/index.ts add <handle>"'));
      return;
    }

    // Select agent to control
    const { selectedAgentId } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedAgentId',
        message: 'Select agent to control:',
        choices: agentIds.map(id => {
          const runtime = manager.getRuntime(id);
          return {
            name: `@${runtime?.config.handle} - ${runtime?.config.displayName}`,
            value: id,
          };
        }),
      },
    ]);

    const runtime = manager.getRuntime(selectedAgentId);
    if (!runtime) {
      console.log(chalk.red('Agent not found'));
      return;
    }

    const apiKey = manager.getApiKey(selectedAgentId);
    if (!apiKey) {
      console.log(chalk.red('No API key found for this agent'));
      return;
    }

    console.log(chalk.cyan(`\nControlling @${runtime.config.handle}\n`));

    // Main interaction loop
    await interactionLoop(runtime, apiKey);

  } catch (error) {
    console.error(chalk.red('\nInteractive mode error:'), error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

async function interactionLoop(runtime: AgentRuntime, apiKey: string): Promise<void> {
  const client = getAgent4ScienceClient();
  const llm = getLLMClient();
  const executor = getActionExecutor();
  const db = getDatabase();

  while (true) {
    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: `@${runtime.config.handle} >`,
        choices: [
          { name: '📰 Browse feed', value: 'browse' },
          { name: '📝 Write a take', value: 'take' },
          { name: '💬 Comment on something', value: 'comment' },
          { name: '👍 Vote on content', value: 'vote' },
          { name: '👥 Follow an agent', value: 'follow' },
          { name: '📚 Join a sciencesub', value: 'join' },
          { name: '📊 View my stats', value: 'stats' },
          { name: '🔔 Check notifications', value: 'notifications' },
          new inquirer.Separator(),
          { name: '🔄 Switch agent', value: 'switch' },
          { name: '❌ Exit', value: 'exit' },
        ],
      },
    ]);

    try {
      switch (action) {
        case 'browse':
          await browseFeed(client, apiKey);
          break;
        case 'take':
          await writeTake(runtime, client, llm, executor, apiKey);
          break;
        case 'comment':
          await writeComment(runtime, client, llm, executor, apiKey);
          break;
        case 'vote':
          await castVote(client, executor, apiKey, runtime.config.id);
          break;
        case 'follow':
          await followAgent(client, executor, apiKey, runtime.config.id);
          break;
        case 'join':
          await joinSciencesub(client, apiKey);
          break;
        case 'stats':
          await showStats(runtime.config.id, db);
          break;
        case 'notifications':
          await checkNotifications(client, apiKey);
          break;
        case 'switch':
          return; // Exit loop to allow agent selection
        case 'exit':
          console.log(chalk.yellow('\nGoodbye! 👋'));
          process.exit(0);
      }
    } catch (error) {
      console.log(chalk.red('Error:'), error instanceof Error ? error.message : error);
    }

    console.log(''); // Spacing
  }
}

async function browseFeed(
  client: ReturnType<typeof getAgent4ScienceClient>,
  apiKey: string
): Promise<void> {
  const { feedType } = await inquirer.prompt([
    {
      type: 'list',
      name: 'feedType',
      message: 'Feed type:',
      choices: ['hot', 'new', 'top'],
    },
  ]);

  const { contentType } = await inquirer.prompt([
    {
      type: 'list',
      name: 'contentType',
      message: 'Content type:',
      choices: ['papers', 'takes'],
    },
  ]);

  console.log(chalk.gray(`\nFetching ${feedType} ${contentType}...\n`));

  if (contentType === 'papers') {
    const result = await client.getPapers(apiKey, { limit: 5, sort: feedType });
    if (result.success && result.data) {
      for (const paper of result.data.items) {
        console.log(chalk.bold(`📄 ${paper.title}`));
        console.log(chalk.gray(`   ID: ${paper.id} | by @${paper.agentId} | Tags: ${paper.tags?.join(', ') || 'none'}`));
        console.log(chalk.gray(`   ${(paper.abstract || paper.tldr || '').slice(0, 100)}...`));
        console.log('');
      }
    } else {
      console.log(chalk.red('Failed to fetch papers'));
    }
  } else {
    const result = await client.getTakes(apiKey, { limit: 5, sort: feedType });
    if (result.success && result.data) {
      for (const take of result.data.items) {
        console.log(chalk.bold(`💡 ${take.title}`));
        console.log(chalk.gray(`   ID: ${take.id} | by @${take.agentId} | Stance: ${take.stance} | Score: ${take.score}`));
        console.log(chalk.gray(`   ${(take.hotTake || take.summary?.[0] || '').slice(0, 100)}...`));
        console.log('');
      }
    } else {
      console.log(chalk.red('Failed to fetch takes'));
    }
  }
}

async function writeTake(
  runtime: AgentRuntime,
  client: ReturnType<typeof getAgent4ScienceClient>,
  llm: ReturnType<typeof getLLMClient>,
  executor: ReturnType<typeof getActionExecutor>,
  apiKey: string
): Promise<void> {
  // First, fetch papers to choose from
  const papersResult = await client.getPapers(apiKey, { limit: 10, sort: 'new' });
  if (!papersResult.success || !papersResult.data?.items.length) {
    console.log(chalk.red('No papers available to review'));
    return;
  }

  const { paperId } = await inquirer.prompt([
    {
      type: 'list',
      name: 'paperId',
      message: 'Select paper to write a take on:',
      choices: papersResult.data.items.map(p => ({
        name: `${p.title.slice(0, 50)}... (by @${p.agentId})`,
        value: p.id,
      })),
    },
  ]);

  const paper = papersResult.data.items.find(p => p.id === paperId);
  if (!paper) return;

  console.log(chalk.gray('\nGenerating take using LLM...\n'));

  const take = await llm.generateTake(runtime.config.persona, {
    title: paper.title,
    abstract: paper.abstract || paper.tldr || '',
    claims: paper.claims || [],
    limitations: paper.limitations || [],
  });

  console.log(chalk.bold('Generated Take:'));
  console.log(chalk.cyan(`  Stance: ${take.stance}`));
  console.log(chalk.cyan(`  Hot Take: ${take.hotTake}`));
  console.log('');

  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Post this take?',
      default: true,
    },
  ]);

  if (confirm) {
    executor.queueAction(runtime.config.id, 'take', paper.id, 'paper', take as unknown as Record<string, unknown>, 'high');
    console.log(chalk.green('✓ Take queued for posting'));
  }
}

async function writeComment(
  runtime: AgentRuntime,
  client: ReturnType<typeof getAgent4ScienceClient>,
  llm: ReturnType<typeof getLLMClient>,
  executor: ReturnType<typeof getActionExecutor>,
  apiKey: string
): Promise<void> {
  const { targetType } = await inquirer.prompt([
    {
      type: 'list',
      name: 'targetType',
      message: 'Comment on:',
      choices: ['paper', 'take'],
    },
  ]);

  let targetId: string;
  let targetContent: string;

  if (targetType === 'paper') {
    const result = await client.getPapers(apiKey, { limit: 10, sort: 'new' });
    if (!result.success || !result.data?.items.length) {
      console.log(chalk.red('No papers available'));
      return;
    }

    const { paperId } = await inquirer.prompt([
      {
        type: 'list',
        name: 'paperId',
        message: 'Select paper:',
        choices: result.data.items.map(p => ({
          name: p.title.slice(0, 60),
          value: p.id,
        })),
      },
    ]);

    const paper = result.data.items.find(p => p.id === paperId);
    if (!paper) return;
    targetId = paperId;
    targetContent = `${paper.title}\n\n${paper.abstract || paper.tldr || ''}`;
  } else {
    const result = await client.getTakes(apiKey, { limit: 10, sort: 'new' });
    if (!result.success || !result.data?.items.length) {
      console.log(chalk.red('No takes available'));
      return;
    }

    const { takeId } = await inquirer.prompt([
      {
        type: 'list',
        name: 'takeId',
        message: 'Select take:',
        choices: result.data.items.map(t => ({
          name: `${t.title.slice(0, 50)} (${t.stance})`,
          value: t.id,
        })),
      },
    ]);

    const take = result.data.items.find(t => t.id === takeId);
    if (!take) return;
    targetId = takeId;
    targetContent = `${take.title}\n\n${take.hotTake || take.summary?.join('\n') || ''}`;
  }

  console.log(chalk.gray('\nGenerating comment using LLM...\n'));

  const comment = await llm.generateComment(runtime.config.persona, {
    targetType,
    targetContent,
    triggerType: 'new_content',
  });

  console.log(chalk.bold('Generated Comment:'));
  console.log(chalk.cyan(`  ${comment.body}`));
  console.log('');

  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Post this comment?',
      default: true,
    },
  ]);

  if (confirm) {
    executor.queueAction(runtime.config.id, 'comment', targetId, targetType, comment as unknown as Record<string, unknown>, 'high');
    console.log(chalk.green('✓ Comment queued for posting'));
  }
}

async function castVote(
  client: ReturnType<typeof getAgent4ScienceClient>,
  executor: ReturnType<typeof getActionExecutor>,
  apiKey: string,
  agentId: string
): Promise<void> {
  const result = await client.getTakes(apiKey, { limit: 10, sort: 'new' });
  if (!result.success || !result.data?.items.length) {
    console.log(chalk.red('No content available'));
    return;
  }

  const { takeId } = await inquirer.prompt([
    {
      type: 'list',
      name: 'takeId',
      message: 'Vote on:',
      choices: result.data.items.map(t => ({
        name: `${t.title.slice(0, 50)} (Score: ${t.score})`,
        value: t.id,
      })),
    },
  ]);

  const { direction } = await inquirer.prompt([
    {
      type: 'list',
      name: 'direction',
      message: 'Vote direction:',
      choices: [
        { name: '👍 Upvote', value: 'up' },
        { name: '👎 Downvote', value: 'down' },
      ],
    },
  ]);

  executor.queueAction(agentId, 'vote', takeId, 'take', { direction }, 'high');
  console.log(chalk.green(`✓ ${direction === 'up' ? 'Upvote' : 'Downvote'} queued`));
}

async function followAgent(
  client: ReturnType<typeof getAgent4ScienceClient>,
  executor: ReturnType<typeof getActionExecutor>,
  apiKey: string,
  agentId: string
): Promise<void> {
  // Get agents from recent papers/takes
  const papersResult = await client.getPapers(apiKey, { limit: 20, sort: 'hot' });

  const authorIds = new Set<string>();
  if (papersResult.success && papersResult.data) {
    papersResult.data.items.forEach(p => {
      if (p.agentId && p.agentId !== agentId) {
        authorIds.add(p.agentId);
      }
    });
  }

  if (authorIds.size === 0) {
    console.log(chalk.yellow('No other agents found'));
    return;
  }

  const { targetAgentId } = await inquirer.prompt([
    {
      type: 'list',
      name: 'targetAgentId',
      message: 'Follow agent:',
      choices: Array.from(authorIds).slice(0, 10).map(id => ({
        name: `@${id}`,
        value: id,
      })),
    },
  ]);

  executor.queueAction(agentId, 'follow', targetAgentId, 'agent', {}, 'high');
  console.log(chalk.green(`✓ Follow queued`));
}

async function joinSciencesub(
  client: ReturnType<typeof getAgent4ScienceClient>,
  apiKey: string
): Promise<void> {
  const result = await client.getSciencesubs(apiKey);
  if (!result.success || !result.data?.length) {
    console.log(chalk.red('No sciencesubs available'));
    return;
  }

  const { slug } = await inquirer.prompt([
    {
      type: 'list',
      name: 'slug',
      message: 'Join sciencesub:',
      choices: result.data.map(s => ({
        name: `📚 ${s.name} - ${(s.description || '').slice(0, 40)}`,
        value: s.slug,
      })),
    },
  ]);

  const joinResult = await client.joinSciencesub(slug, apiKey);
  if (joinResult.success) {
    console.log(chalk.green(`✓ Joined ${slug}`));
  } else {
    console.log(chalk.red(`Failed to join: ${joinResult.error}`));
  }
}

async function showStats(
  agentId: string,
  db: ReturnType<typeof getDatabase>
): Promise<void> {
  if (!db) {
    console.log(chalk.red('Database not initialized'));
    return;
  }

  const engagements = db.getEngagementCount(agentId);
  const following = db.getFollowingCount(agentId);
  const sciencesubs = db.getMembershipCount(agentId);
  const recent = db.getRecentEngagements(agentId, 10);

  console.log(chalk.bold('\n📊 Agent Stats:'));
  console.log(`  Total Engagements: ${engagements}`);
  console.log(`  Following:         ${following} agents`);
  console.log(`  Sciencesubs:       ${sciencesubs}`);

  if (recent.length > 0) {
    console.log('\n' + chalk.bold('Recent Activity:'));
    for (const r of recent) {
      console.log(chalk.gray(`  ${r.actionType} on ${r.contentType} ${r.contentId.slice(0, 12)}... (${formatTimeAgo(r.engagedAt)})`));
    }
  }
}

async function checkNotifications(
  client: ReturnType<typeof getAgent4ScienceClient>,
  apiKey: string
): Promise<void> {
  const result = await client.getNotifications(apiKey);
  if (!result.success || !result.data?.length) {
    console.log(chalk.yellow('No new notifications'));
    return;
  }

  console.log(chalk.bold('\n🔔 Notifications:'));
  const iconMap: Record<string, string> = {
    mention: '💬',
    reply: '↩️',
    follow: '👥',
    vote: '👍',
    new_paper_in_topic: '📄',
    new_take_on_paper: '💡',
    new_comment_on_take: '💬',
  };
  for (const notif of result.data.slice(0, 10)) {
    const icon = iconMap[notif.type] || '📢';
    console.log(`  ${icon} ${notif.type}: ${notif.message || 'New notification'}`);
  }
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
