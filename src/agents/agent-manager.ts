/**
 * Agent Manager
 * Manages the lifecycle of multiple AI agents in the runtime
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type {
  AgentCapability,
  AgentConfig,
  AgentRuntime,
  AgentState,
  Agent4ScienceAgent,
} from '../types.js';
import { getDatabase } from '../db/database.js';
import { getAgent4ScienceClient } from '../api/agent4science-client.js';
import { getRateLimiter } from '../rate-limit/rate-limiter.js';
import { createLogger } from '../logging/logger.js';
import { getFlamebirdHome } from '../config/config.js';

const logger = createLogger('agent-manager');

// Simple encryption for API keys (in production, use a proper KMS)
// This just provides basic obfuscation - not true encryption
export function encryptApiKey(apiKey: string, encryptionKey: string): string {
  const keyBytes = Buffer.from(encryptionKey.slice(0, 32).padEnd(32, '0'));
  const apiBytes = Buffer.from(apiKey);
  const encrypted = Buffer.alloc(apiBytes.length);

  for (let i = 0; i < apiBytes.length; i++) {
    encrypted[i] = apiBytes[i] ^ keyBytes[i % keyBytes.length];
  }

  return encrypted.toString('base64');
}

export function decryptApiKey(encrypted: string, encryptionKey: string): string {
  const keyBytes = Buffer.from(encryptionKey.slice(0, 32).padEnd(32, '0'));
  const encryptedBytes = Buffer.from(encrypted, 'base64');
  const decrypted = Buffer.alloc(encryptedBytes.length);

  for (let i = 0; i < encryptedBytes.length; i++) {
    decrypted[i] = encryptedBytes[i] ^ keyBytes[i % keyBytes.length];
  }

  return decrypted.toString();
}

export class AgentManager {
  private agents: Map<string, AgentRuntime> = new Map();
  private encryptionKey: string;
  private apiKeys: Map<string, string> = new Map(); // Decrypted keys in memory

  constructor(encryptionKey: string) {
    this.encryptionKey = encryptionKey;
  }

  /**
   * Load all enabled agents from database
   */
  async loadAgents(): Promise<void> {
    const db = getDatabase();
    const agentRecords = db.getAllAgents();

    for (const record of agentRecords) {
      const apiKey = decryptApiKey(record.apiKeyEncrypted, this.encryptionKey);

      // Verify the API key is still valid with Agent4Science
      const client = getAgent4ScienceClient();
      const result = await client.getMe(apiKey);

      if (!result.success) {
        logger.warn(`Agent ${record.handle} has invalid API key, skipping`);
        continue;
      }

      // Load custom persona markdown if it exists
      const personaMdPath = join(getFlamebirdHome(), 'agents', record.handle, 'persona.md');
      if (existsSync(personaMdPath)) {
        try {
          record.persona.customPersonaMarkdown = readFileSync(personaMdPath, 'utf-8');
          logger.info({ handle: record.handle }, 'Loaded custom persona.md');
        } catch (err) {
          logger.warn({ handle: record.handle, error: err }, 'Failed to read persona.md');
        }
      }

      const runtime: AgentRuntime = {
        config: {
          id: record.id,
          handle: record.handle,
          displayName: record.displayName,
          persona: record.persona,
          capability: record.capability || 'base',
          researchDomain: record.researchDomain,
          enabled: record.enabled,
          createdAt: record.createdAt,
        },
        state: 'idle',
        lastPollTime: null,
        lastActionTime: null,
        errorCount: 0,
        lastError: null,
      };

      this.agents.set(record.id, runtime);
      this.apiKeys.set(record.id, apiKey);

      logger.info(`Loaded agent: @${record.handle}`);
    }

    logger.info(`Loaded ${this.agents.size} agents`);
  }

  /**
   * Add a new agent to the runtime
   */
  async addAgent(
    apiKey: string,
    options?: { enabled?: boolean; capability?: AgentCapability; researchDomain?: string }
  ): Promise<AgentConfig> {
    const client = getAgent4ScienceClient();

    // Verify the API key and get agent info
    const result = await client.getMe(apiKey);

    if (!result.success || !result.data) {
      throw new Error(`Invalid API key: ${result.error}`);
    }

    const remoteAgent = result.data as Agent4ScienceAgent;

    // Check if agent already exists
    const db = getDatabase();
    const existing = db.getAgentByHandle(remoteAgent.handle);

    if (existing) {
      throw new Error(`Agent @${remoteAgent.handle} already exists in runtime`);
    }

    // Create agent config
    const config: AgentConfig = {
      id: remoteAgent.id,
      handle: remoteAgent.handle,
      displayName: remoteAgent.displayName,
      persona: remoteAgent.persona,
      capability: options?.capability ?? 'base',
      researchDomain: options?.researchDomain,
      enabled: options?.enabled ?? true,
      createdAt: new Date(),
    };

    // Encrypt and store
    const encryptedKey = encryptApiKey(apiKey, this.encryptionKey);
    db.addAgent(config, encryptedKey);

    // Add to runtime
    const runtime: AgentRuntime = {
      config,
      state: 'idle',
      lastPollTime: null,
      lastActionTime: null,
      errorCount: 0,
      lastError: null,
    };

    this.agents.set(config.id, runtime);
    this.apiKeys.set(config.id, apiKey);

    logger.info(`Added agent: @${config.handle}`);

    return config;
  }

  /**
   * Remove an agent from the runtime
   */
  removeAgent(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const db = getDatabase();
    db.deleteAgent(agentId);

    this.agents.delete(agentId);
    this.apiKeys.delete(agentId);

    // Clear rate limit state
    getRateLimiter().resetAgent(agentId);

    logger.info(`Removed agent: @${agent.config.handle}`);
  }

  /**
   * Enable/disable an agent
   */
  setAgentEnabled(agentId: string, enabled: boolean): void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const db = getDatabase();
    db.updateAgentEnabled(agentId, enabled);
    agent.config.enabled = enabled;

    logger.info(`Agent @${agent.config.handle} ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Get all agents
   */
  getAgents(): AgentRuntime[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get enabled agents only
   */
  getEnabledAgents(): AgentRuntime[] {
    return Array.from(this.agents.values()).filter(a => a.config.enabled);
  }

  /**
   * Get an agent by ID
   */
  getAgent(agentId: string): AgentRuntime | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Alias for getAgent (for compatibility)
   */
  getRuntime(agentId: string): AgentRuntime | undefined {
    return this.getAgent(agentId);
  }

  /**
   * Get all agent IDs
   */
  getAgentIds(): string[] {
    return Array.from(this.agents.keys());
  }

  /**
   * Get an agent's API key
   */
  getApiKey(agentId: string): string | undefined {
    return this.apiKeys.get(agentId);
  }

  /**
   * Update agent state
   */
  updateState(agentId: string, state: AgentState, error?: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    agent.state = state;

    if (error) {
      agent.errorCount++;
      agent.lastError = error;
    } else if (state === 'idle') {
      // Reset error count on successful cycle
      agent.errorCount = 0;
      agent.lastError = null;
    }

    const db = getDatabase();
    db.updateAgentState(agentId, state, {
      errorCount: agent.errorCount,
      lastError: error ?? null,
    });
  }

  /**
   * Record that agent polled for notifications
   */
  recordPoll(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    agent.lastPollTime = new Date();

    const db = getDatabase();
    db.updateAgentState(agentId, agent.state, {
      lastPollTime: agent.lastPollTime,
    });
  }

  /**
   * Record that agent took an action
   */
  recordAction(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    agent.lastActionTime = new Date();

    const db = getDatabase();
    db.updateAgentState(agentId, agent.state, {
      lastActionTime: agent.lastActionTime,
    });
  }

  /**
   * Get status summary for all agents
   */
  getStatus(): {
    total: number;
    enabled: number;
    idle: number;
    active: number;
    errored: number;
    agents: Array<{
      id: string;
      handle: string;
      state: AgentState;
      enabled: boolean;
      errorCount: number;
      lastPollTime: Date | null;
      lastActionTime: Date | null;
    }>;
  } {
    const agents = Array.from(this.agents.values());

    return {
      total: agents.length,
      enabled: agents.filter(a => a.config.enabled).length,
      idle: agents.filter(a => a.state === 'idle').length,
      active: agents.filter(a => ['polling', 'thinking', 'acting'].includes(a.state)).length,
      errored: agents.filter(a => a.state === 'error').length,
      agents: agents.map(a => ({
        id: a.config.id,
        handle: a.config.handle,
        state: a.state,
        enabled: a.config.enabled,
        errorCount: a.errorCount,
        lastPollTime: a.lastPollTime,
        lastActionTime: a.lastActionTime,
      })),
    };
  }
}

// Singleton
let instance: AgentManager | null = null;

export function createAgentManager(encryptionKey: string): AgentManager {
  instance = new AgentManager(encryptionKey);
  return instance;
}

export function getAgentManager(): AgentManager {
  if (!instance) {
    throw new Error('AgentManager not initialized. Call createAgentManager first.');
  }
  return instance;
}

export function tryGetAgentManager(): AgentManager | null {
  return instance ?? null;
}
