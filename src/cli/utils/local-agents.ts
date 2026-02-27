/**
 * Local Agent Storage
 * Persists created agents locally so users can select them in future sessions
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface LocalAgent {
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

interface LocalAgentStore {
  version: number;
  agents: LocalAgent[];
}

// Store in ~/.flamebird-agents/
const STORE_DIR = join(homedir(), '.flamebird-agents');
const STORE_FILE = join(STORE_DIR, 'agents.json');

function ensureStoreDir(): void {
  if (!existsSync(STORE_DIR)) {
    mkdirSync(STORE_DIR, { recursive: true });
  }
}

function loadStore(): LocalAgentStore {
  ensureStoreDir();

  if (!existsSync(STORE_FILE)) {
    return { version: 1, agents: [] };
  }

  try {
    const content = readFileSync(STORE_FILE, 'utf-8');
    return JSON.parse(content) as LocalAgentStore;
  } catch {
    return { version: 1, agents: [] };
  }
}

function saveStore(store: LocalAgentStore): void {
  ensureStoreDir();
  writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}

/**
 * Get all locally stored agents
 */
export function getLocalAgents(): LocalAgent[] {
  const store = loadStore();
  return store.agents;
}

/**
 * Save a new agent locally
 */
export function saveLocalAgent(agent: LocalAgent): void {
  const store = loadStore();

  // Check if agent already exists (by handle)
  const existingIndex = store.agents.findIndex(a => a.handle === agent.handle);

  if (existingIndex >= 0) {
    // Update existing
    store.agents[existingIndex] = { ...agent, lastUsed: new Date().toISOString() };
  } else {
    // Add new
    store.agents.push(agent);
  }

  saveStore(store);
}

/**
 * Update last used time for an agent
 */
export function touchAgent(handle: string): void {
  const store = loadStore();
  const agent = store.agents.find(a => a.handle === handle);

  if (agent) {
    agent.lastUsed = new Date().toISOString();
    saveStore(store);
  }
}

/**
 * Update an agent's display name (and optionally handle) in local storage
 */
export function updateLocalAgent(
  handle: string,
  updates: Partial<Pick<LocalAgent, 'displayName' | 'handle'>>
): boolean {
  const store = loadStore();
  const agent = store.agents.find(a => a.handle === handle);
  if (!agent) return false;

  if (updates.displayName !== undefined) agent.displayName = updates.displayName;
  if (updates.handle !== undefined) agent.handle = updates.handle;
  agent.lastUsed = new Date().toISOString();
  saveStore(store);
  return true;
}

/**
 * Delete an agent from local storage
 */
export function deleteLocalAgent(handle: string): boolean {
  const store = loadStore();
  const initialLength = store.agents.length;
  store.agents = store.agents.filter(a => a.handle !== handle);

  if (store.agents.length < initialLength) {
    saveStore(store);
    return true;
  }

  return false;
}

/**
 * Get a specific agent by handle
 */
export function getLocalAgent(handle: string): LocalAgent | undefined {
  const store = loadStore();
  return store.agents.find(a => a.handle === handle);
}

/**
 * Get agents sorted by last used (most recent first)
 */
export function getRecentAgents(limit: number = 5): LocalAgent[] {
  const store = loadStore();
  return store.agents
    .sort((a, b) => {
      const aTime = a.lastUsed ? new Date(a.lastUsed).getTime() : new Date(a.createdAt).getTime();
      const bTime = b.lastUsed ? new Date(b.lastUsed).getTime() : new Date(b.createdAt).getTime();
      return bTime - aTime;
    })
    .slice(0, limit);
}
