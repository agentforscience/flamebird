/**
 * Configuration Loader
 * Loads and validates runtime configuration from environment and files
 */

import { config as loadEnv } from 'dotenv';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join, resolve, dirname } from 'path';
import { z } from 'zod';
import type { RuntimeConfig, RateLimitConfig } from '../types.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('config');

let cachedConfig: RuntimeConfig | null = null;
let cachedEnvPath: string | undefined = '.env';
let encryptionKeyWarned = false;

/** Invalidate the cached config so the next loadConfig() call re-reads .env. */
export function resetConfigCache(): void {
  cachedConfig = null;
  cachedEnvPath = undefined;
}

// Default agent-side rate limits — aligned to spec; server enforces separate, higher limits
const DEFAULT_RATE_LIMITS: RateLimitConfig[] = [
  { action: 'paper',      maxRequests: 1,   window: 'day', cooldownMs: 60 * 60 * 1000 },        // 1/day, 1hr cooldown
  { action: 'take',       maxRequests: 6,   window: 'day', cooldownMs: 4 * 60 * 60 * 1000 },    // 6/day, 4hr cooldown (was 24/day, 1hr)
  { action: 'review',     maxRequests: 6,   window: 'day', cooldownMs: 5 * 60 * 1000 },         // 6/day, 5min cooldown (was 12/day, 60s)
  { action: 'comment',    maxRequests: 72,  window: 'day', cooldownMs: 5 * 60 * 1000 },         // 72/day, 5min cooldown (was 288/day, 30s)
  { action: 'vote',       maxRequests: 288, window: 'day', cooldownMs: 5 * 60 * 1000 },         // 288/day, 5min cooldown (was 1440/day, 1min)
  { action: 'follow',     maxRequests: 288, window: 'day', cooldownMs: 5 * 60 * 1000 },         // 288/day, 5min cooldown (was 1440/day, 1min)
  { action: 'sciencesub', maxRequests: 3,   window: 'day', cooldownMs: 0 },                     // 3/day, no cooldown
];

// Zod schema for validation
const ConfigSchema = z.object({
  api: z.object({
    apiUrl: z.string().url(),
    adminSecret: z.string().optional(),
  }),
  llm: z.object({
    provider: z.enum(['openrouter', 'anthropic', 'openai']),
    apiKey: z.string(),
    model: z.string().min(1),
  }),
  polling: z.object({
    baseIntervalMs: z.number().min(5000).max(300000),
    maxIntervalMs: z.number().min(30000).max(3600000),
    backoffMultiplier: z.number().min(1).max(5),
  }),
  rateLimits: z.array(z.object({
    action: z.string(),
    maxRequests: z.number().positive(),
    window: z.enum(['minute', 'hour', 'day']),
    cooldownMs: z.number().nonnegative(),
  })),
  security: z.object({
    encryptionKey: z.string().min(16),
  }),
  database: z.object({
    path: z.string().min(1),
  }),
  logging: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error']),
  }),
});

/**
 * Return the flamebird home directory (~/.flamebird by default).
 * Override with FLAMEBIRD_HOME env var.
 */
export function getFlamebirdHome(): string {
  return process.env.FLAMEBIRD_HOME || join(homedir(), '.flamebird');
}

/**
 * Resolve config file path with priority:
 *   1. Explicit argument (--config flag)
 *   2. CONFIG_PATH / ENV_PATH env var
 *   3. ~/.flamebird/.env if it exists (wizard users: init writes here, so use it so status/start find the same config)
 *   4. ./.env in cwd (git-clone users who never ran the wizard)
 *   5. ~/.flamebird/.env (default path)
 */
export function getConfigPath(envPath?: string): string {
  if (envPath) return envPath;
  if (process.env.CONFIG_PATH) return process.env.CONFIG_PATH;
  if (process.env.ENV_PATH) return process.env.ENV_PATH;
  const homeEnv = join(getFlamebirdHome(), '.env');
  if (existsSync(homeEnv)) return homeEnv;
  if (existsSync(resolve('.env'))) return resolve('.env');
  return homeEnv;
}

/**
 * Resolve database path so it works regardless of current working directory.
 * Relative paths (e.g. ./data/runtime.db) are resolved from the directory
 * containing the config file, so "flamebird status" works from any cwd.
 */
function resolveDatabasePath(configFilePath: string): string {
  const raw =
    process.env.DB_PATH || join(getFlamebirdHome(), 'data', 'runtime.db');
  if (raw.startsWith('/') || (raw.length >= 2 && raw[1] === ':')) {
    return raw;
  }
  const configDir = dirname(configFilePath);
  return resolve(configDir, raw);
}

/**
 * Load configuration from environment variables.
 * Cached per process so we only load and log once (avoids log spam during interactive CLI).
 */
export function loadConfig(envPath?: string): RuntimeConfig {
  const pathKey = getConfigPath(envPath);
  if (cachedConfig !== null && cachedEnvPath === pathKey) {
    return cachedConfig;
  }

  // Load .env file if it exists
  const result = loadEnv({ path: pathKey });
  if (result.error && !process.env.AGENT4SCIENCE_API_URL) {
    logger.warn('No .env file found, using environment variables');
  }

  const apiUrl = process.env.AGENT4SCIENCE_API_URL || 'https://agent4science.org';

  // Build config from environment
  const config: RuntimeConfig = {
    api: {
      apiUrl,
      adminSecret: process.env.ADMIN_SECRET,
    },
    llm: {
      provider: (process.env.LLM_PROVIDER as 'openrouter' | 'anthropic' | 'openai') || 'openrouter',
      apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || '',
      model: process.env.LLM_MODEL || 'anthropic/claude-sonnet-4.5',
    },
    // Optional verifier model for cross-model challenge submission verification
    ...(process.env.VERIFIER_MODEL ? {
      verifier: {
        provider: (process.env.VERIFIER_PROVIDER as 'openrouter' | 'anthropic' | 'openai') || 'anthropic',
        apiKey: process.env.VERIFIER_API_KEY || process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || '',
        model: process.env.VERIFIER_MODEL,
      },
    } : {}),
    polling: {
      baseIntervalMs: parseInt(process.env.POLL_BASE_INTERVAL_MS || '120000', 10),
      maxIntervalMs: parseInt(process.env.POLL_MAX_INTERVAL_MS || '600000', 10),
      backoffMultiplier: parseFloat(process.env.POLL_BACKOFF_MULTIPLIER || '1.5'),
    },
    proactive: {
      discoveryIntervalMs: parseInt(process.env.DISCOVERY_INTERVAL_MS || '900000', 10),
      maxDiscoveryItems: parseInt(process.env.MAX_DISCOVERY_ITEMS || '10', 10),
      minEngagementThreshold: parseFloat(process.env.MIN_ENGAGEMENT_THRESHOLD || '0.6'),
      enableAgentFollowing: process.env.ENABLE_AGENT_FOLLOWING !== 'false',
      enableSciencesubJoining: process.env.ENABLE_SCIENCESUB_JOINING !== 'false',
      enableSciencesubCreation: process.env.ENABLE_SCIENCESUB_CREATION !== 'false',
      enableTakeCreation: process.env.ENABLE_TAKE_CREATION !== 'false',
      enableVoting: process.env.ENABLE_VOTING !== 'false',
      // Master switch: set ENABLE_POSTING=false to disable content creation
      // Default: true (agents can create comments, takes, papers, notes)
      enablePosting: process.env.ENABLE_POSTING !== 'false',
      // Action weights control the probability of each creative action per heartbeat.
      // Set via settings.json (play menu) or ACTION_WEIGHTS env var (JSON object).
      // Zero-weight actions are effectively disabled. Weights are auto-normalized.
      actionWeights: process.env.ACTION_WEIGHTS ? JSON.parse(process.env.ACTION_WEIGHTS) : {
        comment_paper:      10,
        comment_take:       10,
        comment_review:     10,
        reply:              25,
        take_on_paper:      5,
        review:             5,
        standalone_take:    5,
        attempt_challenge:  5,
        comment_submission: 15,
      },
    },
    rateLimits: DEFAULT_RATE_LIMITS,
    security: {
      encryptionKey: process.env.ENCRYPTION_KEY || generateDefaultKey(),
    },
    database: {
      path: resolveDatabasePath(pathKey),
    },
    logging: {
      level: (process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') || 'info',
    },
  };

  // Validate config
  try {
    ConfigSchema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
      throw new Error(`Invalid configuration: ${issues}`);
    }
    throw error;
  }

  logger.info({
    apiUrl: config.api.apiUrl,
    llmProvider: config.llm.provider,
    llmModel: config.llm.model,
    pollInterval: `${config.polling.baseIntervalMs}ms - ${config.polling.maxIntervalMs}ms`,
    dbPath: config.database.path,
  }, 'Configuration loaded');

  cachedConfig = config;
  cachedEnvPath = pathKey;
  return config;
}

/**
 * Generate a default encryption key (for development only).
 * Warns only once per process to avoid log spam during interactive CLI.
 */
function generateDefaultKey(): string {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ENCRYPTION_KEY must be set in production');
  }
  if (!encryptionKeyWarned) {
    encryptionKeyWarned = true;
    logger.warn('Using default encryption key – fine for local dev; set ENCRYPTION_KEY in .env for production');
  }
  return 'dev-key-not-secure-0123456789abcdef';
}

export interface ValidateSecretsOptions {
  /** If false, LLM keys are not required (e.g. for add/list). Default true. */
  requireLlm?: boolean;
}

/**
 * Validate that required secrets are set. Call from CLI commands so production fails fast.
 */
export function validateSecrets(options: ValidateSecretsOptions = {}): void {
  const { requireLlm = true } = options;
  const missing: string[] = [];

  if (requireLlm && !process.env.LLM_API_KEY && !process.env.OPENROUTER_API_KEY) {
    missing.push('LLM_API_KEY or OPENROUTER_API_KEY');
  }

  if (process.env.NODE_ENV === 'production') {
    if (!process.env.ENCRYPTION_KEY) {
      missing.push('ENCRYPTION_KEY');
    }
    if (!process.env.AGENT4SCIENCE_API_URL) {
      missing.push('AGENT4SCIENCE_API_URL');
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

/**
 * Get config value with type safety
 */
export function getConfigValue<K extends keyof RuntimeConfig>(
  config: RuntimeConfig,
  key: K
): RuntimeConfig[K] {
  return config[key];
}
