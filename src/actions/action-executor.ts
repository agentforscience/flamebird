/**
 * Action Executor
 * Executes queued actions (comments, votes, takes, papers) against Agent4Science API
 */

import { nanoid } from 'nanoid';
import type {
  QueuedAction,
  ActionResult,
  ActionType,
  ActionPriority,
  Agent4ScienceNotification,
  CommentIntent,
} from '../types.js';
import { getAgent4ScienceClient } from '../api/agent4science-client.js';
import { smartTruncate } from '../utils/truncate.js';
import { getAgentManager } from '../agents/agent-manager.js';
import { getDatabase } from '../db/database.js';
import { getRateLimiter } from '../rate-limit/rate-limiter.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('executor');

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

export interface ActionExecutorConfig {
  maxRetries: number;
  retryDelayMs: number;
  retryBackoffMultiplier: number;
}

export const DEFAULT_EXECUTOR_CONFIG: ActionExecutorConfig = {
  maxRetries: 3,
  retryDelayMs: 5000,
  retryBackoffMultiplier: 2,
};

export class ActionExecutor {
  private config: ActionExecutorConfig;

  constructor(config: ActionExecutorConfig = DEFAULT_EXECUTOR_CONFIG) {
    this.config = config;
  }

  /**
   * Queue an action for execution
   */
  queueAction(
    agentId: string,
    type: ActionType,
    targetId: string,
    targetType: 'paper' | 'take' | 'comment' | 'agent' | 'review' | 'challenge' | 'submission',
    payload: Record<string, unknown>,
    priority: ActionPriority = 'normal'
  ): QueuedAction {
    const action: QueuedAction = {
      id: `action_${nanoid(12)}`,
      agentId,
      type,
      targetId,
      targetType,
      priority,
      payload,
      createdAt: new Date(),
      executeAfter: new Date(),
      attempts: 0,
      maxAttempts: this.config.maxRetries,
    };

    const db = getDatabase();
    db.queueAction(action);

    logger.info(`Queued ${type} for ${agentName(agentId)} -> ${targetType}:${targetId}`);

    return action;
  }

  /**
   * Queue action from a notification
   */
  queueFromNotification(
    notification: Agent4ScienceNotification,
    responsePayload: Record<string, unknown>
  ): QueuedAction {
    // Determine action type and target from notification
    let actionType: ActionType = 'comment';
    let targetType: 'paper' | 'take' | 'comment' | 'agent' | 'review' | 'challenge' | 'submission' = 'comment';
    let targetId = notification.targetId;

    // For reply/comment/mention notifications with a commentId, thread the response
    // as a reply to that comment. Route to the root content (paper/take/review/challenge/submission)
    // because comment API endpoints live under those resources.
    if ((notification.type === 'reply' || notification.type === 'comment' || notification.type === 'mention')
        && notification.commentId) {
      // Include parentId so the comment is threaded as a reply
      responsePayload = {
        ...responsePayload,
        parentId: notification.commentId,
      } as Record<string, unknown>;

      // Route to the root content type
      if (notification.submissionId) {
        targetType = 'submission';
        targetId = notification.submissionId;
      } else if (notification.paperId) {
        targetType = 'paper';
        targetId = notification.paperId;
      } else if (notification.takeId) {
        targetType = 'take';
        targetId = notification.takeId;
      } else if (notification.reviewId) {
        targetType = 'review';
        targetId = notification.reviewId;
      } else if (notification.targetType === 'paper' && notification.targetId) {
        targetType = 'paper';
        targetId = notification.targetId;
      } else if (notification.targetType === 'take' && notification.targetId) {
        targetType = 'take';
        targetId = notification.targetId;
      } else if (notification.targetType === 'review' && notification.targetId) {
        targetType = 'review';
        targetId = notification.targetId;
      } else if (notification.targetType === 'submission' && notification.targetId) {
        targetType = 'submission';
        targetId = notification.targetId;
      } else {
        targetType = (notification.targetType as typeof targetType) ?? 'paper';
      }
    } else if (notification.targetType === 'paper') {
      targetType = 'paper';
    } else if (notification.targetType === 'take') {
      targetType = 'take';
    } else if (notification.targetType === 'review') {
      targetType = 'review';
    } else if (notification.targetType === 'challenge') {
      targetType = 'challenge';
    } else if (notification.targetType === 'submission') {
      targetType = 'submission';
    }

    // Priority based on notification type
    let priority: ActionPriority = 'normal';
    if (notification.type === 'mention') {
      priority = 'high';
    } else if (notification.type === 'reply') {
      priority = 'high';
    }

    return this.queueAction(
      notification.agentId,
      actionType,
      targetId ?? '',
      targetType,
      {
        ...responsePayload,
        notificationId: notification.id,
        notificationType: notification.type,
      },
      priority
    );
  }

  /**
   * Get the next action to execute (respecting rate limits)
   * Loops through pending actions until it finds one that can be executed
   */
  async getNextExecutableAction(): Promise<QueuedAction | null> {
    const db = getDatabase();
    const rateLimiter = getRateLimiter();

    // Try up to 50 actions to find one that's not rate limited
    const maxAttempts = 50;
    for (let i = 0; i < maxAttempts; i++) {
      // Get next pending action from queue
      const action = db.getNextAction();
      if (!action) {
        return null;
      }

      // Check if rate limit allows this action
      if (rateLimiter.canPerform(action.agentId, action.type)) {
        return action;
      }

      // Rate limited - reschedule this action and try the next one
      const waitTime = rateLimiter.getTimeUntilAllowed(action.agentId, action.type);
      const newExecuteAfter = new Date(Date.now() + waitTime);

      logger.debug(`Rate limited: ${action.type} for ${agentName(action.agentId)}, retry in ${waitTime}ms`);

      db.rescheduleAction(
        action.id,
        `Rate limited, waiting ${Math.round(waitTime / 1000)}s`,
        newExecuteAfter
      );
      // Continue to try the next action in queue
    }

    logger.debug('No executable actions found after checking queue');
    return null;
  }

  /**
   * Execute a single action
   */
  async executeAction(action: QueuedAction): Promise<ActionResult> {
    const manager = getAgentManager();
    const apiKey = manager.getApiKey(action.agentId);

    if (!apiKey) {
      return {
        success: false,
        actionId: action.id,
        error: 'No API key for agent',
      };
    }

    const client = getAgent4ScienceClient();
    const rateLimiter = getRateLimiter();
    const db = getDatabase();

    try {
      // Consume rate limit token
      if (!rateLimiter.tryConsume(action.agentId, action.type)) {
        throw new Error('Rate limit exceeded');
      }

      let result: ActionResult;

      switch (action.type) {
        case 'comment':
          result = await this.executeComment(action, apiKey, client);
          break;
        case 'vote':
          result = await this.executeVote(action, apiKey, client);
          break;
        case 'take':
          result = await this.executeTake(action, apiKey, client);
          break;
        case 'review':
          result = await this.executeReview(action, apiKey, client);
          break;
        case 'follow':
          result = await this.executeFollow(action, apiKey, client);
          break;
        case 'paper':
          result = await this.executePaper(action, apiKey, client);
          break;
        case 'submission':
          result = await this.executeSubmission(action, apiKey, client);
          break;
        default:
          result = {
            success: false,
            actionId: action.id,
            error: `Unknown action type: ${action.type}`,
          };
      }

      if (result.success) {
        db.markActionComplete(action.id);
        manager.recordAction(action.agentId);

        // Log audit
        db.logAction(
          action.agentId,
          action.type,
          action.targetId,
          action.targetType,
          true,
          undefined,
          action.payload
        );

        logger.info(`Executed ${action.type}: ${agentName(action.agentId)} -> ${action.targetId}`);
      } else {
        throw new Error(result.error || 'Action failed');
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Don't retry on permanent errors (resource deleted, not found, policy violations, etc.)
      const isPermanent = /not found|you follow|your own|duplicate|self.review|self.take/i.test(errorMessage);
      const shouldRetry = !isPermanent && action.attempts < action.maxAttempts;

      if (shouldRetry) {
        const delay = this.config.retryDelayMs * Math.pow(this.config.retryBackoffMultiplier, action.attempts);
        const retryAfter = new Date(Date.now() + delay);

        db.markActionFailed(action.id, errorMessage, retryAfter);
        logger.warn(`Action ${action.id} failed (attempt ${action.attempts + 1}/${action.maxAttempts}): ${errorMessage}`);
      } else {
        db.markActionFailed(action.id, errorMessage);
        logger.error(`Action ${action.id} permanently failed: ${errorMessage}`);

        // Log audit
        db.logAction(
          action.agentId,
          action.type,
          action.targetId,
          action.targetType,
          false,
          errorMessage,
          action.payload
        );
      }

      return {
        success: false,
        actionId: action.id,
        error: errorMessage,
      };
    }
  }

  /**
   * Execute a comment action
   */
  private async executeComment(
    action: QueuedAction,
    apiKey: string,
    client: ReturnType<typeof getAgent4ScienceClient>
  ): Promise<ActionResult> {
    const { body, intent, parentId, evidenceAnchor, confidence } = action.payload as {
      body: string;
      intent: CommentIntent;
      parentId?: string;
      evidenceAnchor?: string;
      confidence?: number;
    };

    let result;
    if (action.targetType === 'paper') {
      result = await client.commentOnPaper(
        action.targetId,
        { intent, body, evidenceAnchor, confidence, parentId },
        apiKey
      );
    } else if (action.targetType === 'take') {
      result = await client.commentOnTake(
        action.targetId,
        { intent, body, evidenceAnchor, confidence, parentId },
        apiKey
      );
    } else if (action.targetType === 'review') {
      // 'review' targetType: comment on a peer review
      result = await client.commentOnReview(
        action.targetId,
        { intent, body, evidenceAnchor, confidence, parentId },
        apiKey
      );
    } else if (action.targetType === 'submission') {
      result = await client.commentOnSubmission(
        action.targetId,
        { intent, body, evidenceAnchor, confidence, parentId },
        apiKey
      );
    } else {
      return {
        success: false,
        actionId: action.id,
        error: `Cannot comment on ${action.targetType}`,
      };
    }

    if (!result.success) {
      return {
        success: false,
        actionId: action.id,
        error: result.error,
      };
    }

    return {
      success: true,
      actionId: action.id,
      responseId: result.data?.id,
    };
  }

  /**
   * Execute a vote action
   */
  private async executeVote(
    action: QueuedAction,
    apiKey: string,
    client: ReturnType<typeof getAgent4ScienceClient>
  ): Promise<ActionResult> {
    const { direction } = action.payload as { direction: 'up' | 'down' };

    if (action.targetType !== 'paper' && action.targetType !== 'take' && action.targetType !== 'review' && action.targetType !== 'submission') {
      return {
        success: false,
        actionId: action.id,
        error: `Cannot vote on ${action.targetType}`,
      };
    }

    let result;
    if (action.targetType === 'paper') {
      result = await client.votePaper(action.targetId, { direction }, apiKey);
    } else if (action.targetType === 'take') {
      result = await client.voteTake(action.targetId, { direction }, apiKey);
    } else if (action.targetType === 'submission') {
      result = await client.voteSubmission(action.targetId, { direction }, apiKey);
    } else {
      result = await client.voteReview(action.targetId, { direction }, apiKey);
    }

    if (!result.success) {
      return { success: false, actionId: action.id, error: result.error };
    }
    return { success: true, actionId: action.id };
  }

  /**
   * Execute a take (peer review) action
   * Supports both paper-linked takes (targetType === 'paper') and standalone takes (targetType === 'take')
   */
  private async executeTake(
    action: QueuedAction,
    apiKey: string,
    client: ReturnType<typeof getAgent4ScienceClient>
  ): Promise<ActionResult> {
    const takeData = action.payload as {
      title: string;
      stance: 'hot' | 'neutral' | 'skeptical' | 'hype' | 'critical';
      summary: string[];
      critique: string[];
      whoShouldCare: string;
      openQuestions: string[];
      hotTake: string;
      tags?: string[];
      sciencesub?: string;
    };

    // Standalone takes use targetType 'take' with a synthetic targetId
    const isStandalone = action.targetType === 'take';

    if (action.targetType !== 'paper' && !isStandalone) {
      return {
        success: false,
        actionId: action.id,
        error: 'Takes can only be written on papers or as standalone',
      };
    }

    // Validate tags before sending — server requires at least one valid tag
    if (!takeData.tags || !Array.isArray(takeData.tags) || takeData.tags.length === 0) {
      return {
        success: false,
        actionId: action.id,
        error: 'Take has no valid tags — server requires at least one sciencesub tag',
      };
    }

    const result = await client.createTake(
      {
        // Only include paperId for paper-linked takes
        ...(isStandalone ? {} : { paperId: action.targetId }),
        title: takeData.title,
        stance: takeData.stance,
        summary: takeData.summary,
        critique: takeData.critique,
        whoShouldCare: takeData.whoShouldCare,
        openQuestions: takeData.openQuestions,
        hotTake: takeData.hotTake,
        ...(takeData.tags ? { tags: takeData.tags } : {}),
      },
      apiKey
    );

    if (!result.success) {
      return {
        success: false,
        actionId: action.id,
        error: result.error,
      };
    }

    return {
      success: true,
      actionId: action.id,
      responseId: result.data?.id,
    };
  }

  /**
   * Execute a peer review action
   */
  private async executeReview(
    action: QueuedAction,
    apiKey: string,
    client: ReturnType<typeof getAgent4ScienceClient>
  ): Promise<ActionResult> {
    const reviewData = action.payload as {
      paperId: string;
      title: string;
      paperUrl: string;
      summary: string;
      strengths: string[];
      weaknesses: string[];
      suggestions?: string;
    };

    const result = await client.createReview(reviewData, apiKey);

    if (!result.success) {
      return { success: false, actionId: action.id, error: result.error };
    }
    return {
      success: true,
      actionId: action.id,
      responseId: (result.data as { id?: string })?.id,
    };
  }

  /**
   * Execute a follow action
   */
  private async executeFollow(
    action: QueuedAction,
    apiKey: string,
    client: ReturnType<typeof getAgent4ScienceClient>
  ): Promise<ActionResult> {
    if (action.targetType !== 'agent') {
      return {
        success: false,
        actionId: action.id,
        error: 'Follow only works on agents',
      };
    }

    const result = await client.followAgent(action.targetId, apiKey);

    if (!result.success) {
      return {
        success: false,
        actionId: action.id,
        error: result.error,
      };
    }

    return {
      success: true,
      actionId: action.id,
    };
  }

  /**
   * Execute a paper creation action
   */
  private async executePaper(
    action: QueuedAction,
    apiKey: string,
    client: ReturnType<typeof getAgent4ScienceClient>
  ): Promise<ActionResult> {
    const paperData = action.payload as {
      title: string;
      abstract: string;
      tldr: string;
      hypothesis?: string;
      experimentPlan?: string;
      conclusion?: string;
      tags: string[];
      claims: string[];
      limitations?: string[];
      githubUrl?: string;
      pdfUrl?: string;
      inspirations?: Array<{ title: string; arxivId?: string; url?: string; note?: string }>;
      sciencesub?: string;
    };

    // Validate required URLs before attempting paper creation
    const githubUrl = paperData.githubUrl;
    const pdfUrl = paperData.pdfUrl;

    if (!githubUrl || !githubUrl.startsWith('https://')) {
      return {
        success: false,
        actionId: action.id,
        error: `Cannot create paper without valid githubUrl (got: ${githubUrl || 'empty'})`,
      };
    }

    if (!pdfUrl || !pdfUrl.startsWith('https://')) {
      return {
        success: false,
        actionId: action.id,
        error: `Cannot create paper without valid pdfUrl (got: ${pdfUrl || 'empty'})`,
      };
    }

    const paperPayload: Parameters<typeof client.createPaper>[0] = {
      title: paperData.title,
      abstract: paperData.abstract,
      tldr: (paperData.tldr && paperData.tldr.length >= 30) ? smartTruncate(paperData.tldr, 1000) : smartTruncate(`${paperData.tldr || paperData.title}. ${paperData.abstract || 'This work investigates novel approaches and proposes techniques that could advance the state of the art in the field.'}`, 1000),
      hypothesis: paperData.hypothesis ?? paperData.claims?.[0] ?? 'This work investigates a novel approach',
      experimentPlan: paperData.experimentPlan,
      conclusion: paperData.conclusion ?? 'Results demonstrate the validity of the proposed approach',
      tags: paperData.tags,
      claims: paperData.claims,
      githubUrl,
      pdfUrl,
      limitations: paperData.limitations,
      inspirations: paperData.inspirations,
    };

    const result = await client.createPaper(paperPayload, apiKey);

    if (!result.success) {
      return {
        success: false,
        actionId: action.id,
        error: result.error,
      };
    }

    logger.info(`Created paper: ${result.data?.id} - ${paperData.title}`);

    return {
      success: true,
      actionId: action.id,
      responseId: result.data?.id,
    };
  }

  /**
   * Execute a submission action (challenge solution)
   */
  private async executeSubmission(
    action: QueuedAction,
    apiKey: string,
    client: ReturnType<typeof getAgent4ScienceClient>
  ): Promise<ActionResult> {
    const submissionData = action.payload as {
      title: string;
      body: string;
      approach: string;
      improvesUpon?: string;
      delta?: string;
      declaredScore?: number;
      solutionData?: Record<string, unknown>;
    };

    // targetId is the challengeId
    const result = await client.createSubmission(
      action.targetId,
      submissionData,
      apiKey
    );

    if (!result.success) {
      return { success: false, actionId: action.id, error: result.error };
    }

    const submissionId = result.data?.id;
    logger.info(`Created submission: ${submissionId} for challenge ${action.targetId}`);

    // Trigger server-side evaluation (T1 gates + T2 peer signal)
    if (submissionId) {
      try {
        const evalResult = await client.evaluateSubmission(submissionId, apiKey);
        if (evalResult.success) {
          const evalData = evalResult.data?.submission;
          logger.info({
            submissionId,
            evaluationStatus: evalData?.evaluationStatus,
            t1Valid: evalData?.t1Result?.valid,
            evaluatedScore: evalData?.evaluatedScore,
          }, 'Submission evaluated');
        } else {
          logger.warn({ submissionId, error: evalResult.error }, 'Evaluation request failed (submission still created)');
        }
      } catch (evalErr) {
        logger.warn({ submissionId, error: String(evalErr) }, 'Evaluation trigger failed (submission still created)');
      }
    }

    return {
      success: true,
      actionId: action.id,
      responseId: submissionId,
    };
  }

  /**
   * Process all pending actions
   */
  async processQueue(): Promise<number> {
    let processed = 0;

    while (true) {
      const action = await this.getNextExecutableAction();
      if (!action) {
        break;
      }

      await this.executeAction(action);
      processed++;

      // Small delay between actions to be nice to the API
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return processed;
  }

  /**
   * Get queue statistics
   */
  getQueueStats(): { pending: number; completed: number; failed: number } {
    const db = getDatabase();
    return db.getQueueStats();
  }
}

// Singleton
let instance: ActionExecutor | null = null;

export function createActionExecutor(config?: ActionExecutorConfig): ActionExecutor {
  instance = new ActionExecutor(config);
  return instance;
}

export function getActionExecutor(): ActionExecutor {
  if (!instance) {
    instance = new ActionExecutor();
  }
  return instance;
}
