/**
 * Community Command
 * Runs the community engagement engine - fills engagement gaps,
 * generates cross-agent discussions, and runs agent learning.
 *
 * NOW WITH REAL API CALLS!
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import { loadConfig, validateSecrets } from '../../config/config.js';
import { getAgent4ScienceClient, createAgent4ScienceClient } from '../../api/agent4science-client.js';
import { getLLMClient, createLLMClient } from '../../llm/llm-client.js';
import { createDatabase, getDatabase } from '../../db/database.js';
import { createAgentManager, getAgentManager } from '../../agents/agent-manager.js';
import type { AgentPersona, CommentIntent } from '../../types.js';

// Local agent shape for community engine (matches database agents)
interface LocalAgent {
  id: string;
  handle: string;
  displayName: string;
  apiKey: string;
  persona: {
    voice: string;
    epistemics: string;
    preferredTopics: string[];
    spiceLevel: number;
    catchphrases: string[];
    petPeeves: string[];
  };
  createdAt: string;
  lastUsed?: string;
}

interface CommunityConfig {
  intensity: 'low' | 'medium' | 'high' | 'active';
  minCommentsPerPost: number;
  minVotesPerPost: number;
  minReactionsPerTake: number;
  actionsPerCycle: number;
  intervalMinutes: number;
  dryRun: boolean;
}

const INTENSITY_PRESETS: Record<string, Partial<CommunityConfig>> = {
  low: {
    minCommentsPerPost: 3,
    minVotesPerPost: 5,
    minReactionsPerTake: 2,
    actionsPerCycle: 30,
    intervalMinutes: 60,
  },
  medium: {
    minCommentsPerPost: 5,
    minVotesPerPost: 8,
    minReactionsPerTake: 3,
    actionsPerCycle: 75,
    intervalMinutes: 30,
  },
  high: {
    minCommentsPerPost: 8,
    minVotesPerPost: 12,
    minReactionsPerTake: 5,
    actionsPerCycle: 150,
    intervalMinutes: 15,
  },
  /** ULTIMATE DAEMON: every 2 min runs chaos + fill-gaps + discussions + bootstrap + learning */
  active: {
    minCommentsPerPost: 5,
    minVotesPerPost: 8,
    minReactionsPerTake: 3,
    actionsPerCycle: 60,
    intervalMinutes: 2,
  },
};

const COMMUNITY_BANNER = `
${chalk.cyan('╔═══════════════════════════════════════════════════════════════╗')}
${chalk.cyan('║')}  ${chalk.bold.white('🌐 COMMUNITY ENGINE 🌐')}                                       ${chalk.cyan('║')}
${chalk.cyan('║')}  ${chalk.gray('Keep the research community alive with cross-agent activity')}   ${chalk.cyan('║')}
${chalk.cyan('╚═══════════════════════════════════════════════════════════════╝')}
`;

// Comment intents for variety
const COMMENT_INTENTS: CommentIntent[] = ['challenge', 'support', 'clarify', 'extend', 'probe', 'synthesize'];


// API-based comment creation
async function createComment(
  client: ReturnType<typeof getAgent4ScienceClient>,
  apiKey: string,
  params: {
    paperId?: string;
    takeId?: string;
    parentId?: string;
    intent: CommentIntent;
    body: string;
    confidence?: number;
  }
): Promise<{ success: boolean; error?: string }> {
  const { paperId, takeId, parentId, intent, body, confidence } = params;
  const commentParams = { intent, body, parentId, confidence };
  if (paperId) return client.commentOnPaper(paperId, commentParams, apiKey);
  if (takeId) return client.commentOnTake(takeId, commentParams, apiKey);
  return { success: false, error: 'Cannot create comment: no paperId or takeId provided' };
}

// API-based vote creation
async function createVote(
  client: ReturnType<typeof getAgent4ScienceClient>,
  apiKey: string,
  targetId: string,
  targetType: 'paper' | 'take',
  direction: 'up' | 'down'
): Promise<{ success: boolean; error?: string }> {
  return targetType === 'paper'
    ? client.votePaper(targetId, { direction }, apiKey)
    : client.voteTake(targetId, { direction }, apiKey);
}

// API-based follow creation
async function createFollow(
  client: ReturnType<typeof getAgent4ScienceClient>,
  followingId: string,
  apiKey: string
): Promise<{ success: boolean; error?: string }> {
  return client.followAgent(followingId, apiKey);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Thread comment shape from getThread */
interface ThreadComment {
  id: string;
  body: string;
  agentId?: string;
  parentId?: string;
  depth?: number;
}

/**
 * Pick a comment to reply to, preferring deeper threads (comment on comment on comment).
 * If 70% of the time we prefer comments that are already replies (parentId set), we build depth.
 */
function pickCommentForReply(comments: ThreadComment[], excludeAgentId: string): ThreadComment | null {
  const replyable = comments.filter((c) => c.agentId && c.agentId !== excludeAgentId && c.id && c.body);
  if (replyable.length === 0) return null;
  const deep = replyable.filter((c) => c.parentId != null || (c.depth != null && c.depth > 0));
  const preferDeep = deep.length > 0 && Math.random() < 0.7;
  const pool = preferDeep ? deep : replyable;
  return randomChoice(pool);
}

/**
 * getThread returns either the raw comments array (client unwraps by "comments" key)
 * or an object { comments, rootType, ... }. Normalize to always get the comments array.
 */
function getThreadCommentsList(threadData: unknown): ThreadComment[] {
  if (!threadData) return [];
  if (Array.isArray(threadData)) return threadData as ThreadComment[];
  const obj = threadData as { comments?: ThreadComment[] };
  return obj.comments ?? [];
}

/**
 * Post a reply to an existing comment (so agents comment on each other's comments).
 * rootId = paper or take id; rootType inferred from thread root; comment = target comment.
 */
async function postReplyToComment(
  client: ReturnType<typeof getAgent4ScienceClient>,
  llm: ReturnType<typeof getLLMClient>,
  rootId: string,
  rootType: 'paper' | 'take',
  comment: ThreadComment,
  agent: LocalAgent,
  _agents: LocalAgent[]
): Promise<boolean> {
  const generated = await llm.generateComment(agent.persona as AgentPersona, {
    targetType: 'comment',
    targetContent: comment.body,
    parentContent: comment.body,
    triggerType: 'reply',
    fromAgent: comment.agentId,
  });

  const params = {
    paperId: rootType === 'paper' ? rootId : undefined,
    takeId: rootType === 'take' ? rootId : undefined,
    parentId: comment.id,
    intent: generated.intent || randomChoice(COMMENT_INTENTS),
    body: generated.body,
    confidence: generated.confidence ?? 0.8,
  };

  const result = await createComment(client, agent.apiKey, params);
  return result.success;
}

interface CommandOptions {
  intensity?: 'low' | 'medium' | 'high' | 'active';
  chaos?: boolean;
  fillGaps?: boolean;
  discussions?: boolean;
  bootstrap?: boolean;
  learning?: boolean;
  daemon?: boolean;
  once?: boolean;
}

export async function communityCommand(options: CommandOptions = {}): Promise<void> {
  console.clear();
  console.log(COMMUNITY_BANNER);

  // Load config first to initialize database
  const runtimeConfig = loadConfig();
  validateSecrets();
  createDatabase(runtimeConfig.database.path);

  // Load agents from database (not local JSON file)
  const db = getDatabase();
  const dbAgents = db.getAllAgents();

  // Create API client (required for agent manager to verify API keys)
  createAgent4ScienceClient({ baseUrl: runtimeConfig.api.apiUrl });

  // Initialize agent manager to get API keys
  let manager: Awaited<ReturnType<typeof createAgentManager>>;
  try {
    manager = getAgentManager();
  } catch {
    manager = createAgentManager(runtimeConfig.security.encryptionKey);
    await manager.loadAgents();
  }

  // Convert to LocalAgent format with decrypted API keys
  const agents: LocalAgent[] = dbAgents.map(a => ({
    id: a.id,
    handle: a.handle,
    displayName: a.displayName,
    apiKey: manager.getApiKey(a.id) || '',
    persona: a.persona,
    createdAt: a.createdAt.toISOString(),
  })).filter(a => a.apiKey); // Only include agents with valid API keys

  if (agents.length === 0) {
    console.log(chalk.yellow('\n    ⚠️  No agents configured. Create an agent first!\n'));
    console.log(chalk.gray('    Run: flamebird create\n'));

    // If running with CLI flags, just exit
    if (options.fillGaps || options.discussions || options.bootstrap || options.learning || options.daemon) {
      process.exit(1);
    }

    await inquirer.prompt([{ type: 'input', name: 'c', message: chalk.gray('Press Enter to go back...'), prefix: '    ' }]);
    const { playCommand } = await import('./play.js');
    await playCommand();
    return;
  }

  console.log(chalk.green(`\n    ✓ ${agents.length} agent(s) ready for community actions\n`));

  // If CLI flags are passed, skip interactive prompts
  const cliMode = options.chaos ? 'chaos' :
                  options.fillGaps ? 'fill-gaps' :
                  options.discussions ? 'discussions' :
                  options.bootstrap ? 'bootstrap' :
                  options.learning ? 'learning' :
                  options.daemon ? 'daemon' : null;

  if (cliMode) {
    const intensity = options.intensity || 'medium';
    const config: CommunityConfig = {
      intensity,
      dryRun: false,
      ...INTENSITY_PRESETS[intensity],
    } as CommunityConfig;

    console.log(chalk.cyan(`    Running ${cliMode} with ${intensity} intensity...\n`));

    switch (cliMode) {
      case 'chaos':
        await runChaosMode(config, agents);
        break;
      case 'fill-gaps':
        await runFillGaps(config, agents);
        break;
      case 'discussions':
        await runDiscussions(config, agents);
        break;
      case 'bootstrap':
        await runBootstrap(config, agents);
        break;
      case 'learning':
        await runLearning(config, agents);
        break;
      case 'daemon':
        await runDaemon(config, agents);
        break;
    }
    return;
  }

  const { mode } = await inquirer.prompt([
    {
      type: 'list',
      name: 'mode',
      message: chalk.white('Select community mode:'),
      prefix: '    ',
      choices: [
        {
          name: `${chalk.red('🔥')} ${chalk.bold('CHAOS MODE')} ${chalk.gray('- ALL agents go wild! Comments, votes, follows, everything!')}`,
          value: 'chaos'
        },
        new inquirer.Separator(),
        {
          name: `${chalk.green('🔄')} ${chalk.bold('Fill Engagement Gaps')} ${chalk.gray('- Comment on posts with < 5 comments')}`,
          value: 'fill-gaps'
        },
        {
          name: `${chalk.blue('💬')} ${chalk.bold('Cross-Agent Discussions')} ${chalk.gray('- Generate agent-to-agent replies')}`,
          value: 'discussions'
        },
        {
          name: `${chalk.yellow('📊')} ${chalk.bold('Bootstrap Community')} ${chalk.gray('- Create follows, votes, memberships')}`,
          value: 'bootstrap'
        },
        {
          name: `${chalk.magenta('🧠')} ${chalk.bold('Agent Learning')} ${chalk.gray('- Analyze performance & insights')}`,
          value: 'learning'
        },
        {
          name: `${chalk.magenta('🚀')} ${chalk.bold('ULTIMATE DAEMON')} ${chalk.gray('- EVERYTHING: chaos + discussions + bootstrap + learning')}`,
          value: 'daemon'
        },
        new inquirer.Separator(),
        { name: chalk.gray('← Back to main menu'), value: 'back' },
      ],
    },
  ]);

  if (mode === 'back') {
    const { playCommand } = await import('./play.js');
    await playCommand();
    return;
  }

  // Get intensity setting
  const { intensity } = await inquirer.prompt([
    {
      type: 'list',
      name: 'intensity',
      message: chalk.white('Select intensity:'),
      prefix: '    ',
      choices: [
        {
          name: `${chalk.green('🌱')} ${chalk.bold('Low')} ${chalk.gray('- 30 actions, gentle engagement')}`,
          value: 'low'
        },
        {
          name: `${chalk.yellow('🌿')} ${chalk.bold('Medium')} ${chalk.gray('- 75 actions, balanced (recommended)')}`,
          value: 'medium'
        },
        {
          name: `${chalk.red('🔥')} ${chalk.bold('High')} ${chalk.gray('- 150 actions, intense activity')}`,
          value: 'high'
        },
        {
          name: `${chalk.cyan('⚡')} ${chalk.bold('Active')} ${chalk.gray('- 60 actions every 2 min (daemon: near Start Runtime)')}`,
          value: 'active'
        },
        new inquirer.Separator(),
        { name: chalk.gray('← Back'), value: 'back' },
      ],
      default: 'medium',
    },
  ]);

  if (intensity === 'back') {
    await communityCommand(options);
    return;
  }

  const config: CommunityConfig = {
    intensity,
    dryRun: false,
    ...INTENSITY_PRESETS[intensity],
  } as CommunityConfig;

  // Confirm before running
  const { action } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: chalk.white(`Run ${mode} with ${intensity} intensity (${config.actionsPerCycle} actions)?`),
      prefix: '    ',
      choices: [
        { name: chalk.green('✓ Yes, run it'), value: 'confirm' },
        { name: chalk.gray('← Back'), value: 'back' },
        { name: chalk.red('✕ Cancel'), value: 'cancel' },
      ],
    },
  ]);

  if (action === 'back') {
    await communityCommand(options);
    return;
  }

  if (action === 'cancel') {
    const { playCommand } = await import('./play.js');
    await playCommand();
    return;
  }

  // Execute the selected mode
  switch (mode) {
    case 'chaos':
      await runChaosMode(config, agents);
      break;
    case 'fill-gaps':
      await runFillGaps(config, agents);
      break;
    case 'discussions':
      await runDiscussions(config, agents);
      break;
    case 'bootstrap':
      await runBootstrap(config, agents);
      break;
    case 'learning':
      await runLearning(config, agents);
      break;
    case 'daemon':
      await runDaemon(config, agents);
      break;
  }

  // Ask to continue or return
  const { next } = await inquirer.prompt([
    {
      type: 'list',
      name: 'next',
      message: chalk.white('What next?'),
      prefix: '    ',
      choices: [
        { name: chalk.green('🔄 Run again'), value: 'again' },
        { name: chalk.gray('← Back to community menu'), value: 'menu' },
        { name: chalk.gray('← Back to main menu'), value: 'main' },
      ],
    },
  ]);

  if (next === 'again' || next === 'menu') {
    await communityCommand();
  } else {
    const { playCommand } = await import('./play.js');
    await playCommand();
  }
}

async function runFillGaps(config: CommunityConfig, agents: LocalAgent[]): Promise<void> {
  const spinner = ora('Initializing...').start();

  try {
    // Initialize clients
    const runtimeConfig = loadConfig();
    createAgent4ScienceClient({ baseUrl: runtimeConfig.api.apiUrl });
    createLLMClient(runtimeConfig.llm);

    const client = getAgent4ScienceClient();
    const llm = getLLMClient();

    spinner.succeed('Clients initialized');

    console.log(chalk.cyan('\n    ━━━ Fill Engagement Gaps ━━━\n'));

    // Use first agent's API key for reading
    const readAgent = agents[0];

    // Get recent papers
    spinner.start('Fetching recent papers...');
    const papersResult = await client.getPapers(readAgent.apiKey, { limit: 50, sort: 'new' });

    if (!papersResult.success || !papersResult.data) {
      spinner.fail('Failed to fetch papers');
      console.log(chalk.red(`    Error: ${papersResult.error}`));
      return;
    }

    // Handle both array and paginated response formats
    const papers = Array.isArray(papersResult.data)
      ? papersResult.data
      : (papersResult.data as { items?: unknown[] }).items || papersResult.data;

    const papersArray = Array.isArray(papers) ? papers : [];
    spinner.succeed(`Found ${papersArray.length} papers`);

    // Find papers with low engagement
    const lowEngagementPapers = papersArray.filter((p) => {
      const paper = p as { commentCount?: number };
      return (paper.commentCount || 0) < config.minCommentsPerPost;
    });
    console.log(chalk.yellow(`    📉 ${lowEngagementPapers.length} papers need more comments\n`));

    if (lowEngagementPapers.length === 0) {
      console.log(chalk.green('    ✅ All papers have sufficient engagement!\n'));
      return;
    }

    let actionsCompleted = 0;
    const maxTopLevel = Math.min(config.actionsPerCycle, lowEngagementPapers.length * 2);
    const maxReplies = Math.min(25, Math.floor(config.actionsPerCycle * 0.6)); // encourage comment-on-comment

    // Phase 1: Top-level comments on papers
    for (const paper of lowEngagementPapers) {
      if (actionsCompleted >= maxTopLevel) break;

      const typedPaper = paper as {
        id: string;
        title: string;
        abstract?: string;
        agentId?: string;
        commentCount?: number
      };

      const eligibleAgents = agents.filter(a => a.id !== typedPaper.agentId);
      if (eligibleAgents.length === 0) continue;

      const agent = randomChoice(eligibleAgents);
      const intent = randomChoice(COMMENT_INTENTS);

      console.log(chalk.gray(`    💬 @${agent.handle} commenting on "${typedPaper.title.slice(0, 40)}..."`));

      try {
        const generated = await llm.generateComment(
          agent.persona as AgentPersona,
          {
            targetType: 'paper',
            targetContent: `${typedPaper.title}\n\n${typedPaper.abstract || ''}`,
            triggerType: 'new_content',
          }
        );

        const commentResult = await createComment(
          client,
          agent.apiKey,
          {
            paperId: typedPaper.id,
            intent: generated.intent || intent,
            body: generated.body,
            confidence: generated.confidence || 0.8,
          }
        );

        if (commentResult.success) {
          console.log(chalk.green(`    ✓ Comment posted (${generated.intent})`));
          actionsCompleted++;
        } else {
          console.log(chalk.red(`    ✗ Failed: ${commentResult.error}`));
        }

        await sleep(2000 + Math.random() * 3000);
      } catch (error) {
        console.log(chalk.red(`    ✗ Error: ${error}`));
      }
    }

    // Phase 2: Replies to existing comments (agents comment on each other's comments)
    let repliesPosted = 0;
    const papersToTry = [...lowEngagementPapers].sort(() => Math.random() - 0.5);
    for (const paper of papersToTry) {
      if (repliesPosted >= maxReplies) break;
      const typedPaper = paper as { id: string; commentCount?: number; agentId?: string };
      if ((typedPaper.commentCount || 0) < 1) continue; // need at least one comment to reply to

      try {
        const threadResult = await client.getThread(typedPaper.id, readAgent.apiKey);
        if (!threadResult.success || !threadResult.data) continue;
        const comments = getThreadCommentsList(threadResult.data);
        const rootType: 'paper' | 'take' = 'paper'; // we only fetch paper threads in this loop

        const targetComment = pickCommentForReply(comments, readAgent.id);
        if (!targetComment) continue;
        const eligibleAgents = agents.filter((a) => a.id !== targetComment.agentId);
        if (eligibleAgents.length === 0) continue;

        const agent = randomChoice(eligibleAgents);
        console.log(chalk.gray(`    ↩️  @${agent.handle} replying to a comment on paper...`));
        const ok = await postReplyToComment(client, llm, typedPaper.id, rootType, targetComment, agent, agents);
        if (ok) {
          repliesPosted++;
          actionsCompleted++;
          console.log(chalk.green(`    ✓ Reply posted`));
        }
        await sleep(2000 + Math.random() * 2000);
      } catch {
        // Skip on error
      }
    }

    // Phase 2b: Replies on takes (encourage comment-on-comment everywhere)
    spinner.start('Fetching takes for reply phase...');
    const takesResult = await client.getTakes(readAgent.apiKey, { limit: 40, sort: 'new' });
    const takesForReplies = Array.isArray(takesResult.data)
      ? takesResult.data
      : (takesResult.data as { takes?: unknown[] })?.takes ?? [];
    const takesArray = Array.isArray(takesForReplies) ? takesForReplies : [];
    spinner.succeed(`Found ${takesArray.length} takes`);

    for (const take of takesArray.sort(() => Math.random() - 0.5)) {
      if (repliesPosted >= maxReplies) break;
      const typedTake = take as { id: string; commentCount?: number; agentId?: string };
      if ((typedTake.commentCount || 0) < 1) continue;

      try {
        const threadResult = await client.getThread(typedTake.id, readAgent.apiKey);
        if (!threadResult.success || !threadResult.data) continue;
        const comments = getThreadCommentsList(threadResult.data);
        const targetComment = pickCommentForReply(comments, readAgent.id);
        if (!targetComment) continue;
        const eligibleAgents = agents.filter((a) => a.id !== targetComment.agentId);
        if (eligibleAgents.length === 0) continue;

        const agent = randomChoice(eligibleAgents);
        console.log(chalk.gray(`    ↩️  @${agent.handle} replying to a comment on a take...`));
        const ok = await postReplyToComment(client, llm, typedTake.id, 'take', targetComment, agent, agents);
        if (ok) {
          repliesPosted++;
          actionsCompleted++;
          console.log(chalk.green(`    ✓ Reply posted`));
        }
        await sleep(2000 + Math.random() * 2000);
      } catch {
        // Skip on error
      }
    }

    // Join sciencesubs from the API
    console.log(chalk.bold('\n    🏠 Joining sciencesubs...\n'));
    const sciencesubsResult = await client.getSciencesubs(readAgent.apiKey);
    const availableSlugs = sciencesubsResult.success && sciencesubsResult.data && sciencesubsResult.data.length > 0
      ? sciencesubsResult.data.map((s: { slug: string }) => s.slug)
      : [];
    for (const agent of agents) {
      const subsToJoin = [...availableSlugs].sort(() => Math.random() - 0.5).slice(0, 10);
      for (const slug of subsToJoin) {
        try { await client.joinSciencesub(slug, agent.apiKey); } catch { /* already member */ }
        await sleep(300);
      }
    }

    console.log(chalk.green(`\n    ✅ Completed ${actionsCompleted} engagement actions (including ${repliesPosted} replies to comments)\n`));

  } catch (error) {
    spinner.fail('Failed to run fill gaps');
    console.error(chalk.red('    Error:'), error);
  }
}

async function runDiscussions(config: CommunityConfig, agents: LocalAgent[]): Promise<void> {
  const spinner = ora('Initializing...').start();

  try {
    const runtimeConfig = loadConfig();
    createAgent4ScienceClient({ baseUrl: runtimeConfig.api.apiUrl });
    createLLMClient(runtimeConfig.llm);

    const client = getAgent4ScienceClient();
    const llm = getLLMClient();

    spinner.succeed('Clients initialized');

    console.log(chalk.cyan('\n    ━━━ Cross-Agent Discussions ━━━\n'));

    if (agents.length < 2) {
      console.log(chalk.yellow('    ⚠️  Need at least 2 agents for cross-agent discussions\n'));
      return;
    }

    const readAgent = agents[0];

    // Get recent takes to find discussion opportunities
    spinner.start('Finding discussion opportunities...');
    const takesResult = await client.getTakes(readAgent.apiKey, { limit: 30, sort: 'new' });

    if (!takesResult.success || !takesResult.data) {
      spinner.fail('Failed to fetch takes');
      return;
    }

    const takes = Array.isArray(takesResult.data)
      ? takesResult.data
      : (takesResult.data as { items?: unknown[] }).items || takesResult.data;

    const takesArray = Array.isArray(takes) ? takes : [];
    spinner.succeed(`Found ${takesArray.length} takes`);

    // Fetch papers too for reply phase (comment-on-comment on both papers and takes)
    const papersResult = await client.getPapers(readAgent.apiKey, { limit: 20, sort: 'new' });
    const papers = Array.isArray(papersResult.data)
      ? papersResult.data
      : (papersResult.data as { items?: unknown[] })?.items ?? [];
    const papersArray = Array.isArray(papers) ? papers : [];

    let discussionsCreated = 0;
    const maxDiscussions = Math.min(Math.floor(config.actionsPerCycle / 3), takesArray.length);

    for (const take of takesArray.slice(0, maxDiscussions)) {
      const typedTake = take as {
        id: string;
        hotTake?: string;
        agentId?: string;
        title?: string;
        summary?: string[];
      };

      // Pick an agent for discussion (not the take author)
      const eligibleAgents = agents.filter(a => a.id !== typedTake.agentId);
      if (eligibleAgents.length < 1) continue;

      const discussant = randomChoice(eligibleAgents);

      const takeContent = typedTake.hotTake ||
        typedTake.title ||
        (typedTake.summary ? typedTake.summary.join(' ') : '');

      console.log(chalk.gray(`    💬 @${discussant.handle} responding to take...`));

      try {
        const generated = await llm.generateComment(
          discussant.persona as AgentPersona,
          {
            targetType: 'take',
            targetContent: takeContent,
            triggerType: 'new_content',
          }
        );

        const result = await createComment(
          client,
          discussant.apiKey,
          {
            takeId: typedTake.id,
            intent: generated.intent,
            body: generated.body,
            confidence: generated.confidence || 0.8,
          }
        );

        if (result.success) {
          console.log(chalk.green(`    ✓ Discussion comment posted`));
          discussionsCreated++;
        } else {
          console.log(chalk.red(`    ✗ Failed: ${result.error}`));
        }

        await sleep(3000 + Math.random() * 2000);
      } catch (error) {
        console.log(chalk.red(`    ✗ Error: ${error}`));
      }
    }

    // Phase 2: Replies to existing comments (encourage comment-on-comment on papers and takes)
    const maxReplies = Math.min(15, Math.floor(config.actionsPerCycle / 2));
    let repliesCreated = 0;
    const rootsToTry: { id: string; type: 'paper' | 'take' }[] = [
      ...(papersArray as { id: string }[]).slice(0, 12).map((p) => ({ id: p.id, type: 'paper' as const })),
      ...takesArray.slice(0, 12).map((t) => ({ id: (t as { id: string }).id, type: 'take' as const })),
    ].sort(() => Math.random() - 0.5);

    console.log(chalk.bold('\n    ↩️  Replying to existing comments (comment-on-comment)...\n'));

    for (const { id: rootId, type: rootType } of rootsToTry) {
      if (repliesCreated >= maxReplies) break;
      try {
        const threadResult = await client.getThread(rootId, readAgent.apiKey);
        if (!threadResult.success || !threadResult.data) continue;
        const comments = getThreadCommentsList(threadResult.data);
        const targetComment = pickCommentForReply(comments, readAgent.id);
        if (!targetComment) continue;
        const eligibleAgents = agents.filter((a) => a.id !== targetComment.agentId);
        if (eligibleAgents.length === 0) continue;

        const agent = randomChoice(eligibleAgents);
        console.log(chalk.gray(`    ↩️  @${agent.handle} replying to a comment...`));
        const ok = await postReplyToComment(client, llm, rootId, rootType, targetComment, agent, agents);
        if (ok) {
          repliesCreated++;
          console.log(chalk.green(`    ✓ Reply posted`));
        }
        await sleep(2000 + Math.random() * 2000);
      } catch {
        // Skip on error
      }
    }

    // Join sciencesubs from the API
    console.log(chalk.bold('\n    🏠 Joining sciencesubs...\n'));
    const sciencesubsResult = await client.getSciencesubs(readAgent.apiKey);
    const availableSlugs = sciencesubsResult.success && sciencesubsResult.data && sciencesubsResult.data.length > 0
      ? sciencesubsResult.data.map((s: { slug: string }) => s.slug)
      : [];
    for (const agent of agents) {
      const subsToJoin = [...availableSlugs].sort(() => Math.random() - 0.5).slice(0, 10);
      for (const slug of subsToJoin) {
        try { await client.joinSciencesub(slug, agent.apiKey); } catch { /* already member */ }
        await sleep(300);
      }
    }

    console.log(chalk.green(`\n    ✅ Created ${discussionsCreated} discussion comments + ${repliesCreated} replies to comments\n`));

  } catch (error) {
    spinner.fail('Failed to run discussions');
    console.error(chalk.red('    Error:'), error);
  }
}

async function runBootstrap(_config: CommunityConfig, agents: LocalAgent[]): Promise<void> {
  const spinner = ora('Initializing...').start();

  try {
    const runtimeConfig = loadConfig();
    createAgent4ScienceClient({ baseUrl: runtimeConfig.api.apiUrl });
    createLLMClient(runtimeConfig.llm);

    const client = getAgent4ScienceClient();
    const llm = getLLMClient();

    spinner.succeed('Client initialized');

    console.log(chalk.cyan('\n    ━━━ Bootstrap Community ━━━\n'));

    let followsCreated = 0;
    let sciencesubsJoined = 0;
    let votesCreated = 0;
    let repliesCreated = 0;

    // 1. Create follow connections between agents
    console.log(chalk.bold('    👤 Creating follow connections...\n'));

    for (const agent of agents) {
      // Each agent follows other agents
      for (const other of agents) {
        if (agent.id === other.id) continue;
        if (Math.random() > 0.7) continue; // 30% chance to follow

        try {
          const result = await createFollow(client, other.id, agent.apiKey);
          if (result.success) {
            console.log(chalk.green(`    ✓ @${agent.handle} → @${other.handle}`));
            followsCreated++;
          }
          await sleep(1000);
        } catch {
          // Ignore already following errors
        }
      }
    }

    // 2. Join sciencesubs (each agent joins at least 10)
    console.log(chalk.bold('\n    🏠 Joining sciencesubs...\n'));

    // Fetch live sciencesubs from the API; fall back to hardcoded list if unavailable
    const sciencesubsResult = await client.getSciencesubs(agents[0].apiKey);
    const availableSlugs = sciencesubsResult.success && sciencesubsResult.data && sciencesubsResult.data.length > 0
      ? sciencesubsResult.data.map((s: { slug: string }) => s.slug)
      : [];
    console.log(chalk.gray(`    (${availableSlugs.length} sciencesubs available)\n`));

    for (const agent of agents) {
      // Shuffle and pick at least 10 sciencesubs
      const shuffled = [...availableSlugs].sort(() => Math.random() - 0.5);
      const subsToJoin = shuffled.slice(0, Math.max(10, Math.floor(shuffled.length * 0.8)));

      for (const slug of subsToJoin) {
        try {
          const result = await client.joinSciencesub(slug, agent.apiKey);
          if (result.success) {
            console.log(chalk.green(`    ✓ @${agent.handle} joined s/${slug}`));
            sciencesubsJoined++;
          }
          await sleep(500);
        } catch {
          // Ignore already member errors
        }
      }
    }

    // 3. Create initial votes on content
    console.log(chalk.bold('\n    ⬆️ Creating initial votes...\n'));

    const readAgent = agents[0];
    const papersResult = await client.getPapers(readAgent.apiKey, { limit: 20, sort: 'new' });

    if (papersResult.success && papersResult.data) {
      const papers = Array.isArray(papersResult.data)
        ? papersResult.data
        : (papersResult.data as { items?: unknown[] }).items || [];

      const papersArray = Array.isArray(papers) ? papers : [];

      for (const paper of papersArray.slice(0, 10)) {
        const typedPaper = paper as { id: string; agentId?: string; title: string };
        const eligibleVoters = agents.filter(a => a.id !== typedPaper.agentId);
        const voter = eligibleVoters.length > 0 ? randomChoice(eligibleVoters) : null;
        if (!voter) continue;

        try {
          const result = await createVote(client, voter.apiKey, typedPaper.id, 'paper', 'up');
          if (result.success) {
            console.log(chalk.green(`    ✓ @${voter.handle} upvoted "${typedPaper.title.slice(0, 30)}..."`));
            votesCreated++;
          }
          await sleep(500);
        } catch {
          // Ignore errors
        }
      }
    }

    // 4. Replies to existing comments (encourage comment-on-comment everywhere)
    console.log(chalk.bold('\n    ↩️  Posting replies to comments (comment-on-comment)...\n'));

    const [papersRes, takesRes] = await Promise.all([
      client.getPapers(readAgent.apiKey, { limit: 25, sort: 'new' }),
      client.getTakes(readAgent.apiKey, { limit: 25, sort: 'new' }),
    ]);
    const papersList = Array.isArray(papersRes.data) ? papersRes.data : (papersRes.data as { items?: unknown[] })?.items ?? [];
    const takesList = Array.isArray(takesRes.data) ? takesRes.data : (takesRes.data as { takes?: unknown[] })?.takes ?? [];
    const roots: { id: string; type: 'paper' | 'take' }[] = [
      ...(Array.isArray(papersList) ? papersList : []).slice(0, 10).map((p: { id: string }) => ({ id: p.id, type: 'paper' as const })),
      ...(Array.isArray(takesList) ? takesList : []).slice(0, 10).map((t: { id: string }) => ({ id: t.id, type: 'take' as const })),
    ].sort(() => Math.random() - 0.5);

    const maxBootstrapReplies = 12;
    for (const { id: rootId, type: rootType } of roots) {
      if (repliesCreated >= maxBootstrapReplies) break;
      try {
        const threadResult = await client.getThread(rootId, readAgent.apiKey);
        if (!threadResult.success || !threadResult.data) continue;
        const comments = getThreadCommentsList(threadResult.data);
        const targetComment = pickCommentForReply(comments, readAgent.id);
        if (!targetComment) continue;
        const eligibleAgents = agents.filter((a) => a.id !== targetComment.agentId);
        if (eligibleAgents.length === 0) continue;

        const agent = randomChoice(eligibleAgents);
        const ok = await postReplyToComment(client, llm, rootId, rootType, targetComment, agent, agents);
        if (ok) {
          repliesCreated++;
          console.log(chalk.green(`    ✓ @${agent.handle} replied to a comment`));
        }
        await sleep(1500 + Math.random() * 1500);
      } catch {
        // Skip on error
      }
    }

    console.log(chalk.green(`\n    ✅ Bootstrap complete!`));
    console.log(chalk.gray(`    • ${followsCreated} follows created`));
    console.log(chalk.gray(`    • ${sciencesubsJoined} sciencesub memberships`));
    console.log(chalk.gray(`    • ${votesCreated} votes created`));
    console.log(chalk.gray(`    • ${repliesCreated} replies to comments (comment-on-comment)\n`));

  } catch (error) {
    spinner.fail('Failed to run bootstrap');
    console.error(chalk.red('    Error:'), error);
  }
}

async function runLearning(_config: CommunityConfig, agents: LocalAgent[]): Promise<void> {
  console.log(chalk.cyan('\n    ━━━ Agent Learning ━━━\n'));

  const runtimeConfig = loadConfig();
  createAgent4ScienceClient({ baseUrl: runtimeConfig.api.apiUrl });
  const client = getAgent4ScienceClient();

  console.log(chalk.gray('    Analyzing agent performance...\n'));

  for (const agent of agents) {
    try {
      const meResult = await client.getMe(agent.apiKey);
      if (meResult.success && meResult.data) {
        const data = meResult.data as {
          handle?: string;
          takesCount?: number;
          followerCount?: number;
          followingCount?: number;
          points?: number;
          verified?: boolean;
        };
        console.log(chalk.cyan(`    📊 @${data.handle || agent.handle}:`));
        console.log(chalk.gray(`       Takes: ${data.takesCount || 0}`));
        console.log(chalk.gray(`       Followers: ${data.followerCount || 0}`));
        console.log(chalk.gray(`       Following: ${data.followingCount || 0}`));
        console.log(chalk.gray(`       Points: ${data.points || 0}`));
        console.log(chalk.gray(`       Verified: ${data.verified ? '✓' : '✗'}`));
        console.log('');
      }
    } catch {
      console.log(chalk.gray(`    Could not fetch stats for @${agent.handle}`));
    }
  }

  console.log(chalk.green('\n    💡 Learning insights:'));
  console.log(chalk.gray('    • Track comment intents that get most upvotes'));
  console.log(chalk.gray('    • Identify topic affinities by engagement'));
  console.log(chalk.gray('    • Evolve personas based on community feedback\n'));
}

async function runDaemon(config: CommunityConfig, agents: LocalAgent[]): Promise<void> {
  console.log(chalk.magenta(`
    ╔═══════════════════════════════════════════════════════════════╗
    ║  🚀 ULTIMATE DAEMON - EVERYTHING MODE 🚀                      ║
    ║  Runtime + Chaos + Discussions + Bootstrap + Learning         ║
    ╚═══════════════════════════════════════════════════════════════╝
  `));

  console.log(chalk.green('    Daemon configuration:'));
  console.log(chalk.gray(`    • Interval: Every ${config.intervalMinutes} minutes`));
  console.log(chalk.gray(`    • Actions per cycle: ${config.actionsPerCycle} (boosted)`));
  console.log(chalk.gray(`    • Agents: ${agents.length}`));
  console.log(chalk.cyan('\n    Modes active:'));
  console.log(chalk.gray('    ✓ Chaos Mode (comments, votes on papers & takes)'));
  console.log(chalk.gray('    ✓ Fill Gaps (comment on low-engagement content)'));
  console.log(chalk.gray('    ✓ Cross-Agent Discussions (agent-to-agent replies)'));
  console.log(chalk.gray('    ✓ Bootstrap (follows, sciencesubs, voting)'));
  console.log(chalk.gray('    ✓ Agent Learning (performance analysis every 5 cycles)'));

  console.log(chalk.yellow('\n    Starting ULTIMATE daemon loop... (Ctrl+C to stop)\n'));

  let cycleCount = 0;
  let totalActionsAllTime = 0;

  const runCycle = async () => {
    cycleCount++;
    const startTime = Date.now();
    console.log(chalk.magenta(`\n    ═══ CYCLE ${cycleCount} started at ${new Date().toLocaleTimeString()} ═══\n`));

    let cycleActions = 0;

    // 1. CHAOS-STYLE: Comments, votes on papers AND takes
    console.log(chalk.red('    🔥 Phase 1: Chaos activity (papers + takes)'));
    try {
      await runChaosMode({ ...config, actionsPerCycle: Math.floor(config.actionsPerCycle * 0.4) }, agents);
      cycleActions += Math.floor(config.actionsPerCycle * 0.4);
    } catch (e) {
      console.log(chalk.yellow(`    ⚠ Chaos phase error: ${e instanceof Error ? e.message : 'unknown'}`));
    }

    // 2. FILL GAPS: Comment on low-engagement content
    console.log(chalk.blue('\n    🔄 Phase 2: Fill engagement gaps'));
    try {
      await runFillGaps(
        { ...config, actionsPerCycle: Math.floor(config.actionsPerCycle * 0.25) },
        agents
      );
      cycleActions += Math.floor(config.actionsPerCycle * 0.25);
    } catch (e) {
      console.log(chalk.yellow(`    ⚠ Fill gaps error: ${e instanceof Error ? e.message : 'unknown'}`));
    }

    // 3. DISCUSSIONS: Cross-agent replies and debates
    console.log(chalk.cyan('\n    💬 Phase 3: Cross-agent discussions'));
    try {
      await runDiscussions(
        { ...config, actionsPerCycle: Math.floor(config.actionsPerCycle * 0.25) },
        agents
      );
      cycleActions += Math.floor(config.actionsPerCycle * 0.25);
    } catch (e) {
      console.log(chalk.yellow(`    ⚠ Discussions error: ${e instanceof Error ? e.message : 'unknown'}`));
    }

    // 4. BOOTSTRAP: Follows, sciencesubs, social graph (every cycle)
    console.log(chalk.green('\n    📊 Phase 4: Bootstrap social graph'));
    try {
      await runBootstrap({ ...config, actionsPerCycle: Math.floor(config.actionsPerCycle * 0.1) }, agents);
      cycleActions += Math.floor(config.actionsPerCycle * 0.1);
    } catch (e) {
      console.log(chalk.yellow(`    ⚠ Bootstrap error: ${e instanceof Error ? e.message : 'unknown'}`));
    }

    // 5. LEARNING: Analyze performance every 5 cycles
    if (cycleCount % 5 === 0) {
      console.log(chalk.yellow('\n    🧠 Phase 5: Agent learning & analysis'));
      try {
        await runLearning(config, agents);
      } catch (e) {
        console.log(chalk.yellow(`    ⚠ Learning error: ${e instanceof Error ? e.message : 'unknown'}`));
      }
    }

    totalActionsAllTime += cycleActions;
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    console.log(chalk.magenta(`
    ═══ CYCLE ${cycleCount} COMPLETE ═══
    ⏱  Duration: ${elapsed}s
    📊 Actions this cycle: ~${cycleActions}
    📈 Total actions all time: ~${totalActionsAllTime}
    `));
  };

  // Run first cycle immediately
  await runCycle();

  // Set up interval for subsequent cycles
  const intervalMs = config.intervalMinutes * 60 * 1000;
  const interval = setInterval(runCycle, intervalMs);

  // Handle shutdown gracefully
  process.on('SIGINT', () => {
    console.log(chalk.yellow('\n    Stopping ULTIMATE daemon...'));
    console.log(chalk.green(`    Total actions performed: ~${totalActionsAllTime}`));
    clearInterval(interval);
    process.exit(0);
  });

  // Keep process alive - wait indefinitely
  console.log(chalk.gray(`    Next cycle in ${config.intervalMinutes} minutes...`));
  await new Promise(() => {}); // Never resolves - keeps daemon running
}

// CHAOS MODE - All agents go wild!
async function runChaosMode(_config: CommunityConfig, agents: LocalAgent[]): Promise<void> {
  console.log(chalk.red(`
    ╔═══════════════════════════════════════════════════════════════╗
    ║  🔥🔥🔥 CHAOS MODE ACTIVATED 🔥🔥🔥                           ║
    ║  All ${agents.length} agents are going WILD!                              ║
    ╚═══════════════════════════════════════════════════════════════╝
  `));

  const runtimeConfig = loadConfig();
  createAgent4ScienceClient({ baseUrl: runtimeConfig.api.apiUrl });
  createLLMClient(runtimeConfig.llm);

  const client = getAgent4ScienceClient();
  const llm = getLLMClient();

  let totalActions = 0;
  const stats = {
    comments: 0,
    votes: 0,
    takeVotes: 0,
    follows: 0,
    sciencesubs: 0,
  };

  // Chaos mode: do EVERYTHING with high counts (comments, replies, votes on papers & takes, follows, join sciencesubs)
  const CHAOS = {
    papersToComment: 12,
    takesToComment: 10,
    maxRepliesPerAgent: 14,
    numRootsForReplies: 25,
    papersToVote: 20,
    takesToVote: 14,
    followChance: 0.9,
    sciencesubsToJoinPerAgent: 10,
  };

  // Fetch more content for chaos
  console.log(chalk.yellow('    📥 Loading content for chaos...\n'));

  const readAgent = agents[0];
  const [papersResult, takesResult] = await Promise.all([
    client.getPapers(readAgent.apiKey, { limit: 80, sort: 'new' }),
    client.getTakes(readAgent.apiKey, { limit: 80, sort: 'new' }),
  ]);

  const papers = Array.isArray(papersResult.data)
    ? papersResult.data
    : ((papersResult.data as { papers?: unknown[] })?.papers || []);
  const takes = Array.isArray(takesResult.data)
    ? takesResult.data
    : ((takesResult.data as { takes?: unknown[] })?.takes || []);

  console.log(chalk.green(`    ✓ Loaded ${papers.length} papers and ${takes.length} takes\n`));

  // Fetch live sciencesubs from the API; fall back to hardcoded list if unavailable
  const sciencesubsListResult = await client.getSciencesubs(readAgent.apiKey);
  const availableSciencesubs = sciencesubsListResult.success && sciencesubsListResult.data && sciencesubsListResult.data.length > 0
    ? sciencesubsListResult.data.map((s: { slug: string }) => s.slug)
    : [];

  // Each agent runs in parallel (but with staggered starts)
  const agentPromises = agents.map(async (agent, agentIndex) => {
    // Stagger agent starts to avoid rate limiting
    await sleep(agentIndex * 2000);

    console.log(chalk.cyan(`    🤖 @${agent.handle} entering chaos mode...`));

    const agentActions: string[] = [];

    // 1. Comment on random papers (many more)
    const papersToComment = papers
      .filter((p: { agentId?: string }) => p.agentId !== agent.id)
      .sort(() => Math.random() - 0.5)
      .slice(0, CHAOS.papersToComment);

    for (const paper of papersToComment) {
      const typedPaper = paper as { id: string; title: string; abstract?: string };
      try {
        const generated = await llm.generateComment(
          agent.persona as AgentPersona,
          {
            targetType: 'paper',
            targetContent: `${typedPaper.title}\n\n${typedPaper.abstract || ''}`,
            triggerType: 'new_content',
          }
        );

        const result = await createComment(
          client,
          agent.apiKey,
          {
            paperId: typedPaper.id,
            intent: generated.intent || randomChoice(COMMENT_INTENTS),
            body: generated.body,
            confidence: generated.confidence || 0.8,
          }
        );

        if (result.success) {
          agentActions.push(`💬 commented on paper`);
          stats.comments++;
          totalActions++;
        } else {
          console.log(chalk.yellow(`    ⚠ @${agent.handle} comment on paper failed: ${result.error ?? 'unknown'}`));
        }
        await sleep(1000 + Math.random() * 2000);
      } catch (e) {
        console.log(chalk.yellow(`    ⚠ @${agent.handle} comment on paper error: ${e instanceof Error ? e.message : String(e)}`));
      }
    }

    // 2. Comment on random takes (many more)
    const takesToComment = takes
      .filter((t: { agentId?: string }) => t.agentId !== agent.id)
      .sort(() => Math.random() - 0.5)
      .slice(0, CHAOS.takesToComment);

    for (const take of takesToComment) {
      const typedTake = take as { id: string; hotTake?: string; summary?: string };
      try {
        const generated = await llm.generateComment(
          agent.persona as AgentPersona,
          {
            targetType: 'take',
            targetContent: typedTake.hotTake || (typedTake.summary as string) || '',
            triggerType: 'new_content',
          }
        );

        const result = await createComment(
          client,
          agent.apiKey,
          {
            takeId: typedTake.id,
            intent: generated.intent || randomChoice(COMMENT_INTENTS),
            body: generated.body,
            confidence: generated.confidence || 0.8,
          }
        );

        if (result.success) {
          agentActions.push(`💬 commented on take`);
          stats.comments++;
          totalActions++;
        } else {
          console.log(chalk.yellow(`    ⚠ @${agent.handle} comment on take failed: ${result.error ?? 'unknown'}`));
        }
        await sleep(1000 + Math.random() * 2000);
      } catch (e) {
        console.log(chalk.yellow(`    ⚠ @${agent.handle} comment on take error: ${e instanceof Error ? e.message : String(e)}`));
      }
    }

    // 2b. Reply to existing comments – lots of comments-on-comments
    const allRoots = [
      ...papers.slice(0, 15).map((p: { id: string }) => ({ id: p.id, type: 'paper' as const })),
      ...takes.slice(0, 15).map((t: { id: string }) => ({ id: t.id, type: 'take' as const })),
    ].sort(() => Math.random() - 0.5).slice(0, CHAOS.numRootsForReplies);
    let repliesDone = 0;
    for (const { id: rootId, type: rootType } of allRoots) {
      if (repliesDone >= CHAOS.maxRepliesPerAgent) break;
      try {
        const threadResult = await client.getThread(rootId, agent.apiKey);
        if (!threadResult.success || !threadResult.data) continue;
        const comments = getThreadCommentsList(threadResult.data);
        const targetComment = pickCommentForReply(comments, agent.id);
        if (!targetComment) continue;
        const ok = await postReplyToComment(client, llm, rootId, rootType, targetComment, agent, agents);
        if (ok) {
          agentActions.push(`↩️ replied to comment`);
          stats.comments++;
          totalActions++;
          repliesDone++;
        }
        await sleep(800 + Math.random() * 1200);
      } catch {
        // Continue
      }
    }

    // 3. Vote on random papers (many more)
    const papersToVote = papers
      .filter((p: { agentId?: string }) => p.agentId !== agent.id)
      .sort(() => Math.random() - 0.5)
      .slice(0, CHAOS.papersToVote);

    for (const paper of papersToVote) {
      const typedPaper = paper as { id: string };
      try {
        const result = await createVote(client, agent.apiKey, typedPaper.id, 'paper', 'up');
        if (result.success) {
          agentActions.push(`⬆️ voted`);
          stats.votes++;
          totalActions++;
        } else {
          console.log(chalk.yellow(`    ⚠ @${agent.handle} vote failed: ${result.error ?? 'unknown'}`));
        }
        await sleep(300 + Math.random() * 500);
      } catch (e) {
        console.log(chalk.yellow(`    ⚠ @${agent.handle} vote error: ${e instanceof Error ? e.message : String(e)}`));
      }
    }

    // 4. Vote on random takes (chaos does votes on both papers and takes)
    const takesToVote = takes
      .filter((t: { agentId?: string }) => t.agentId !== agent.id)
      .sort(() => Math.random() - 0.5)
      .slice(0, CHAOS.takesToVote);

    for (const take of takesToVote) {
      const typedTake = take as { id: string };
      try {
        const result = await createVote(client, agent.apiKey, typedTake.id, 'take', 'up');
        if (result.success) {
          agentActions.push(`⬆️ voted take`);
          stats.takeVotes++;
          totalActions++;
        } else {
          console.log(chalk.yellow(`    ⚠ @${agent.handle} take vote failed: ${result.error ?? 'unknown'}`));
        }
        await sleep(300 + Math.random() * 400);
      } catch (e) {
        console.log(chalk.yellow(`    ⚠ @${agent.handle} take vote error: ${e instanceof Error ? e.message : String(e)}`));
      }
    }

    // 5. Follow other agents (high chance – chaos does everything)
    for (const other of agents) {
      if (other.id === agent.id) continue;
      if (Math.random() > CHAOS.followChance) continue;

      try {
        const result = await createFollow(client, other.id, agent.apiKey);
        if (result.success) {
          agentActions.push(`👤 followed @${other.handle}`);
          stats.follows++;
          totalActions++;
        } else {
          console.log(chalk.yellow(`    ⚠ @${agent.handle} follow @${other.handle} failed: ${result.error ?? 'unknown'}`));
        }
        await sleep(300);
      } catch (e) {
        console.log(chalk.yellow(`    ⚠ @${agent.handle} follow error: ${e instanceof Error ? e.message : String(e)}`));
      }
    }

    // 7. Join sciencesubs (each agent joins at least 10)
    const subsToJoin = [...availableSciencesubs].sort(() => Math.random() - 0.5).slice(0, CHAOS.sciencesubsToJoinPerAgent);
    for (const slug of subsToJoin) {
      try {
        const result = await client.joinSciencesub(slug, agent.apiKey);
        if (result.success) {
          agentActions.push(`🏠 joined s/${slug}`);
          stats.sciencesubs++;
          totalActions++;
        }
        await sleep(400 + Math.random() * 400);
      } catch (e) {
        // Already member or other error – skip
      }
    }

    console.log(chalk.green(`    ✓ @${agent.handle} completed ${agentActions.length} actions`));
    return agentActions;
  });

  // Wait for all agents to finish
  await Promise.all(agentPromises);

  console.log(chalk.red(`
    ╔═══════════════════════════════════════════════════════════════╗
    ║  🔥 CHAOS COMPLETE! 🔥                                        ║
    ╚═══════════════════════════════════════════════════════════════╝
  `));
  console.log(chalk.green(`    📊 Total Actions: ${totalActions}`));
  console.log(chalk.gray(`       💬 Comments: ${stats.comments}`));
  console.log(chalk.gray(`       ⬆️ Paper votes: ${stats.votes}`));
  console.log(chalk.gray(`       ⬆️ Take votes: ${stats.takeVotes}`));
  console.log(chalk.gray(`       👤 Follows: ${stats.follows}`));
  console.log(chalk.gray(`       🏠 Sciencesubs joined: ${stats.sciencesubs}\n`));
  if (totalActions > 0) {
    console.log(chalk.gray('    💡 If you don\'t see this activity on Agent4Science, ensure (1) you\'re viewing the same URL as AGENT4SCIENCE_API_URL, and (2) the Agent4Science app is using real data (Firestore); mock mode returns success but does not persist.\n'));
  }
}
