/**
 * Main Event Loop
 * Orchestrates the agent runtime - polling, thinking, and acting
 */

import { Cron } from 'croner';
import type {
  RuntimeEvent,
  EventHandler,
  Agent4ScienceNotification,
  RuntimeConfig,
} from '../types.js';
import { createAgent4ScienceClient, getAgent4ScienceClient } from '../api/agent4science-client.js';
import { createAgentManager, getAgentManager } from '../agents/agent-manager.js';
import { createDatabase, closeDatabase, getDatabase } from '../db/database.js';
import { createRateLimiter, getRateLimiter } from '../rate-limit/rate-limiter.js';
import { createNotificationPoller, getNotificationPoller } from '../polling/notification-poller.js';
import { createActionExecutor, getActionExecutor } from '../actions/action-executor.js';
import { createLLMClient, createVerifierClient, getOrCreateLLMClient } from '../llm/llm-client.js';
import { createProactiveEngine, getProactiveEngine } from '../engagement/proactive-engine.js';
import { createLogger } from '../logging/logger.js';
import { loadConfig } from '../config/config.js';
import { tickPaperGeneration, type ManagerAgentConfig } from '../tools/manager-agent.js';
import { resolveNeuricoPath } from '../tools/paper-tools.js';

const logger = createLogger('runtime');

/** Resolve agent ID to @handle for readable logs. */
function agentName(agentId: string): string {
  try {
    const runtime = getAgentManager().getRuntime(agentId);
    if (!runtime) return agentId.slice(-12);
    const dn = runtime.config.displayName;
    return dn && dn !== runtime.config.handle ? `@${runtime.config.handle} (${dn})` : `@${runtime.config.handle}`;
  } catch {
    return agentId.slice(-12);
  }
}

function agentLog(agentId: string) {
  return { agent: agentName(agentId), agentId };
}

export interface EventLoopConfig {
  tickIntervalMs: number;        // How often to check for work (e.g., 1s)
  maxActionsPerTick: number;     // Max actions to execute per tick
  shutdownTimeoutMs: number;     // How long to wait for graceful shutdown
}

export const DEFAULT_EVENT_LOOP_CONFIG: EventLoopConfig = {
  tickIntervalMs: 250,   // Check every 0.25s (was 0.5s) → 2× FASTER for ultra-responsive agents!
  maxActionsPerTick: 30, // Execute up to 30 actions per tick (was 15) → 2× MORE throughput!
  shutdownTimeoutMs: 10000,
};

export class EventLoop {
  private config: EventLoopConfig;
  private runtimeConfig: RuntimeConfig;
  private running: boolean = false;
  private shuttingDown: boolean = false;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private eventHandlers: EventHandler[] = [];
  private healthCheckJob: Cron | null = null;

  // Stats tracking for CLI
  private stats = {
    startTime: new Date(),
    tickCount: 0,
    actionsExecuted: 0,
    errorsCount: 0,
    papersGenerated: 0,
  };

  constructor(
    runtimeConfig: RuntimeConfig,
    config: EventLoopConfig = DEFAULT_EVENT_LOOP_CONFIG
  ) {
    this.runtimeConfig = runtimeConfig;
    this.config = config;
  }

  /**
   * Initialize all components
   */
  async initialize(): Promise<void> {
    logger.info('Initializing agent runtime...');

    // Create database first
    createDatabase(this.runtimeConfig.database.path);
    logger.info('Database initialized');

    // Create API client
    createAgent4ScienceClient({ baseUrl: this.runtimeConfig.api.apiUrl });
    logger.info('API client initialized');

    // Create rate limiter
    createRateLimiter(this.runtimeConfig.rateLimits);
    logger.info('Rate limiter initialized');

    // Create agent manager
    createAgentManager(this.runtimeConfig.security.encryptionKey);
    const manager = getAgentManager();
    await manager.loadAgents();
    logger.info(`Agent manager initialized with ${manager.getAgentIds().length} agents`);

    // Create notification poller
    createNotificationPoller({
      baseIntervalMs: this.runtimeConfig.polling.baseIntervalMs,
      maxIntervalMs: this.runtimeConfig.polling.maxIntervalMs,
      backoffMultiplier: this.runtimeConfig.polling.backoffMultiplier,
      jitterPercent: 0.1,
    });
    logger.info('Notification poller initialized');

    // Create action executor
    createActionExecutor();
    logger.info('Action executor initialized');

    // Create LLM client
    createLLMClient({
      provider: this.runtimeConfig.llm.provider,
      apiKey: this.runtimeConfig.llm.apiKey,
      model: this.runtimeConfig.llm.model,
    });
    logger.info(`LLM client initialized (${this.runtimeConfig.llm.provider}/${this.runtimeConfig.llm.model})`);

    // Create verifier client if configured (cross-model verification for challenge submissions)
    if (this.runtimeConfig.verifier) {
      createVerifierClient({
        provider: this.runtimeConfig.verifier.provider,
        apiKey: this.runtimeConfig.verifier.apiKey,
        model: this.runtimeConfig.verifier.model,
      });
      logger.info(`Verifier client initialized (${this.runtimeConfig.verifier.provider}/${this.runtimeConfig.verifier.model})`);
    }

    // Create proactive engagement engine
    createProactiveEngine(this.runtimeConfig.proactive);
    logger.info('Proactive engagement engine initialized');

    // Initialize polling state for all agents
    const poller = getNotificationPoller();
    for (const agentId of manager.getAgentIds()) {
      poller.initAgent(agentId);
    }

    // Log paper-capable agents
    const paperAgents = manager.getEnabledAgents().filter(
      a => a.config.capability === 'neurico'
    );
    if (paperAgents.length > 0) {
      logger.info(
        { agents: paperAgents.map(a => `@${a.config.handle} (${a.config.capability})`) },
        `${paperAgents.length} paper-generating agent(s) active`
      );

      // Validate NeuriCo dependencies upfront
      const iePath = process.env.NEURICO_PATH || resolveNeuricoPath();
      if (!iePath) {
        logger.warn(
          'NeuriCo not found — paper generation will fail. Set NEURICO_PATH or install: curl -fsSL https://raw.githubusercontent.com/ChicagoHAI/neurico/main/install.sh | bash'
        );
      }
      if (!this.runtimeConfig.llm.apiKey) {
        logger.warn('LLM_API_KEY not set — paper topic discovery and summarization will use fallback content');
      }
    }

    // Initialization: join up to 5 most relevant sciencesubs for each agent
    await this.initAgentSciencesubs(manager.getAgentIds());

    logger.info('Runtime initialization complete');
  }

  /**
   * On startup, join up to 5 sciencesubs per agent based on persona topic relevance.
   * Skips subs the agent already belongs to (join returns 409 which we ignore).
   */
  private async initAgentSciencesubs(agentIds: string[]): Promise<void> {
    const client = getAgent4ScienceClient();
    const manager = getAgentManager();
    const db = getDatabase();

    for (const agentId of agentIds) {
      const apiKey = manager.getApiKey(agentId);
      const agent = manager.getRuntime(agentId);
      if (!apiKey || !agent) continue;

      try {
        // Fetch available sciencesubs with 1 retry (transient server issues)
        let subsResult = await client.getSciencesubs(apiKey);
        if (!subsResult.success || !subsResult.data) {
          logger.warn({ ...agentLog(agentId), error: subsResult.error }, 'getSciencesubs failed, retrying in 2s...');
          await new Promise(resolve => setTimeout(resolve, 2000));
          subsResult = await client.getSciencesubs(apiKey);
        }

        if (!subsResult.success || !subsResult.data) {
          logger.warn({ ...agentLog(agentId), error: subsResult.error }, 'getSciencesubs failed after retry, skipping agent');
          continue;
        }

        const subs = Array.isArray(subsResult.data) ? subsResult.data : [];
        if (subs.length === 0) {
          logger.warn({ ...agentLog(agentId) }, 'getSciencesubs returned empty list — no sciencesubs available to join');
          continue;
        }

        const preferredTopics: string[] = agent.config.persona?.preferredTopics ?? [];

        // Score each sub by how many preferred topic keywords appear in its name/description
        const scored = subs.map(sub => {
          const text = `${sub.name} ${sub.description}`.toLowerCase();
          const score = preferredTopics.reduce((acc, topic) => {
            return acc + (text.includes(topic.toLowerCase()) ? 1 : 0);
          }, 0);
          return { sub, score };
        });

        // Sort by relevance descending, take top 5
        scored.sort((a, b) => b.score - a.score);
        const top5 = scored.slice(0, 5);

        // If all scores are zero (no topic matches), still join the first 5 subs —
        // any membership is better than none; discoverSciencesubs can optimize later
        const hasRelevantMatch = top5.some(s => s.score > 0);
        if (!hasRelevantMatch) {
          logger.warn({ ...agentLog(agentId), preferredTopics }, 'No relevant sciencesub matches found — falling back to first 5 subs');
        }

        const subsToJoin = top5.map(s => s.sub);

        let confirmed = 0;
        for (const sub of subsToJoin) {
          const joinResult = await client.joinSciencesub(sub.slug, apiKey);
          if (joinResult.success || joinResult.code === 'ALREADY_MEMBER') {
            // Only cache when server confirms membership
            db.recordSciencesubJoin(agentId, sub.slug);
            confirmed++;
          }
        }

        logger.info(`${agentName(agentId)}: ${confirmed} sciencesub memberships confirmed on init (${subsToJoin.length} attempted)`);
      } catch (error) {
        logger.warn({ err: error, ...agentLog(agentId) }, 'Failed to init sciencesubs for agent');
      }
    }
  }

  /**
   * Subscribe to runtime events
   */
  on(handler: EventHandler): () => void {
    this.eventHandlers.push(handler);
    return () => {
      const idx = this.eventHandlers.indexOf(handler);
      if (idx >= 0) {
        this.eventHandlers.splice(idx, 1);
      }
    };
  }

  /**
   * Emit an event to all handlers
   */
  private async emit(event: RuntimeEvent): Promise<void> {
    for (const handler of this.eventHandlers) {
      try {
        await handler(event);
      } catch (error) {
        logger.error({ err: error }, 'Event handler error');
      }
    }
  }

  /**
   * Start the event loop
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('Event loop already running');
      return;
    }

    logger.info('Starting event loop...');
    this.running = true;
    this.shuttingDown = false;
    this.stats.startTime = new Date();
    this.stats.tickCount = 0;
    this.stats.actionsExecuted = 0;
    this.stats.errorsCount = 0;
    this.stats.papersGenerated = 0;

    // Start health check cron (every minute)
    this.healthCheckJob = new Cron('* * * * *', () => {
      this.healthCheck();
    });

    // Start the main tick loop
    this.scheduleTick();

    logger.info('Event loop started');
  }

  /**
   * Schedule the next tick
   */
  private scheduleTick(): void {
    if (!this.running || this.shuttingDown) {
      return;
    }

    this.tickTimer = setTimeout(async () => {
      await this.tick();
      this.scheduleTick();
    }, this.config.tickIntervalMs);
  }

  /**
   * Main tick - poll, discover, and execute
   */
  private async tick(): Promise<void> {
    this.stats.tickCount++;

    const manager = getAgentManager();
    const poller = getNotificationPoller();
    const executor = getActionExecutor();
    const proactive = getProactiveEngine();

    // Phase 1: Poll for notifications (for agents that are due)
    for (const agentId of manager.getAgentIds()) {
      const agent = manager.getRuntime(agentId);
      if (!agent || agent.config.enabled === false) {
        continue;
      }

      // Check if this agent should poll now
      if (!poller.shouldPollNow(agentId)) {
        continue;
      }

      try {
        manager.updateState(agentId, 'polling');
        await this.emit({ type: 'agent_state_changed', agentId, state: 'polling' });

        const notifications = await poller.pollAgent(agentId);

        // Process each notification
        for (const notification of notifications) {
          await this.emit({
            type: 'notification_received',
            agentId,
            notification,
          });

          // Queue response action
          await this.handleNotification(agentId, notification);

          // Mark as processed
          poller.markProcessed(notification.id, agentId);
        }

        manager.updateState(agentId, 'idle');
        await this.emit({ type: 'agent_state_changed', agentId, state: 'idle' });
      } catch (error) {
        logger.error({ err: error, ...agentLog(agentId) }, 'Poll error for agent');
        manager.updateState(agentId, 'error', error instanceof Error ? error.message : 'Poll failed');
        await this.emit({
          type: 'error',
          message: `Poll failed for ${agentName(agentId)}`,
          error: error instanceof Error ? error : undefined,
        });
      }
    }

    // Phase 2: Proactive discovery (for agents that are due)
    for (const agentId of manager.getAgentIds()) {
      const agent = manager.getRuntime(agentId);
      if (!agent || agent.config.enabled === false) {
        continue;
      }

      // Check if this agent should discover now
      if (!proactive.shouldDiscoverNow(agentId)) {
        continue;
      }

      try {
        manager.updateState(agentId, 'thinking');
        await this.emit({ type: 'agent_state_changed', agentId, state: 'thinking' });

        await proactive.runDiscovery(agentId);

        manager.updateState(agentId, 'idle');
        await this.emit({ type: 'agent_state_changed', agentId, state: 'idle' });
      } catch (error) {
        logger.error({ err: error, ...agentLog(agentId) }, 'Discovery error for agent');
        manager.updateState(agentId, 'error', error instanceof Error ? error.message : 'Discovery failed');
      }
    }

    // Phase 3: Execute queued actions
    let actionsExecuted = 0;
    while (actionsExecuted < this.config.maxActionsPerTick) {
      const action = await executor.getNextExecutableAction();
      if (!action) {
        break;
      }

      const agent = manager.getRuntime(action.agentId);
      if (agent) {
        manager.updateState(action.agentId, 'acting');
        await this.emit({ type: 'agent_state_changed', agentId: action.agentId, state: 'acting' });
      }

      await this.emit({ type: 'action_queued', action });

      const result = await executor.executeAction(action);

      if (result.success) {
        this.stats.actionsExecuted++;
        await this.emit({ type: 'action_executed', result });
      } else {
        this.stats.errorsCount++;
        await this.emit({ type: 'action_failed', actionId: action.id, error: result.error || 'Unknown' });
      }

      if (agent) {
        manager.updateState(action.agentId, 'cooldown');
        await this.emit({ type: 'agent_state_changed', agentId: action.agentId, state: 'cooldown' });
      }

      actionsExecuted++;
    }

    // Auto-scale cooldowns based on queue backlog
    const queueStats = executor.getQueueStats();
    const rateLimiter = getRateLimiter();
    const pending = queueStats.pending;
    let newScale: number;
    if (pending > 200) {
      newScale = 0.1;   // 10x faster — heavy backlog
    } else if (pending > 100) {
      newScale = 0.25;  // 4x faster — moderate backlog
    } else if (pending > 50) {
      newScale = 0.5;   // 2x faster — mild backlog
    } else {
      newScale = 1.0;   // normal — queue is healthy
    }
    if (rateLimiter.cooldownScale !== newScale) {
      logger.info(
        { pending, oldScale: rateLimiter.cooldownScale, newScale },
        `Cooldown auto-scale: ${rateLimiter.cooldownScale}x → ${newScale}x (${pending} pending)`
      );
      rateLimiter.setCooldownScale(newScale);
    }

    // Phase 4: Paper generation for NeuriCo agents
    for (const agentId of manager.getAgentIds()) {
      const agent = manager.getRuntime(agentId);
      if (!agent || !agent.config.enabled) continue;
      if (agent.config.capability === 'base') continue;

      const apiKey = manager.getApiKey(agentId);
      if (!apiKey) continue;

      const managerConfig: ManagerAgentConfig = {
        apiKey,
        agentId,
        capability: agent.config.capability,
        researchDomain: agent.config.researchDomain,
        llmApiKey: this.runtimeConfig.llm.apiKey,
        llmModel: this.runtimeConfig.llm.model,
        githubToken: process.env.GITHUB_TOKEN,
        githubOrg: process.env.GITHUB_ORG,
        neuricoPath: process.env.NEURICO_PATH,
        neuricoProvider: (process.env.NEURICO_PROVIDER as 'claude' | 'codex' | 'gemini') || undefined,
        preferredTopics: agent.config.persona?.preferredTopics,
      };

      try {
        const result = await tickPaperGeneration(managerConfig);
        if (result?.success) {
          this.stats.papersGenerated++;
          logger.info({ ...agentLog(agentId), title: result.title }, 'Paper generated and published');
          await this.emit({
            type: 'action_executed',
            result: {
              success: true,
              actionId: `paper-gen-${agentId}-${Date.now()}`,
            },
          });
        }
      } catch (error) {
        logger.error({ err: error, ...agentLog(agentId) }, 'Paper generation tick error');
      }
    }
  }

  /**
   * Handle a notification and queue appropriate action
   */
  private async handleNotification(
    agentId: string,
    notification: Agent4ScienceNotification
  ): Promise<void> {
    const manager = getAgentManager();
    const executor = getActionExecutor();
    const db = getDatabase();

    // Skip responding to notifications when posting is disabled
    // This prevents agents from creating comments/replies
    if (!this.runtimeConfig.proactive?.enablePosting) {
      logger.debug(`${agentName(agentId)} posting disabled - skipping notification response`);
      return;
    }

    // Determine the target ID for engagement tracking
    let targetId = notification.targetId;
    if (notification.type === 'reply' && notification.commentId) {
      targetId = notification.commentId; // Track engagement with the specific comment being replied to
    }
    if (!targetId) return;

    // Skip if already engaged with this content (deduplication)
    if (db.hasEngaged(agentId, targetId)) {
      logger.debug(`${agentName(agentId)} already engaged with ${targetId}, skipping notification response`);
      return;
    }

    manager.updateState(agentId, 'thinking');
    await this.emit({ type: 'agent_state_changed', agentId, state: 'thinking' });

    try {
      // For now, just queue a simple acknowledgment
      // TODO: Integrate LLM to generate contextual responses
      const response = await this.generateResponse(agentId, notification);

      if (response) {
        executor.queueFromNotification(notification, response);
        // Record engagement to prevent duplicate responses
        const contentType = notification.targetType === 'paper' ? 'paper'
          : notification.targetType === 'take' ? 'take'
          : 'comment';
        db.recordEngagement(agentId, targetId!, contentType, 'comment');
      }
    } catch (error) {
      logger.error({ err: error, ...agentLog(agentId) }, 'Failed to handle notification');
    }
  }

  /**
   * Generate a response to a notification using LLM
   */
  private async generateResponse(
    agentId: string,
    notification: Agent4ScienceNotification
  ): Promise<Record<string, unknown> | null> {
    const manager = getAgentManager();
    const client = getAgent4ScienceClient();
    const agent = manager.getRuntime(agentId);

    if (!agent) {
      return null;
    }

    const llm = getOrCreateLLMClient(agent.config.llmOverride);

    const persona = agent.config.persona;

    // For mentions, replies, and comments on own content — respond as author
    if (notification.type === 'mention' || notification.type === 'reply' || notification.type === 'comment') {
      logger.info(`${agentName(agentId)} responding to ${notification.type} from ${agentName(notification.fromAgentId || '')}`);

      try {
        // Determine the root content (paper/take) for broader context
        let parentContent: string | undefined;
        let targetContent = notification.message;
        let threadContext: string | undefined;
        let rootTitle: string | undefined;
        let rootType: string | undefined;

        const apiKey = manager.getApiKey(agentId);

        if (apiKey) {
          // Resolve the triggering comment ID — may come from commentId or targetId
          const commentId = notification.commentId ||
            (notification.targetType === 'comment' ? notification.targetId : undefined);

          // 1. Directly fetch the triggering comment to get its body and rootId
          let commentRootId: string | undefined;
          if (commentId) {
            try {
              const commentResult = await client.getComment(commentId, apiKey);
              if (commentResult.success && commentResult.data) {
                targetContent = commentResult.data.body || targetContent;
                commentRootId = commentResult.data.rootId;
              }
            } catch (commentErr) {
              logger.debug({ err: commentErr, ...agentLog(agentId), commentId }, 'Failed to fetch comment for notification');
            }
          }

          // 2. Fetch the root content (paper or take) for broader context
          const rootId = notification.paperId || notification.takeId ||
            (notification.targetType !== 'comment' ? notification.targetId : undefined) ||
            commentRootId;
          if (rootId) {
            if (notification.paperId || notification.targetType === 'paper') {
              const paperResult = await client.getPaper(notification.paperId || rootId, apiKey);
              if (paperResult.success && paperResult.data) {
                rootTitle = paperResult.data.title;
                rootType = 'paper';
                parentContent = `${paperResult.data.title}\n\n${paperResult.data.tldr || paperResult.data.abstract || ''}`;
              }
            } else if (notification.takeId || notification.targetType === 'take') {
              const takeResult = await client.getTake(notification.takeId || rootId, apiKey);
              if (takeResult.success && takeResult.data) {
                rootTitle = takeResult.data.title || takeResult.data.hotTake;
                rootType = 'take';
                parentContent = `${takeResult.data.title}\n\n${takeResult.data.hotTake || takeResult.data.summary?.join(' ') || ''}`;
              }
            } else if (commentRootId) {
              // Root type unknown — try paper first, then take
              const paperResult = await client.getPaper(commentRootId, apiKey);
              if (paperResult.success && paperResult.data) {
                rootTitle = paperResult.data.title;
                rootType = 'paper';
                parentContent = `${paperResult.data.title}\n\n${paperResult.data.tldr || paperResult.data.abstract || ''}`;
              } else {
                const takeResult = await client.getTake(commentRootId, apiKey);
                if (takeResult.success && takeResult.data) {
                  rootTitle = takeResult.data.title || takeResult.data.hotTake;
                  rootType = 'take';
                  parentContent = `${takeResult.data.title}\n\n${takeResult.data.hotTake || takeResult.data.summary?.join(' ') || ''}`;
                }
              }
            }

            // 3. Fetch thread — use for conversation chain AND as fallback when commentId is unknown
            try {
              const threadRootId = commentRootId || rootId;
              const threadResult = await client.getThread(threadRootId, apiKey);
              if (threadResult.success && threadResult.data) {
                const allComments = (threadResult.data as any).comments || [];

                // Resolve the triggering comment — exact match first, then heuristic
                let triggeringId = commentId;
                if (!triggeringId && notification.fromAgentId && allComments.length > 0) {
                  // Find the most recent comment from the sender, closest to notification time
                  const notifTime = new Date(notification.createdAt).getTime();
                  const candidate = (allComments as any[])
                    .filter((c: any) => c.agentId === notification.fromAgentId)
                    .sort((a: any, b: any) =>
                      Math.abs(new Date(a.createdAt).getTime() - notifTime) -
                      Math.abs(new Date(b.createdAt).getTime() - notifTime)
                    )[0];
                  if (candidate) {
                    triggeringId = candidate.id;
                    targetContent = candidate.body || targetContent;
                  }
                }

                // Build rich multi-agent conversation context
                if (triggeringId) {
                  const triggeringComment = allComments.find((c: any) => c.id === triggeringId);

                  // Parent chain (oldest first)
                  const chain: string[] = [];
                  let currentId: string | undefined = triggeringId;
                  let depth = 0;
                  while (currentId && depth < 5) {
                    const comment = allComments.find((c: any) => c.id === currentId);
                    if (!comment) break;
                    const handle = comment.agent?.handle || comment.agentId || 'Agent';
                    chain.unshift(`@${handle}: "${comment.body}"`);
                    currentId = comment.parentId || undefined;
                    depth++;
                  }

                  // Sibling comments — other replies to the same parent
                  const siblingContext: string[] = [];
                  if (triggeringComment?.parentId) {
                    const siblings = allComments.filter(
                      (c: any) => c.parentId === triggeringComment.parentId && c.id !== triggeringId
                    );
                    for (const sib of siblings.slice(0, 5)) {
                      const handle = sib.agent?.handle || sib.agentId || 'Agent';
                      siblingContext.push(`@${handle} (${sib.intent || 'comment'}): "${sib.body}"`);
                    }
                  }

                  // Participant map
                  const participants = new Map<string, { intent: string; count: number }>();
                  for (const c of allComments) {
                    const handle = c.agent?.handle || c.agentId || 'Agent';
                    const existing = participants.get(handle);
                    if (existing) {
                      existing.count++;
                    } else {
                      participants.set(handle, { intent: c.intent || 'comment', count: 1 });
                    }
                  }

                  // Assemble
                  let richContext = '';

                  if (participants.size > 1) {
                    richContext += `=== DISCUSSION PARTICIPANTS (${participants.size} researchers) ===\n`;
                    for (const [handle, info] of participants) {
                      richContext += `- @${handle}: ${info.count} comment${info.count > 1 ? 's' : ''}, last intent: ${info.intent}\n`;
                    }
                    richContext += '\n';
                  }

                  richContext += `=== CONVERSATION THREAD ===\n`;
                  richContext += chain.join('\n\n');

                  if (siblingContext.length > 0) {
                    richContext += `\n\n=== OTHER REPLIES IN THIS BRANCH (${siblingContext.length} other researchers also responded) ===\n`;
                    richContext += siblingContext.join('\n\n');
                  }

                  if (chain.length > 1 || siblingContext.length > 0) {
                    threadContext = richContext;
                  }
                }
              }
            } catch (threadErr) {
              logger.debug({ err: threadErr, ...agentLog(agentId), rootId }, 'Failed to fetch thread context for notification');
            }
          }

          if (!commentId && targetContent === notification.message) {
            logger.warn({ ...agentLog(agentId), notificationType: notification.type },
              'Notification missing commentId — responding with limited context');
          }
        }

        const triggerType = notification.type === 'mention' ? 'mention'
          : notification.type === 'comment' ? 'author_reply'
          : 'reply';

        logger.info({
          agentId,
          triggerType,
          rootTitle: rootTitle || '(unknown)',
          rootType: rootType || '(unknown)',
          from: notification.fromAgentId,
        }, `${agentName(agentId)} generating ${triggerType} on "${rootTitle || notification.targetId}"`)

        const response = await llm.generateComment(persona, {
          targetType: notification.commentId ? 'comment' : (notification.targetType === 'review' ? 'comment' : notification.targetType ?? 'comment') as 'paper' | 'take' | 'comment',
          targetContent,
          parentContent,
          threadContext,
          triggerType,
          fromAgent: notification.fromAgentId,
          rootTitle,
          rootType,
        });

        return {
          intent: response.intent,
          body: response.body,
          confidence: response.confidence,
          evidenceAnchor: response.evidenceAnchor,
        };
      } catch (error) {
        logger.error({ err: error, ...agentLog(agentId) }, 'Failed to generate response');
        return {
          intent: 'clarify',
          body: 'Interesting point! Let me think about this more.',
          confidence: 0.5,
        };
      }
    }

    // For take/review notifications (someone wrote a take/review on your paper) — optionally engage
    if (notification.type === 'take' || notification.type === 'review') {
      logger.debug(`${agentName(agentId)} evaluating ${notification.type}`);

      try {
        const apiKey = manager.getApiKey(agentId);
        if (!apiKey) return null;

        // Fetch content details
        let content: { type: 'paper' | 'take'; title: string; summary: string; tags: string[] } | null = null;

        if (notification.targetType === 'paper' && notification.targetId) {
          const paperResult = await client.getPaper(notification.targetId, apiKey);
          if (paperResult.success && paperResult.data) {
            content = {
              type: 'paper',
              title: paperResult.data.title,
              summary: paperResult.data.abstract || paperResult.data.tldr || '',
              tags: paperResult.data.tags || [],
            };
          }
        } else if (notification.targetType === 'take' && notification.targetId) {
          const takeResult = await client.getTake(notification.targetId, apiKey);
          if (takeResult.success && takeResult.data) {
            content = {
              type: 'take',
              title: takeResult.data.title,
              summary: takeResult.data.summary?.join(' ') || takeResult.data.hotTake || '',
              tags: [],
            };
          }
        }

        if (!content) return null;

        // Ask LLM whether to engage
        const decision = await llm.decideEngagement(persona, content);

        if (!decision.shouldEngage) {
          logger.debug(`${agentName(agentId)} decided not to engage: ${decision.reason}`);
          return null;
        }

        logger.info(`${agentName(agentId)} will ${decision.actionType} on ${notification.targetType}: ${decision.reason}`);

        // For now, just queue a comment. Future: support takes, votes
        if (decision.actionType === 'comment') {
          const response = await llm.generateComment(persona, {
            targetType: (notification.targetType === 'review' ? 'comment' : notification.targetType ?? 'comment') as 'paper' | 'take' | 'comment',
            targetContent: content.summary,
            triggerType: 'new_content',
          });

          return {
            intent: response.intent,
            body: response.body,
            confidence: response.confidence,
            evidenceAnchor: response.evidenceAnchor,
          };
        }

        return null;
      } catch (error) {
        logger.error({ err: error, ...agentLog(agentId) }, 'Failed to evaluate engagement');
        return null;
      }
    }

    return null;
  }

  /**
   * Health check - log status and recover from errors
   */
  private healthCheck(): void {
    const manager = getAgentManager();
    const executor = getActionExecutor();
    const poller = getNotificationPoller();

    const agentIds = manager.getAgentIds();
    const queueStats = executor.getQueueStats();

    logger.info({
      agents: agentIds.length,
      queuePending: queueStats.pending,
      queueCompleted: queueStats.completed,
      queueFailed: queueStats.failed,
    }, 'Health check');

    // Check for stuck agents and reset them
    for (const agentId of agentIds) {
      const agent = manager.getRuntime(agentId);
      if (agent && agent.state === 'error' && agent.errorCount < 3) {
        logger.info(`Resetting ${agentName(agentId)} from error state`);
        manager.updateState(agentId, 'idle');
        poller.resetAgent(agentId);
      }
    }
  }

  /**
   * Stop the event loop gracefully
   */
  async stop(): Promise<void> {
    if (!this.running) {
      logger.warn('Event loop not running');
      return;
    }

    logger.info('Stopping event loop...');
    this.shuttingDown = true;

    // Stop scheduling new ticks
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }

    // Stop health check
    if (this.healthCheckJob) {
      this.healthCheckJob.stop();
      this.healthCheckJob = null;
    }

    // Wait for current operations to complete (with timeout)
    const shutdownStart = Date.now();
    while (Date.now() - shutdownStart < this.config.shutdownTimeoutMs) {
      const manager = getAgentManager();
      const busyAgents = manager.getAgentIds().filter(id => {
        const agent = manager.getRuntime(id);
        return agent && ['polling', 'thinking', 'acting'].includes(agent.state);
      });

      if (busyAgents.length === 0) {
        break;
      }

      logger.info(`Waiting for ${busyAgents.length} agents to finish...`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Close database
    closeDatabase();

    this.running = false;
    logger.info('Event loop stopped');
  }

  /**
   * Check if running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get runtime statistics for CLI
   */
  getStats(): {
    startTime: Date;
    tickCount: number;
    actionsExecuted: number;
    errorsCount: number;
    papersGenerated: number;
  } {
    return { ...this.stats };
  }

  /**
   * Get runtime status
   */
  getStatus(): {
    running: boolean;
    agents: Array<{
      id: string;
      state: string;
      lastPoll: Date | null;
      lastAction: Date | null;
    }>;
    queue: { pending: number; completed: number; failed: number };
  } {
    const manager = getAgentManager();
    const executor = getActionExecutor();

    return {
      running: this.running,
      agents: manager.getAgentIds().map(id => {
        const agent = manager.getRuntime(id);
        return {
          id,
          state: agent?.state || 'unknown',
          lastPoll: agent?.lastPollTime || null,
          lastAction: agent?.lastActionTime || null,
        };
      }),
      queue: executor.getQueueStats(),
    };
  }
}

// Singleton
let instance: EventLoop | null = null;

export function createEventLoop(configOrPath?: RuntimeConfig | string): EventLoop {
  const config = typeof configOrPath === 'string' || configOrPath === undefined
    ? loadConfig(configOrPath)
    : configOrPath;
  instance = new EventLoop(config);
  return instance;
}

export function getEventLoop(): EventLoop | null {
  return instance;
}
