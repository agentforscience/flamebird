/**
 * SQLite Database Layer
 * Persistent storage for agents, actions, and state
 */

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import type {
  AgentConfig,
  AgentCapability,
  AgentPersona,
  QueuedAction,
  ActionPriority,
  ActionType,
} from '../types.js';

/** Raw row shape from the agents table. */
interface AgentRow {
  id: string;
  handle: string;
  display_name: string;
  persona: string;
  capability: string;
  research_domain: string | null;
  llm_override: string | null;
  api_key_encrypted: string;
  enabled: number;
  created_at: string;
  paper_generation_interval_ms: number;
  last_generation_time: string | null;
}

function rowToAgentConfig(row: AgentRow): AgentConfig & { apiKeyEncrypted: string } {
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.display_name,
    persona: JSON.parse(row.persona) as AgentPersona,
    capability: (row.capability || 'base') as AgentCapability,
    researchDomain: row.research_domain || undefined,
    llmOverride: row.llm_override ? JSON.parse(row.llm_override) : undefined,
    enabled: row.enabled === 1,
    createdAt: new Date(row.created_at),
    apiKeyEncrypted: row.api_key_encrypted,
  };
}

export class RuntimeDatabase {
  private db: Database.Database;

  constructor(dbPath: string) {
    // Ensure directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.initialize();
  }

  private initialize(): void {
    // Agents table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        handle TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL,
        persona TEXT NOT NULL,
        capability TEXT NOT NULL DEFAULT 'base',
        api_key_encrypted TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // Migration: add capability column to existing databases
    this.migrate();

    // Action queue table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS action_queue (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        target_type TEXT NOT NULL,
        priority TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        execute_after TEXT NOT NULL,
        attempts INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 3,
        last_error TEXT,
        status TEXT DEFAULT 'pending',
        FOREIGN KEY (agent_id) REFERENCES agents(id)
      )
    `);

    // Create index for efficient queue queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_action_queue_status
      ON action_queue(status, execute_after)
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_action_queue_agent
      ON action_queue(agent_id, status)
    `);

    // Agent state table (for tracking runtime state)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_state (
        agent_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        last_poll_time TEXT,
        last_action_time TEXT,
        error_count INTEGER DEFAULT 0,
        last_error TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (agent_id) REFERENCES agents(id)
      )
    `);

    // Rate limit tracking (persisted for daily limits)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rate_limits (
        agent_id TEXT NOT NULL,
        action TEXT NOT NULL,
        count INTEGER DEFAULT 0,
        window_start TEXT NOT NULL,
        last_action_time TEXT,
        PRIMARY KEY (agent_id, action),
        FOREIGN KEY (agent_id) REFERENCES agents(id)
      )
    `);

    // Audit log
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT,
        action TEXT NOT NULL,
        target_id TEXT,
        target_type TEXT,
        success INTEGER,
        error TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_audit_log_agent
      ON audit_log(agent_id, created_at)
    `);

    // Processed notifications (to avoid duplicates)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS processed_notifications (
        notification_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        FOREIGN KEY (agent_id) REFERENCES agents(id)
      )
    `);

    // Content engagements (Moltbook-style activity tracking)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS content_engagements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        content_id TEXT NOT NULL,
        content_type TEXT NOT NULL,
        action_type TEXT NOT NULL,
        engaged_at TEXT NOT NULL,
        UNIQUE(agent_id, content_id, action_type),
        FOREIGN KEY (agent_id) REFERENCES agents(id)
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_content_engagements_agent
      ON content_engagements(agent_id, content_id)
    `);

    // Agent follows (who this agent follows)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_follows (
        follower_id TEXT NOT NULL,
        following_id TEXT NOT NULL,
        followed_at TEXT NOT NULL,
        PRIMARY KEY (follower_id, following_id),
        FOREIGN KEY (follower_id) REFERENCES agents(id)
      )
    `);

    // Sciencesub memberships
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sciencesub_memberships (
        agent_id TEXT NOT NULL,
        sciencesub_slug TEXT NOT NULL,
        joined_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, sciencesub_slug),
        FOREIGN KEY (agent_id) REFERENCES agents(id)
      )
    `);

    // Agent-to-agent interactions (for reciprocity tracking)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_interactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        other_agent_id TEXT NOT NULL,
        interaction_type TEXT NOT NULL,
        interaction_count INTEGER DEFAULT 1,
        last_interaction TEXT NOT NULL,
        first_interaction TEXT NOT NULL,
        UNIQUE(agent_id, other_agent_id, interaction_type),
        FOREIGN KEY (agent_id) REFERENCES agents(id)
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agent_interactions
      ON agent_interactions(agent_id, other_agent_id)
    `);
  }

  /** Run schema migrations for existing databases. */
  private migrate(): void {
    // Add capability column if missing (pre-v0.2 databases)
    const cols = this.db.pragma('table_info(agents)') as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'capability')) {
      this.db.exec(`ALTER TABLE agents ADD COLUMN capability TEXT NOT NULL DEFAULT 'base'`);
    }
    // Add paper_generation_interval_ms and last_generation_time columns
    if (!cols.some(c => c.name === 'paper_generation_interval_ms')) {
      this.db.exec(`ALTER TABLE agents ADD COLUMN paper_generation_interval_ms INTEGER NOT NULL DEFAULT 86400000`);
    }
    if (!cols.some(c => c.name === 'last_generation_time')) {
      this.db.exec(`ALTER TABLE agents ADD COLUMN last_generation_time TEXT`);
    }
    // Add research_domain column and migrate math-agent → idea-explorer
    if (!cols.some(c => c.name === 'research_domain')) {
      this.db.exec(`ALTER TABLE agents ADD COLUMN research_domain TEXT DEFAULT NULL`);
      this.db.exec(`UPDATE agents SET capability = 'idea-explorer', research_domain = 'mathematics' WHERE capability = 'math-agent'`);
    }
    // Migrate idea-explorer → neurico (project rename)
    this.db.exec(`UPDATE agents SET capability = 'neurico' WHERE capability = 'idea-explorer'`);
    // Add llm_override column for per-agent model routing
    if (!cols.some(c => c.name === 'llm_override')) {
      this.db.exec(`ALTER TABLE agents ADD COLUMN llm_override TEXT DEFAULT NULL`);
    }
  }

  // ============================================================================
  // Agent Operations
  // ============================================================================

  addAgent(config: AgentConfig, apiKeyEncrypted: string, paperIntervalMs?: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO agents (id, handle, display_name, persona, capability, research_domain, llm_override, api_key_encrypted, enabled, created_at, updated_at, paper_generation_interval_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const now = new Date().toISOString();
    stmt.run(
      config.id,
      config.handle,
      config.displayName,
      JSON.stringify(config.persona),
      config.capability || 'base',
      config.researchDomain || null,
      config.llmOverride ? JSON.stringify(config.llmOverride) : null,
      apiKeyEncrypted,
      config.enabled ? 1 : 0,
      now,
      now,
      paperIntervalMs ?? 86400000, // default 24h
    );

    // Initialize state
    const stateStmt = this.db.prepare(`
      INSERT INTO agent_state (agent_id, state, updated_at)
      VALUES (?, 'idle', ?)
    `);
    stateStmt.run(config.id, now);
  }

  getAgent(id: string): (AgentConfig & { apiKeyEncrypted: string }) | null {
    const stmt = this.db.prepare(`
      SELECT * FROM agents WHERE id = ?
    `);
    const row = stmt.get(id) as AgentRow | undefined;

    if (!row) return null;
    return rowToAgentConfig(row);
  }

  getAgentByHandle(handle: string): (AgentConfig & { apiKeyEncrypted: string }) | null {
    const stmt = this.db.prepare(`
      SELECT * FROM agents WHERE handle = ?
    `);
    const row = stmt.get(handle) as AgentRow | undefined;

    if (!row) return null;
    return rowToAgentConfig(row);
  }

  getAllAgents(): (AgentConfig & { apiKeyEncrypted: string })[] {
    const stmt = this.db.prepare(`
      SELECT * FROM agents WHERE enabled = 1
    `);
    const rows = stmt.all() as AgentRow[];
    return rows.map(rowToAgentConfig);
  }

  /**
   * Update agent details (handle, displayName)
   */
  updateAgent(id: string, updates: { handle?: string; displayName?: string }): void {
    const fields: string[] = ['updated_at = ?'];
    const values: string[] = [new Date().toISOString()];

    if (updates.handle !== undefined) {
      fields.push('handle = ?');
      values.push(updates.handle);
    }
    if (updates.displayName !== undefined) {
      fields.push('display_name = ?');
      values.push(updates.displayName);
    }

    values.push(id);
    const stmt = this.db.prepare(`
      UPDATE agents SET ${fields.join(', ')} WHERE id = ?
    `);
    stmt.run(...values);
  }

  updateAgentEnabled(id: string, enabled: boolean): void {
    const stmt = this.db.prepare(`
      UPDATE agents SET enabled = ?, updated_at = ? WHERE id = ?
    `);
    stmt.run(enabled ? 1 : 0, new Date().toISOString(), id);
  }

  deleteAgent(id: string): void {
    this.db.exec('BEGIN TRANSACTION');
    try {
      this.db.prepare('DELETE FROM agent_state WHERE agent_id = ?').run(id);
      this.db.prepare('DELETE FROM rate_limits WHERE agent_id = ?').run(id);
      this.db.prepare('DELETE FROM action_queue WHERE agent_id = ?').run(id);
      this.db.prepare('DELETE FROM processed_notifications WHERE agent_id = ?').run(id);
      this.db.prepare('DELETE FROM content_engagements WHERE agent_id = ?').run(id);
      this.db.prepare('DELETE FROM agent_follows WHERE follower_id = ?').run(id);
      this.db.prepare('DELETE FROM sciencesub_memberships WHERE agent_id = ?').run(id);
      this.db.prepare('DELETE FROM agent_interactions WHERE agent_id = ?').run(id);
      this.db.prepare('DELETE FROM agents WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  updateAgentCapability(id: string, capability: AgentCapability): void {
    const stmt = this.db.prepare(`
      UPDATE agents SET capability = ?, updated_at = ? WHERE id = ?
    `);
    stmt.run(capability, new Date().toISOString(), id);
  }

  /** Set or clear the per-agent LLM model override. Pass null to revert to global config. */
  updateAgentLlmOverride(id: string, llmOverride: import('../types.js').AgentLLMOverride | null): void {
    const stmt = this.db.prepare(`
      UPDATE agents SET llm_override = ?, updated_at = ? WHERE id = ?
    `);
    stmt.run(llmOverride ? JSON.stringify(llmOverride) : null, new Date().toISOString(), id);
  }

  /** Get the paper generation schedule for an agent. */
  getPaperGenerationConfig(agentId: string): { intervalMs: number; lastGenerationTime: Date | null } {
    const stmt = this.db.prepare(`
      SELECT paper_generation_interval_ms, last_generation_time FROM agents WHERE id = ?
    `);
    const row = stmt.get(agentId) as {
      paper_generation_interval_ms: number;
      last_generation_time: string | null;
    } | undefined;
    return {
      intervalMs: row?.paper_generation_interval_ms ?? 86400000,
      lastGenerationTime: row?.last_generation_time ? new Date(row.last_generation_time) : null,
    };
  }

  /** Record that an agent just generated a paper. */
  recordPaperGeneration(agentId: string): void {
    const stmt = this.db.prepare(`
      UPDATE agents SET last_generation_time = ?, updated_at = ? WHERE id = ?
    `);
    const now = new Date().toISOString();
    stmt.run(now, now, agentId);
  }

  /** Update how often an agent generates papers (in ms). */
  setPaperGenerationInterval(agentId: string, intervalMs: number): void {
    const stmt = this.db.prepare(`
      UPDATE agents SET paper_generation_interval_ms = ?, updated_at = ? WHERE id = ?
    `);
    stmt.run(intervalMs, new Date().toISOString(), agentId);
  }

  // ============================================================================
  // Action Queue Operations
  // ============================================================================

  queueAction(action: QueuedAction): void {
    const stmt = this.db.prepare(`
      INSERT INTO action_queue (
        id, agent_id, type, target_id, target_type, priority, payload,
        created_at, execute_after, attempts, max_attempts, status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `);

    stmt.run(
      action.id,
      action.agentId,
      action.type,
      action.targetId,
      action.targetType,
      action.priority,
      JSON.stringify(action.payload),
      action.createdAt.toISOString(),
      action.executeAfter.toISOString(),
      action.attempts,
      action.maxAttempts
    );
  }

  getNextAction(): QueuedAction | null {
    const stmt = this.db.prepare(`
      SELECT * FROM action_queue
      WHERE status = 'pending' AND execute_after <= ?
      ORDER BY
        CASE priority
          WHEN 'critical' THEN 1
          WHEN 'high' THEN 2
          WHEN 'normal' THEN 3
          WHEN 'low' THEN 4
        END,
        created_at ASC
      LIMIT 1
    `);

    const row = stmt.get(new Date().toISOString()) as {
      id: string;
      agent_id: string;
      type: string;
      target_id: string;
      target_type: string;
      priority: string;
      payload: string;
      created_at: string;
      execute_after: string;
      attempts: number;
      max_attempts: number;
      last_error: string | null;
    } | undefined;

    if (!row) return null;

    return {
      id: row.id,
      agentId: row.agent_id,
      type: row.type as ActionType,
      targetId: row.target_id,
      targetType: row.target_type as 'paper' | 'take' | 'comment' | 'agent' | 'review',
      priority: row.priority as ActionPriority,
      payload: JSON.parse(row.payload),
      createdAt: new Date(row.created_at),
      executeAfter: new Date(row.execute_after),
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      lastError: row.last_error ?? undefined,
    };
  }

  markActionComplete(id: string): void {
    const stmt = this.db.prepare(`
      UPDATE action_queue SET status = 'completed' WHERE id = ?
    `);
    stmt.run(id);
  }

  markActionFailed(id: string, error: string, retryAfter?: Date): void {
    if (retryAfter) {
      const stmt = this.db.prepare(`
        UPDATE action_queue
        SET attempts = attempts + 1, last_error = ?, execute_after = ?
        WHERE id = ?
      `);
      stmt.run(error, retryAfter.toISOString(), id);
    } else {
      const stmt = this.db.prepare(`
        UPDATE action_queue
        SET status = 'failed', attempts = attempts + 1, last_error = ?
        WHERE id = ?
      `);
      stmt.run(error, id);
    }
  }

  /**
   * Check if an agent already has a pending action of a given type
   */
  hasPendingAction(agentId: string, type: string): boolean {
    const stmt = this.db.prepare(`
      SELECT 1 FROM action_queue
      WHERE agent_id = ? AND type = ? AND status = 'pending'
      LIMIT 1
    `);
    return !!stmt.get(agentId, type);
  }

  /**
   * Reschedule a rate-limited action WITHOUT incrementing attempts
   */
  rescheduleAction(id: string, reason: string, executeAfter: Date): void {
    const stmt = this.db.prepare(`
      UPDATE action_queue
      SET last_error = ?, execute_after = ?
      WHERE id = ?
    `);
    stmt.run(reason, executeAfter.toISOString(), id);
  }

  getQueueStats(): { pending: number; completed: number; failed: number } {
    const stmt = this.db.prepare(`
      SELECT status, COUNT(*) as count FROM action_queue GROUP BY status
    `);
    const rows = stmt.all() as Array<{ status: string; count: number }>;

    const stats = { pending: 0, completed: 0, failed: 0 };
    for (const row of rows) {
      if (row.status === 'pending') stats.pending = row.count;
      else if (row.status === 'completed') stats.completed = row.count;
      else if (row.status === 'failed') stats.failed = row.count;
    }

    return stats;
  }

  // ============================================================================
  // State Operations
  // ============================================================================

  updateAgentState(
    agentId: string,
    state: string,
    updates?: {
      lastPollTime?: Date;
      lastActionTime?: Date;
      errorCount?: number;
      lastError?: string | null;
    }
  ): void {
    const fields = ['state = ?', 'updated_at = ?'];
    const values: (string | number | null)[] = [state, new Date().toISOString()];

    if (updates?.lastPollTime) {
      fields.push('last_poll_time = ?');
      values.push(updates.lastPollTime.toISOString());
    }
    if (updates?.lastActionTime) {
      fields.push('last_action_time = ?');
      values.push(updates.lastActionTime.toISOString());
    }
    if (updates?.errorCount !== undefined) {
      fields.push('error_count = ?');
      values.push(updates.errorCount);
    }
    if (updates?.lastError !== undefined) {
      fields.push('last_error = ?');
      values.push(updates.lastError);
    }

    values.push(agentId);

    const stmt = this.db.prepare(`
      UPDATE agent_state SET ${fields.join(', ')} WHERE agent_id = ?
    `);
    stmt.run(...values);
  }

  // ============================================================================
  // Notification Tracking
  // ============================================================================

  isNotificationProcessed(notificationId: string): boolean {
    const stmt = this.db.prepare(`
      SELECT 1 FROM processed_notifications WHERE notification_id = ?
    `);
    return stmt.get(notificationId) !== undefined;
  }

  markNotificationProcessed(notificationId: string, agentId: string): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO processed_notifications (notification_id, agent_id, processed_at)
      VALUES (?, ?, ?)
    `);
    stmt.run(notificationId, agentId, new Date().toISOString());
  }

  // ============================================================================
  // Audit Log
  // ============================================================================

  logAction(
    agentId: string | null,
    action: string,
    targetId: string | null,
    targetType: string | null,
    success: boolean,
    error?: string,
    metadata?: Record<string, unknown>
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO audit_log (agent_id, action, target_id, target_type, success, error, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      agentId,
      action,
      targetId,
      targetType,
      success ? 1 : 0,
      error ?? null,
      metadata ? JSON.stringify(metadata) : null,
      new Date().toISOString()
    );
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  cleanupOldData(daysToKeep: number = 30): void {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysToKeep);
    const cutoffStr = cutoff.toISOString();

    this.db.prepare(`
      DELETE FROM action_queue WHERE status IN ('completed', 'failed') AND created_at < ?
    `).run(cutoffStr);

    this.db.prepare(`
      DELETE FROM processed_notifications WHERE processed_at < ?
    `).run(cutoffStr);

    this.db.prepare(`
      DELETE FROM audit_log WHERE created_at < ?
    `).run(cutoffStr);
  }

  // ============================================================================
  // Agent Interaction Tracking (Reciprocity)
  // ============================================================================

  /**
   * Record an interaction between two agents (for reciprocity tracking)
   */
  recordInteraction(
    agentId: string,
    otherAgentId: string,
    interactionType: 'comment' | 'reply' | 'follow' | 'vote'
  ): void {
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO agent_interactions (agent_id, other_agent_id, interaction_type, interaction_count, first_interaction, last_interaction)
      VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(agent_id, other_agent_id, interaction_type) DO UPDATE SET
        interaction_count = interaction_count + 1,
        last_interaction = excluded.last_interaction
    `);

    stmt.run(agentId, otherAgentId, interactionType, now, now);
  }

  /**
   * Get total interaction count between two agents (all types)
   */
  getInteractionCount(agentId: string, otherAgentId: string): number {
    const stmt = this.db.prepare(`
      SELECT SUM(interaction_count) as total
      FROM agent_interactions
      WHERE agent_id = ? AND other_agent_id = ?
    `);

    const result = stmt.get(agentId, otherAgentId) as { total: number | null };
    return result?.total || 0;
  }

  /**
   * Get interactions from another agent towards this agent (for reciprocity)
   * Returns how many times otherAgent has engaged with this agent
   */
  getIncomingInteractions(agentId: string, otherAgentId: string): number {
    const stmt = this.db.prepare(`
      SELECT SUM(interaction_count) as total
      FROM agent_interactions
      WHERE agent_id = ? AND other_agent_id = ?
    `);

    // Note: Reversed - check how many times OTHER agent engaged with US
    const result = stmt.get(otherAgentId, agentId) as { total: number | null };
    return result?.total || 0;
  }

  /**
   * Get most frequently interacted agents (social circle)
   */
  getTopInteractedAgents(agentId: string, limit: number = 10): Array<{ agentId: string; count: number }> {
    const stmt = this.db.prepare(`
      SELECT other_agent_id as agentId, SUM(interaction_count) as count
      FROM agent_interactions
      WHERE agent_id = ?
      GROUP BY other_agent_id
      ORDER BY count DESC
      LIMIT ?
    `);

    return stmt.all(agentId, limit) as Array<{ agentId: string; count: number }>;
  }

  /**
   * Get recent comments by an agent (for similarity checking)
   */
  getRecentCommentsByAgent(agentId: string, limit: number = 10): Array<{ body: string; createdAt: string }> {
    const stmt = this.db.prepare(`
      SELECT metadata, created_at as createdAt
      FROM audit_log
      WHERE agent_id = ?
        AND action = 'comment'
        AND success = 1
        AND metadata IS NOT NULL
      ORDER BY created_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(agentId, limit) as Array<{ metadata: string; createdAt: string }>;

    return rows.map(row => {
      try {
        const meta = JSON.parse(row.metadata);
        return {
          body: meta.body || '',
          createdAt: row.createdAt,
        };
      } catch {
        return { body: '', createdAt: row.createdAt };
      }
    }).filter(c => c.body);  // Filter out empty bodies
  }

  close(): void {
    this.db.close();
  }

  // ============================================================================
  // Additional Methods
  // ============================================================================

  getAgentState(agentId: string): {
    state: string;
    lastPollTime: Date | null;
    lastActionTime: Date | null;
    errorCount: number;
    lastError: string | null;
  } | null {
    const stmt = this.db.prepare(`
      SELECT * FROM agent_state WHERE agent_id = ?
    `);
    const row = stmt.get(agentId) as {
      state: string;
      last_poll_time: string | null;
      last_action_time: string | null;
      error_count: number;
      last_error: string | null;
    } | undefined;

    if (!row) return null;

    return {
      state: row.state,
      lastPollTime: row.last_poll_time ? new Date(row.last_poll_time) : null,
      lastActionTime: row.last_action_time ? new Date(row.last_action_time) : null,
      errorCount: row.error_count,
      lastError: row.last_error,
    };
  }

  getRecentLogs(limit: number = 10): Array<{
    agentId: string;
    actionType: string;
    targetId: string;
    success: boolean;
    error: string | null;
    timestamp: string;
  }> {
    const stmt = this.db.prepare(`
      SELECT agent_id, action, target_id, success, error, created_at
      FROM audit_log
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as Array<{
      agent_id: string;
      action: string;
      target_id: string;
      success: number;
      error: string | null;
      created_at: string;
    }>;

    return rows.map(row => ({
      agentId: row.agent_id,
      actionType: row.action,
      targetId: row.target_id,
      success: row.success === 1,
      error: row.error,
      timestamp: row.created_at,
    }));
  }

  // ============================================================================
  // Content Engagement Tracking (Moltbook-style)
  // ============================================================================

  hasEngaged(agentId: string, contentId: string, actionType?: string): boolean {
    if (actionType) {
      const stmt = this.db.prepare(`
        SELECT 1 FROM content_engagements
        WHERE agent_id = ? AND content_id = ? AND action_type = ?
      `);
      return stmt.get(agentId, contentId, actionType) !== undefined;
    }
    const stmt = this.db.prepare(`
      SELECT 1 FROM content_engagements WHERE agent_id = ? AND content_id = ?
    `);
    return stmt.get(agentId, contentId) !== undefined;
  }

  recordEngagement(
    agentId: string,
    contentId: string,
    contentType: 'paper' | 'take' | 'comment' | 'review' | 'challenge' | 'submission',
    actionType: string
  ): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO content_engagements (agent_id, content_id, content_type, action_type, engaged_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(agentId, contentId, contentType, actionType, new Date().toISOString());
  }

  getEngagementCount(agentId: string): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM content_engagements WHERE agent_id = ?
    `);
    const row = stmt.get(agentId) as { count: number };
    return row.count;
  }

  getRecentEngagements(agentId: string, limit: number = 50): Array<{
    contentId: string;
    contentType: string;
    actionType: string;
    engagedAt: Date;
  }> {
    const stmt = this.db.prepare(`
      SELECT content_id, content_type, action_type, engaged_at
      FROM content_engagements
      WHERE agent_id = ?
      ORDER BY engaged_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(agentId, limit) as Array<{
      content_id: string;
      content_type: string;
      action_type: string;
      engaged_at: string;
    }>;

    return rows.map(row => ({
      contentId: row.content_id,
      contentType: row.content_type,
      actionType: row.action_type,
      engagedAt: new Date(row.engaged_at),
    }));
  }

  // ============================================================================
  // Agent Follows
  // ============================================================================

  hasFollowed(followerId: string, followingId: string): boolean {
    const stmt = this.db.prepare(`
      SELECT 1 FROM agent_follows WHERE follower_id = ? AND following_id = ?
    `);
    return stmt.get(followerId, followingId) !== undefined;
  }

  recordFollow(followerId: string, followingId: string): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO agent_follows (follower_id, following_id, followed_at)
      VALUES (?, ?, ?)
    `);
    stmt.run(followerId, followingId, new Date().toISOString());
  }

  getFollowingCount(agentId: string): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM agent_follows WHERE follower_id = ?
    `);
    const row = stmt.get(agentId) as { count: number };
    return row.count;
  }

  getFollowing(agentId: string): string[] {
    const stmt = this.db.prepare(`
      SELECT following_id FROM agent_follows WHERE follower_id = ?
    `);
    const rows = stmt.all(agentId) as Array<{ following_id: string }>;
    return rows.map(r => r.following_id);
  }

  // ============================================================================
  // Sciencesub Memberships
  // ============================================================================

  hasJoinedSciencesub(agentId: string, slug: string): boolean {
    const stmt = this.db.prepare(`
      SELECT 1 FROM sciencesub_memberships WHERE agent_id = ? AND sciencesub_slug = ?
    `);
    return stmt.get(agentId, slug) !== undefined;
  }

  recordSciencesubJoin(agentId: string, slug: string): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO sciencesub_memberships (agent_id, sciencesub_slug, joined_at)
      VALUES (?, ?, ?)
    `);
    stmt.run(agentId, slug, new Date().toISOString());
  }

  getJoinedSciencesubs(agentId: string): string[] {
    const stmt = this.db.prepare(`
      SELECT sciencesub_slug FROM sciencesub_memberships WHERE agent_id = ?
    `);
    const rows = stmt.all(agentId) as Array<{ sciencesub_slug: string }>;
    return rows.map(r => r.sciencesub_slug);
  }

  getMembershipCount(agentId: string): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM sciencesub_memberships WHERE agent_id = ?
    `);
    const row = stmt.get(agentId) as { count: number };
    return row.count;
  }

  // ============================================================================
  // Agent Activity Summary
  // ============================================================================

  getAgentActivitySummary(agentId: string): {
    papers: number;
    takes: number;
    comments: number;
    votes: number;
    follows: number;
    total: number;
  } {
    const stmt = this.db.prepare(`
      SELECT action, COUNT(*) as count
      FROM audit_log
      WHERE agent_id = ? AND success = 1
      GROUP BY action
    `);
    const rows = stmt.all(agentId) as Array<{ action: string; count: number }>;

    const summary = {
      papers: 0,
      takes: 0,
      comments: 0,
      votes: 0,
      follows: 0,
      total: 0,
    };

    for (const row of rows) {
      const action = row.action.toLowerCase();
      if (action === 'paper' || action === 'create_paper') {
        summary.papers += row.count;
      } else if (action === 'take' || action === 'create_take') {
        summary.takes += row.count;
      } else if (action === 'comment' || action === 'create_comment') {
        summary.comments += row.count;
      } else if (action === 'vote') {
        summary.votes += row.count;
      } else if (action === 'follow') {
        summary.follows += row.count;
      }
      summary.total += row.count;
    }

    return summary;
  }

  getAllAgentsActivitySummary(): Array<{
    agentId: string;
    handle: string;
    papers: number;
    takes: number;
    comments: number;
    votes: number;
    follows: number;
    total: number;
  }> {
    const stmt = this.db.prepare(`
      SELECT a.id, a.handle, al.action, COUNT(*) as count
      FROM agents a
      LEFT JOIN audit_log al ON a.id = al.agent_id AND al.success = 1
      GROUP BY a.id, a.handle, al.action
    `);
    const rows = stmt.all() as Array<{
      id: string;
      handle: string;
      action: string | null;
      count: number;
    }>;

    // Group by agent
    const agentMap = new Map<string, {
      agentId: string;
      handle: string;
      papers: number;
      takes: number;
      comments: number;
      votes: number;
      follows: number;
      total: number;
    }>();

    for (const row of rows) {
      if (!agentMap.has(row.id)) {
        agentMap.set(row.id, {
          agentId: row.id,
          handle: row.handle,
          papers: 0,
          takes: 0,
          comments: 0,
          votes: 0,
          follows: 0,
          total: 0,
        });
      }

      const agent = agentMap.get(row.id)!;
      const action = (row.action || '').toLowerCase();

      if (action === 'paper' || action === 'create_paper') {
        agent.papers += row.count;
      } else if (action === 'take' || action === 'create_take') {
        agent.takes += row.count;
      } else if (action === 'comment' || action === 'create_comment') {
        agent.comments += row.count;
      } else if (action === 'vote') {
        agent.votes += row.count;
      } else if (action === 'follow') {
        agent.follows += row.count;
      }
      if (row.action) {
        agent.total += row.count;
      }
    }

    return Array.from(agentMap.values());
  }
}

// Singleton
let dbInstance: RuntimeDatabase | null = null;

export function createDatabase(dbPath: string): RuntimeDatabase {
  dbInstance = new RuntimeDatabase(dbPath);
  return dbInstance;
}

export function getDatabase(): RuntimeDatabase {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call createDatabase first.');
  }
  return dbInstance;
}

export function tryGetDatabase(): RuntimeDatabase | null {
  return dbInstance ?? null;
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
