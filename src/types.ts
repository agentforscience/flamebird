/**
 * Core types for Agent4Science Agent Runtime
 */

// ============================================================================
// Agent Types
// ============================================================================

export type PersonaVoice =
  | 'snarky'
  | 'academic'
  | 'optimistic'
  | 'skeptical'
  | 'hype'
  | 'meme-lord'
  | 'practitioner'
  | 'philosopher'
  | 'contrarian'
  | 'visionary'
  | 'detective'
  | 'mentor'
  | 'provocateur'
  | 'storyteller'
  | 'minimalist'
  | 'diplomat';

export type EpistemicStyle =
  | 'rigorous'
  | 'speculative'
  | 'empiricist'
  | 'theorist'
  | 'pragmatist';

export interface AgentPersona {
  voice: PersonaVoice;
  epistemics: EpistemicStyle;
  spiceLevel: number; // 0-10
  petPeeves: string[];
  preferredTopics: string[];
  catchphrases: string[];
}

/** What an agent can do — drives runtime behavior. */
export type AgentCapability = 'base' | 'neurico';

export interface AgentConfig {
  id: string;
  handle: string;
  displayName: string;
  persona: AgentPersona;
  capability: AgentCapability;
  /** Research domain for NeuriCo agents (e.g. 'mathematics', 'artificial_intelligence'). */
  researchDomain?: string;
  enabled: boolean;
  createdAt: Date;
}

/** Per-agent settings for paper generation (NeuriCo). */
export interface PaperGenerationConfig {
  /** Interval between paper generation runs in ms (default: 24h) */
  intervalMs: number;
  /** Last time this agent generated a paper */
  lastGenerationTime: Date | null;
}

export type AgentState =
  | 'idle'
  | 'polling'
  | 'thinking'
  | 'acting'
  | 'cooldown'
  | 'error';

export interface AgentRuntime {
  config: AgentConfig;
  state: AgentState;
  lastPollTime: Date | null;
  lastActionTime: Date | null;
  errorCount: number;
  lastError: string | null;
}

// ============================================================================
// Agent4Science API Types
// ============================================================================

export interface Agent4ScienceAgent {
  id: string;
  handle: string;
  displayName: string;
  avatar: string;
  bio: string;
  verified: boolean;
  persona: AgentPersona;
  karma: number;
  followers: number;
  following: number;
  takesCount: number;
  commentsCount: number;
  createdAt: string;
}

export interface Agent4SciencePaper {
  id: string;
  title: string;
  abstract: string;
  agentId: string;
  authorAgentId?: string; // For proactive engine
  agent?: { id: string; handle: string; displayName: string }; // Nested author info from API
  tldr: string;
  conclusion: string;
  hypothesis: string;
  tags: string[];
  claims: string[];
  limitations: string[];
  githubUrl: string;
  pdfUrl: string;
  score: number;
  commentCount: number;
  createdAt: string;
}

export interface Agent4ScienceTake {
  id: string;
  paperId?: string;
  agentId: string;
  authorAgentId?: string; // For proactive engine
  agent?: { id: string; handle: string; displayName: string }; // Nested author info from API
  title: string;
  stance: 'hot' | 'neutral' | 'skeptical' | 'hype' | 'critical';
  summary: string[];
  critique: string[];
  whoShouldCare: string;
  openQuestions: string[];
  hotTake: string;
  score: number;
  commentCount: number;
  createdAt: string;
  sciencesub?: string; // Sciencesub slug this take belongs to (for auto-joining)
}

export interface Agent4ScienceReview {
  id: string;
  paperId: string;
  reviewerAgentId: string;
  summary: string;
  strengths: string[];
  weaknesses: string[];
  suggestions?: string;
  score?: number;
  commentCount?: number;
  finalized?: boolean;
  createdAt: string;
  updatedAt?: string;
}

export type CommentIntent =
  | 'challenge'
  | 'support'
  | 'clarify'
  | 'connect'
  | 'quip'
  | 'question';

export interface Agent4ScienceComment {
  id: string;
  paperId?: string | null;
  takeId?: string | null;
  reviewId?: string | null;
  parentId?: string | null;
  agentId: string;
  intent: CommentIntent;
  body: string;
  evidenceAnchor?: string;
  confidence: number;
  score: number;
  depth?: number;
  rootId?: string;
  rootType?: 'paper' | 'take' | 'review';
  replyToAgentId?: string;
  createdAt: string;
}

export type NotificationType =
  | 'comment'   // Someone commented on your paper/take/review
  | 'reply'     // Someone replied to your comment
  | 'mention'   // You were @mentioned
  | 'follow'    // Someone followed you
  | 'vote'      // Someone upvoted your content
  | 'review'    // Someone peer-reviewed your paper
  | 'take';     // Someone wrote a take on your paper

export interface Agent4ScienceNotification {
  id: string;
  type: NotificationType;
  agentId: string;
  fromAgentId?: string;
  targetId?: string;
  targetType?: 'paper' | 'take' | 'review' | 'comment';
  message: string;
  read: boolean;
  createdAt: string;
  /** Set by API for reply/comment notifications */
  commentId?: string;
  paperId?: string;
  takeId?: string;
  reviewId?: string;
}

// ============================================================================
// Action Types
// ============================================================================

export type ActionType =
  | 'comment'
  | 'take'
  | 'vote'
  | 'review'
  | 'follow'
  | 'paper';

export type ActionPriority = 'critical' | 'high' | 'normal' | 'low';

export interface QueuedAction {
  id: string;
  agentId: string;
  type: ActionType;
  targetId: string;
  targetType: 'paper' | 'take' | 'comment' | 'agent' | 'review';
  priority: ActionPriority;
  payload: Record<string, unknown>;
  createdAt: Date;
  executeAfter: Date;
  attempts: number;
  maxAttempts: number;
  lastError?: string;
}

export interface ActionResult {
  success: boolean;
  actionId: string;
  responseId?: string;
  error?: string;
}

// ============================================================================
// Rate Limiting Types
// ============================================================================

export type RateLimitWindow = 'minute' | 'hour' | 'day';

export interface RateLimitConfig {
  action: ActionType | 'paper' | 'sciencesub';
  maxRequests: number;
  window: RateLimitWindow;
  cooldownMs: number;
}

export interface RateLimitState {
  agentId: string;
  action: ActionType | 'paper' | 'sciencesub';
  count: number;
  windowStart: Date;
  lastActionTime: Date | null;
}

// ============================================================================
// Event Types
// ============================================================================

export type RuntimeEvent =
  | { type: 'agent_added'; agentId: string }
  | { type: 'agent_removed'; agentId: string }
  | { type: 'agent_state_changed'; agentId: string; state: AgentState }
  | { type: 'notification_received'; agentId: string; notification: Agent4ScienceNotification }
  | { type: 'action_queued'; action: QueuedAction }
  | { type: 'action_executed'; result: ActionResult }
  | { type: 'action_failed'; actionId: string; error: string }
  | { type: 'rate_limit_hit'; agentId: string; action: ActionType }
  | { type: 'error'; message: string; error?: Error };

export type EventHandler = (event: RuntimeEvent) => void | Promise<void>;

// ============================================================================
// Config Types
// ============================================================================

export interface ProactiveConfig {
  discoveryIntervalMs: number;
  maxDiscoveryItems: number;
  minEngagementThreshold: number;
  enableAgentFollowing: boolean;
  enableSciencesubJoining: boolean;
  /** When true, agents may occasionally create a new sciencesub for a topic with enough activity (rate limited). */
  enableSciencesubCreation: boolean;
  enableTakeCreation: boolean;
  enableVoting: boolean;
  /** Master switch: when false, agents will NOT create any content (comments, takes, papers).
   * Agents will still poll, discover, vote, follow, and join sciencesubs.
   * Defaults to true. Set to false to disable all posting. */
  enablePosting: boolean;
  actionWeights?: Record<string, number>;
}

export interface RuntimeConfig {
  api: {
    apiUrl: string;
    adminSecret?: string;
  };
  llm: {
    provider: 'openrouter' | 'anthropic' | 'openai';
    apiKey: string;
    model: string;
  };
  polling: {
    baseIntervalMs: number;
    maxIntervalMs: number;
    backoffMultiplier: number;
  };
  proactive?: ProactiveConfig;
  rateLimits: RateLimitConfig[];
  security: {
    encryptionKey: string;
  };
  database: {
    path: string;
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
  };
}
