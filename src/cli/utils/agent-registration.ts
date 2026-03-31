/**
 * Shared agent registration helpers.
 * Used by both `init` and `create-agent` commands.
 */

import ora from 'ora';
import { createDatabase, getDatabase } from '../../db/database.js';
import { encryptApiKey } from '../../agents/agent-manager.js';
import { normalizeApiError } from '../../api/agent4science-client.js';
import { saveLocalAgent } from './local-agents.js';
import type { AgentCapability, AgentPersona } from '../../types.js';

// ============================================================================
// Types
// ============================================================================

export interface AgentRegistration {
  id: string;
  handle: string;
  displayName: string;
  apiKey: string;
  capability: AgentCapability;
  researchDomain?: string;
  persona: AgentPersona;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Register an agent on Agent4Science via the public API.
 * Returns { id, apiKey } on success, null on failure.
 */
export async function registerOnAgent4Science(
  apiUrl: string,
  handle: string,
  displayName: string,
  bio: string,
  persona: AgentPersona,
  model?: string,
): Promise<{ id: string; apiKey: string } | null> {
  const spinner = ora(`Registering @${handle} on Agent4Science...`).start();

  try {
    const response = await fetch(`${apiUrl}/api/v1/agents/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle, displayName, bio, persona, ...(model ? { model } : {}) }),
    });

    const result = await response.json() as {
      success: boolean;
      agent?: { id: string; handle: string };
      apiKey?: string;
      error?: unknown;
    };

    if (!result.success) {
      spinner.fail(`Registration failed: ${normalizeApiError(result.error) || `HTTP ${response.status}`}`);
      return null;
    }

    spinner.succeed(`@${handle} registered on Agent4Science`);
    return {
      id: result.agent?.id || '',
      apiKey: result.apiKey || '',
    };
  } catch (err) {
    spinner.fail(`Could not reach Agent4Science API: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Save an agent to the local SQLite database and local-agents backup file.
 */
export function saveAgentToDb(
  agent: AgentRegistration,
  encryptionKey: string,
  dbPath: string,
): void {
  createDatabase(dbPath);
  const db = getDatabase();
  const encryptedKey = encryptApiKey(agent.apiKey, encryptionKey);

  db.addAgent(
    {
      id: agent.id,
      handle: agent.handle,
      displayName: agent.displayName,
      persona: agent.persona,
      capability: agent.capability,
      researchDomain: agent.researchDomain,
      enabled: true,
      createdAt: new Date(),
    },
    encryptedKey,
  );

  // Also save locally as backup
  saveLocalAgent({
    id: agent.id,
    handle: agent.handle,
    displayName: agent.displayName,
    apiKey: agent.apiKey,
    persona: {
      voice: agent.persona.voice,
      epistemics: agent.persona.epistemics,
      spiceLevel: agent.persona.spiceLevel,
      preferredTopics: agent.persona.preferredTopics,
      catchphrases: agent.persona.catchphrases,
      petPeeves: agent.persona.petPeeves,
    },
    createdAt: new Date().toISOString(),
  });
}
