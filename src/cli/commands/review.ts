/**
 * Review Command
 * Have one or more agents write a peer review of a specific paper, then exit.
 *
 * Usage:
 *   flamebird review --paper <paperId> --agent dr_falsify
 *   flamebird review --paper <paperId> --agent dr_falsify,synth_mind
 *   flamebird review --paper <paperId> --all-agents
 *
 * Each agent uses its own model and working style, sees its site memory, and
 * sends a soundness judgment (sound | flawed) with the review. Agents that
 * already reviewed the paper, or wrote it, are skipped.
 */

import chalk from 'chalk';
import { loadConfig, validateSecrets } from '../../config/config.js';
import { createDatabase, getDatabase } from '../../db/database.js';
import { createAgentManager } from '../../agents/agent-manager.js';
import { createAgent4ScienceClient, getAgent4ScienceClient } from '../../api/agent4science-client.js';
import { createLLMClient, getOrCreateLLMClient } from '../../llm/llm-client.js';
import { createRateLimiter } from '../../rate-limit/rate-limiter.js';
import { createActionExecutor, buildReviewParams } from '../../actions/action-executor.js';
import { describeWorkProfile, workLogFields, workProfileFor } from '../../llm/work-style.js';
import { attachSiteMemory } from '../../utils/site-memory.js';
import { beginNotesSession, endNotesSession } from '../../utils/site-notes.js';

interface ReviewOptions {
  paper: string;
  agent?: string;
  allAgents?: boolean;
  force?: boolean;
}

export async function reviewCommand(opts: ReviewOptions): Promise<void> {
  if (!opts.paper) {
    console.error(chalk.red('--paper <paperId> is required'));
    process.exit(1);
  }
  if (!opts.agent && !opts.allAgents) {
    console.error(chalk.red('Choose agents with --agent <handle[,handle]> or --all-agents'));
    process.exit(1);
  }

  const config = loadConfig();
  validateSecrets();
  createDatabase(config.database.path);
  createAgent4ScienceClient({ baseUrl: config.api.apiUrl });
  createLLMClient(config.llm);
  createRateLimiter(config.rateLimits);
  createActionExecutor();

  const manager = await createAgentManager(config.security.encryptionKey);
  await manager.loadAgents();
  const db = getDatabase();
  const client = getAgent4ScienceClient();

  const wanted = new Set((opts.agent || '').split(',').map(h => h.trim().replace(/^@/, '')).filter(Boolean));
  const targets = manager.getAgents().filter(a => opts.allAgents || wanted.has(a.config.handle));
  if (!targets.length) {
    console.error(chalk.red(`No matching agents. Available: ${manager.getAgents().map(a => a.config.handle).join(', ')}`));
    process.exit(1);
  }

  const firstKey = manager.getApiKey(targets[0].config.id);
  if (!firstKey) {
    console.error(chalk.red(`@${targets[0].config.handle} has no API key`));
    process.exit(1);
  }
  const paperResult = await client.getPaper(opts.paper, firstKey);
  if (!paperResult.success || !paperResult.data) {
    console.error(chalk.red(`Paper not found: ${opts.paper}`));
    process.exit(1);
  }
  const paper = paperResult.data;
  console.log(chalk.bold(`\n  Paper: ${paper.title}\n`));

  let failures = 0;
  for (const runtime of targets) {
    const { id: agentId, handle, persona } = runtime.config;
    const apiKey = manager.getApiKey(agentId);
    if (!apiKey) { console.log(chalk.yellow(`  @${handle}: no API key, skipping`)); continue; }
    if (paper.agentId === agentId) { console.log(chalk.dim(`  @${handle}: wrote this paper, skipping`)); continue; }
    if (!opts.force && db.hasEngaged(agentId, paper.id, 'review')) {
      console.log(chalk.dim(`  @${handle}: already reviewed, skipping (--force to override)`));
      continue;
    }

    const llmOverride = db.getAgent(agentId)?.llmOverride;
    const llm = getOrCreateLLMClient(llmOverride);
    const profile = workProfileFor(persona);
    console.log(chalk.bold(`  @${handle}`) + chalk.dim(` (${llmOverride ? `${llmOverride.provider}/${llmOverride.model}` : `${config.llm.provider}/${config.llm.model}`}; ${describeWorkProfile(persona)})`));

    try {
      await beginNotesSession(agentId, apiKey, persona);
      await attachSiteMemory(persona, agentId, apiKey);
      const review = await llm.generateReview(persona, {
        id: paper.id,
        title: paper.title,
        abstract: paper.abstract || paper.tldr || '',
        claims: paper.claims || [],
        limitations: paper.limitations || [],
        pdfUrl: paper.pdfUrl,
        hypothesis: paper.hypothesis,
        methods: paper.experimentPlan,
        conclusion: paper.conclusion,
      });
      const result = await client.createReview(buildReviewParams({ paperId: paper.id, ...review }, profile), apiKey);
      if (!result.success) {
        console.log(chalk.red(`    API error: ${result.error}`));
        db.recordWork({ agentId, kind: 'review', targetId: paper.id, resultId: null, status: 'failed', error: result.error, ...workLogFields(profile) });
        failures++;
        continue;
      }
      const reviewId = (result.data as { id?: string })?.id ?? null;
      db.recordWork({
        agentId, kind: 'review', targetId: paper.id, resultId: reviewId, status: 'submitted', ...workLogFields(profile),
        soundness: review.soundness ?? null, soundnessConfidence: review.soundnessConfidence ?? null,
      });
      db.recordEngagement(agentId, paper.id, 'paper', 'review');
      console.log(chalk.green(`    ✓ ${review.soundness ?? 'no soundness'}${typeof review.soundnessConfidence === 'number' ? ` (${review.soundnessConfidence})` : ''}: ${review.title.slice(0, 70)}`));
    } catch (err) {
      console.log(chalk.red(`    Failed: ${err instanceof Error ? err.message : String(err)}`));
      failures++;
    } finally {
      await endNotesSession(agentId, apiKey, handle, persona).catch(() => {});
    }
  }
  process.exit(failures ? 1 : 0);
}
