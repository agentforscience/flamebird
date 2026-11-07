/**
 * `flamebird attempt` — non-interactive challenge submission
 *
 * Lets Claude Code (skill.md) and scripts submit challenges authentically:
 * the named agent's configured model (Llama-4, Gemini, DeepSeek, etc.) writes
 * the solver code, we execute it, and submit under that agent's key.
 *
 * Usage:
 *   flamebird attempt --agent meta_mapper --challenge ch_abc123
 *   flamebird attempt --agent clarity_bot --challenge ch_abc123 --force
 *   flamebird attempt --all-agents --challenge ch_abc123
 */

import { scoresToBeat } from '../../utils/scores-to-beat.js';
import chalk from 'chalk';
import { loadConfig, validateSecrets } from '../../config/config.js';
import { createDatabase, getDatabase } from '../../db/database.js';
import { createAgentManager } from '../../agents/agent-manager.js';
import { createAgent4ScienceClient, getAgent4ScienceClient } from '../../api/agent4science-client.js';
import { createLLMClient, getOrCreateLLMClient } from '../../llm/llm-client.js';
import { createRateLimiter } from '../../rate-limit/rate-limiter.js';
import { createActionExecutor } from '../../actions/action-executor.js';
import { describeWorkProfile, toHarness, workLogFields, workProfileFor } from '../../llm/work-style.js';
import { attachSiteMemory } from '../../utils/site-memory.js';
import { beginNotesSession, endNotesSession } from '../../utils/site-notes.js';

export async function attemptCommand(opts: {
  agent?: string;
  allAgents?: boolean;
  challenge: string;
  force?: boolean;
}): Promise<void> {
  const { challenge: challengeId, force = false } = opts;

  if (!opts.agent && !opts.allAgents) {
    console.error(chalk.red('Error: specify --agent <handle> or --all-agents'));
    process.exit(1);
  }

  try {
    const config = loadConfig();
    validateSecrets();

    createDatabase(config.database.path);
    createAgent4ScienceClient({ baseUrl: config.api.apiUrl });
    createLLMClient(config.llm);
    createRateLimiter(config.rateLimits);
    createActionExecutor(); // needed for action-executor singleton init only

    const manager = await createAgentManager(config.security.encryptionKey);
    await manager.loadAgents();

    const db = getDatabase();
    const client = getAgent4ScienceClient();

    // Resolve which agents to use
    const allRuntimes = manager.getAgents();
    const targets = opts.allAgents
      ? allRuntimes
      : allRuntimes.filter(a => a.config.handle === opts.agent);

    if (targets.length === 0) {
      const available = allRuntimes.map(a => a.config.handle).join(', ');
      console.error(chalk.red(`Agent "${opts.agent}" not found. Available: ${available}`));
      process.exit(1);
    }

    // Fetch the challenge once
    console.log(chalk.gray(`\nFetching challenge ${challengeId}...`));
    // Use the first agent's key just to fetch (public endpoint)
    const firstApiKey = manager.getApiKey(targets[0].config.id)!;
    const challengeResult = await client.getChallenge(challengeId, firstApiKey);

    if (!challengeResult.success || !challengeResult.data) {
      console.error(chalk.red(`Challenge not found: ${challengeId}`));
      process.exit(1);
    }

    const challenge = challengeResult.data;
    const isDeterministic = challenge.evaluationType === 'deterministic' && !!challenge.verifier;

    console.log(chalk.bold(`\n  Challenge: ${challenge.title}`));
    console.log(`  Type:      ${chalk.cyan(challenge.evaluationType)}`);
    console.log(`  Scoring:   ${challenge.scoringDirection || 'maximize'}\n`);

    // Fetch existing submissions for context
    const subResult = await client.getChallengeSubmissions(challengeId, firstApiKey, { sort: 'top', limit: 10 });
    const submissions = subResult.success && subResult.data
      ? (Array.isArray(subResult.data) ? subResult.data : [])
      : [];

    let overallSuccess = true;

    for (const runtime of targets) {
      const agentId = runtime.config.id;
      const handle = runtime.config.handle;
      const apiKey = manager.getApiKey(agentId);

      if (!apiKey) {
        console.log(chalk.yellow(`  @${handle}: no API key — skipping`));
        continue;
      }

      // Skip if already submitted (unless --force)
      if (!force && db.hasEngaged(agentId, challengeId, 'submission')) {
        console.log(chalk.dim(`  @${handle}: already submitted — skipping (use --force to override)`));
        continue;
      }

      // Check platform truth too
      if (!force) {
        const ownSubs = submissions.filter(s => s.agentId === agentId);
        if (ownSubs.length > 0) {
          console.log(chalk.dim(`  @${handle}: already has ${ownSubs.length} submission(s) on platform — skipping`));
          db.recordEngagement(agentId, challengeId, 'challenge', 'submission');
          continue;
        }
      }

      // Get this agent's LLM client (uses configured model: Llama-4, Gemini, etc.)
      const llmOverride = db.getAgent(agentId)?.llmOverride;
      const llm = getOrCreateLLMClient(llmOverride);

      const modelLabel = llmOverride?.model ?? config.llm.model;
      console.log(chalk.bold(`\n@${handle}`) + chalk.dim(` (${modelLabel})`));
      const workProfile = workProfileFor(runtime.config.persona);
      console.log(chalk.dim(`  Style:    ${describeWorkProfile(runtime.config.persona)}`));
      const logWork = (status: 'submitted' | 'blocked' | 'failed', resultId?: string, error?: string, score?: number) =>
        db.recordWork({
          agentId, kind: 'submission', targetId: challengeId, resultId, status, error, ...workLogFields(workProfile),
          score: score ?? null, scoringDirection: challenge.scoringDirection ?? null,
        });

      try {
        await beginNotesSession(agentId, apiKey, runtime.config.persona);
        await attachSiteMemory(runtime.config.persona, agentId, apiKey);

        let solution;

        if (isDeterministic) {
          console.log(chalk.gray('  Generating solver (LLM writes Python → execute → submit)...'));
          solution = await llm.generateSolverSolution(
            runtime.config.persona,
            {
              title: challenge.title,
              description: challenge.description,
              tags: challenge.tags,
              verifier: challenge.verifier,
              solutionSchema: challenge.solutionSchema,
              scoringDirection: challenge.scoringDirection,
              minImprovement: challenge.minImprovement,
              referenceScore: challenge.referenceScore,
              referenceLabel: challenge.referenceLabel,
              theoreticalScore: challenge.theoreticalScore,
              theoreticalLabel: challenge.theoreticalLabel,
            },
            await scoresToBeat(client, challenge, apiKey, submissions),
          );
        } else {
          console.log(chalk.gray('  Generating solution (analyze → draft → verify)...'));
          solution = await llm.generateSolution(
            runtime.config.persona,
            { title: challenge.title, description: challenge.description, tags: challenge.tags },
            submissions.slice(0, 3).map(s => ({ title: s.title, approach: s.approach, body: s.body })),
          );
        }

        if (!solution) {
          console.log(chalk.yellow(`  @${handle}: quality gate blocked — no submission made`));
          logWork('blocked');
          overallSuccess = false;
          continue;
        }

        console.log(chalk.dim(`  Title:    ${solution.title.slice(0, 70)}`));
        console.log(chalk.dim(`  Approach: ${solution.approach.slice(0, 80)}`));

        // Submit directly via API — bypass the action queue (which processes all pending actions)
        const submitResult = await client.createSubmission(challengeId, {
          title: solution.title,
          body: solution.body,
          approach: solution.approach,
          solutionData: solution.solutionData,
          harness: toHarness(workProfile),
        }, apiKey);

        if (!submitResult.success) {
          console.log(chalk.red(`  @${handle}: API error — ${submitResult.error}`));
          logWork('failed', undefined, submitResult.error);
          overallSuccess = false;
          continue;
        }

        const submissionId = submitResult.data?.id;
        logWork('submitted', submissionId, undefined, solution.localScore ?? solution.declaredScore);
        console.log(chalk.dim(`  Submission: ${submissionId}`));

        db.recordEngagement(agentId, challengeId, 'challenge', 'submission');
        console.log(chalk.green(`  ✓ Submitted`));

      } catch (err) {
        console.error(chalk.red(`  @${handle}: error — ${err instanceof Error ? err.message : err}`));
        logWork('failed', undefined, err instanceof Error ? err.message : String(err));
        overallSuccess = false;
      } finally {
        // Run end: write consolidated site notes once (guarded; silent on failure)
        await endNotesSession(agentId, apiKey, handle, runtime.config.persona);
      }
    }

    if (!overallSuccess) process.exit(1);

  } catch (error) {
    console.error(chalk.red('\nError:'), error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
