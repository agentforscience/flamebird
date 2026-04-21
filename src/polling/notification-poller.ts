/**
 * Notification Poller
 * Smart polling with exponential backoff for Agent4Science notifications
 */

import type { Agent4ScienceNotification } from '../types.js';
import { getAgent4ScienceClient } from '../api/agent4science-client.js';
import { getAgentManager } from '../agents/agent-manager.js';
import { getDatabase } from '../db/database.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('poller');

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

export interface PollerConfig {
  baseIntervalMs: number;      // Starting interval (e.g., 30s)
  maxIntervalMs: number;       // Maximum backoff (e.g., 5min)
  backoffMultiplier: number;   // How much to increase on no activity (e.g., 1.5)
  jitterPercent: number;       // Random jitter to prevent thundering herd (e.g., 0.1)
}

export const DEFAULT_POLLER_CONFIG: PollerConfig = {
  baseIntervalMs: 120_000,     // 2 minutes
  maxIntervalMs: 600_000,      // 10 minutes
  backoffMultiplier: 1.5,
  jitterPercent: 0.1,
};

interface AgentPollState {
  agentId: string;
  currentIntervalMs: number;
  lastPollTime: Date | null;
  consecutiveEmptyPolls: number;
}

export class NotificationPoller {
  private config: PollerConfig;
  private agentStates: Map<string, AgentPollState> = new Map();

  constructor(config: PollerConfig = DEFAULT_POLLER_CONFIG) {
    this.config = config;
  }

  /**
   * Initialize poll state for an agent
   */
  initAgent(agentId: string): void {
    if (!this.agentStates.has(agentId)) {
      this.agentStates.set(agentId, {
        agentId,
        currentIntervalMs: this.config.baseIntervalMs,
        lastPollTime: null,
        consecutiveEmptyPolls: 0,
      });
    }
  }

  /**
   * Remove an agent from polling
   */
  removeAgent(agentId: string): void {
    this.agentStates.delete(agentId);
  }

  /**
   * Calculate next poll time with jitter
   */
  private getNextPollDelay(state: AgentPollState): number {
    const jitter = (Math.random() - 0.5) * 2 * this.config.jitterPercent * state.currentIntervalMs;
    return Math.max(1000, state.currentIntervalMs + jitter);
  }

  /**
   * Adjust interval based on poll results
   */
  private adjustInterval(state: AgentPollState, hasNotifications: boolean): void {
    if (hasNotifications) {
      // Activity detected - reset to base interval
      state.currentIntervalMs = this.config.baseIntervalMs;
      state.consecutiveEmptyPolls = 0;
      logger.debug(`${agentName(state.agentId)}: Activity detected, reset to ${state.currentIntervalMs}ms`);
    } else {
      // No activity - increase interval (backoff)
      state.consecutiveEmptyPolls++;
      state.currentIntervalMs = Math.min(
        state.currentIntervalMs * this.config.backoffMultiplier,
        this.config.maxIntervalMs
      );
      logger.debug(`${agentName(state.agentId)}: No activity (${state.consecutiveEmptyPolls}x), backoff to ${state.currentIntervalMs}ms`);
    }
  }

  /**
   * Poll notifications for a single agent
   */
  async pollAgent(agentId: string): Promise<Agent4ScienceNotification[]> {
    const manager = getAgentManager();
    const apiKey = manager.getApiKey(agentId);

    if (!apiKey) {
      logger.warn(`No API key for ${agentName(agentId)}`);
      return [];
    }

    let state = this.agentStates.get(agentId);
    if (!state) {
      this.initAgent(agentId);
      state = this.agentStates.get(agentId)!;
    }

    const client = getAgent4ScienceClient();
    const db = getDatabase();

    try {
      // Poll since last poll time
      const result = await client.getNotifications(apiKey, state.lastPollTime ?? undefined);

      if (!result.success || !result.data) {
        logger.error(`Failed to poll notifications for ${agentName(agentId)}: ${result.error}`);
        // Still update state to prevent tight retry loop
        state.lastPollTime = new Date();
        this.adjustInterval(state, false);
        return [];
      }

      const notifications = result.data;

      // Filter out already processed notifications
      const newNotifications = notifications.filter(
        n => !db.isNotificationProcessed(n.id)
      );

      // Mark all fetched notifications as read on the server after every GET
      if (notifications.length > 0) {
        client.markNotificationsRead(apiKey, { markAllRead: true }).catch(err => {
          logger.warn({ err, ...agentLog(agentId) }, 'Failed to mark notifications as read');
        });
      }

      // Update state
      state.lastPollTime = new Date();
      this.adjustInterval(state, newNotifications.length > 0);

      // Record poll in agent manager
      manager.recordPoll(agentId);

      if (newNotifications.length > 0) {
        logger.info(`${agentName(agentId)}: Received ${newNotifications.length} new notifications`);
      }

      return newNotifications;
    } catch (error) {
      logger.error({ err: error, ...agentLog(agentId) }, 'Poll error for agent');
      // Apply backoff on error to prevent tight retry loop
      state.lastPollTime = new Date();
      state.currentIntervalMs = Math.min(
        state.currentIntervalMs * this.config.backoffMultiplier,
        this.config.maxIntervalMs
      );
      return [];
    }
  }

  /**
   * Mark a notification as processed
   */
  markProcessed(notificationId: string, agentId: string): void {
    const db = getDatabase();
    db.markNotificationProcessed(notificationId, agentId);
  }

  /**
   * Get time until next poll for an agent (in ms)
   */
  getTimeUntilNextPoll(agentId: string): number {
    const state = this.agentStates.get(agentId);
    if (!state || !state.lastPollTime) {
      return 0; // Poll immediately
    }

    const elapsed = Date.now() - state.lastPollTime.getTime();
    const delay = this.getNextPollDelay(state);
    return Math.max(0, delay - elapsed);
  }

  /**
   * Check if agent should poll now
   */
  shouldPollNow(agentId: string): boolean {
    return this.getTimeUntilNextPoll(agentId) <= 0;
  }

  /**
   * Get polling status for all agents
   */
  getStatus(): Array<{
    agentId: string;
    currentIntervalMs: number;
    lastPollTime: Date | null;
    consecutiveEmptyPolls: number;
    nextPollIn: number;
  }> {
    return Array.from(this.agentStates.values()).map(state => ({
      agentId: state.agentId,
      currentIntervalMs: state.currentIntervalMs,
      lastPollTime: state.lastPollTime,
      consecutiveEmptyPolls: state.consecutiveEmptyPolls,
      nextPollIn: this.getTimeUntilNextPoll(state.agentId),
    }));
  }

  /**
   * Reset polling state for an agent (e.g., after error recovery)
   */
  resetAgent(agentId: string): void {
    const state = this.agentStates.get(agentId);
    if (state) {
      state.currentIntervalMs = this.config.baseIntervalMs;
      state.consecutiveEmptyPolls = 0;
      state.lastPollTime = null;
    }
  }

  /**
   * Force immediate poll (resets backoff)
   */
  forceImmediatePoll(agentId: string): void {
    const state = this.agentStates.get(agentId);
    if (state) {
      state.lastPollTime = null;
      state.currentIntervalMs = this.config.baseIntervalMs;
    }
  }
}

// Singleton
let instance: NotificationPoller | null = null;

export function createNotificationPoller(config?: PollerConfig): NotificationPoller {
  instance = new NotificationPoller(config);
  return instance;
}

export function getNotificationPoller(): NotificationPoller {
  if (!instance) {
    instance = new NotificationPoller();
  }
  return instance;
}
