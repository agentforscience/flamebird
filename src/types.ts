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
  /** Optional custom persona markdown loaded from ~/.flamebird/agents/{handle}/persona.md at runtime. Not persisted to DB. */
  customPersonaMarkdown?: string;
}

/** What an agent can do — drives runtime behavior. */
export type AgentCapability = 'base' | 'neurico';

/** Per-agent LLM override. When set, this agent uses its own model instead of the global default. */
export interface AgentLLMOverride {
  provider: 'openrouter' | 'anthropic' | 'openai';
  model: string;
  /** Optional separate API key; falls back to global key when omitted. */
  apiKey?: string;
}

export interface AgentConfig {
  id: string;
  handle: string;
  displayName: string;
  persona: AgentPersona;
  capability: AgentCapability;
  /** Research domain for NeuriCo agents (e.g. 'mathematics', 'artificial_intelligence'). */
  researchDomain?: string;
  /** Per-agent backbone override for benchmark experiments (B4–B7 protocols). */
  llmOverride?: AgentLLMOverride;
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
  title?: string;
  agent?: { id: string; handle: string; displayName: string; avatar?: string; verified?: boolean } | null;
  paper?: { id: string; title: string; tags?: string[] } | null;
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

export type ChallengeStatus = 'open' | 'closed' | 'archived';
export type EvaluationType = 'deterministic' | 'llm-judged' | 'hybrid';
export type ScoringDirection = 'maximize' | 'minimize';
export type EvaluationStatus = 'pending' | 'evaluating' | 'evaluated' | 'failed';
export type CritiqueIntent = 'challenge' | 'support' | 'probe' | 'extend';

export interface Agent4ScienceChallenge {
  id: string;
  title: string;
  description: string;
  agentId: string;
  agent?: { id: string; handle: string; displayName: string };
  tags: string[];
  sciencesub?: string;
  status: ChallengeStatus;
  closesAt: string;
  // Evaluation configuration
  evaluationType: EvaluationType;
  scoringDirection?: ScoringDirection;
  verifier?: string;
  solutionSchema?: Record<string, unknown>;
  minImprovement?: number;
  requiredFields?: Array<{ name: string; description: string; minLength?: number }>;
  constraints?: Array<{ id: string; description: string; automatable: boolean }>;
  submissionCount: number;
  createdAt: string;
}

export interface T1Check {
  name: string;
  passed: boolean;
  severity: 'schema' | 'diagnostic';
  message: string;
}

export interface T1Result {
  valid: boolean;
  checks: T1Check[];
  schemaFailures: string[];
  diagnosticFlags: string[];
}

export interface PeerCritique {
  agentId: string;
  intent: CritiqueIntent;
  content: string;
  timestamp: string;
}

export interface T2Scores {
  /** Net peer score: upvotes - downvotes */
  netPeerScore: number;
  /** Critique ratio: supportive critiques / total critiques (0-1) */
  critiqueRatio: number;
  /** Rolling summary of peer feedback */
  rollingSummary: string;
  /** Individual peer critiques */
  critiques: PeerCritique[];
  upvotes: number;
  downvotes: number;
  /** Normalized composite peer score (0-1) */
  normalizedScore: number;
}

export interface Agent4ScienceSubmission {
  id: string;
  challengeId: string;
  agentId: string;
  agent?: { id: string; handle: string; displayName: string };
  title: string;
  body: string;
  approach: string;
  improvesUpon: string | null;
  delta: string | null;
  declaredScore: number | null;
  solutionData?: Record<string, unknown>;
  score: number;
  version: number;
  commentCount: number;
  // Evaluation results
  evaluationStatus: EvaluationStatus;
  t1Result?: T1Result;
  t2Scores?: T2Scores;
  verifierScore?: number | null;
  evaluatedScore?: number | null;
  createdAt: string;
}

export type CommentIntent =
  | 'challenge'    // Push back on a claim, method, or interpretation with a specific objection
  | 'support'      // Agree AND provide additional evidence, reasoning, or a strengthening argument
  | 'clarify'      // Request or provide precision on an ambiguous point
  | 'connect'      // Draw a link between this work and another paper, field, or concept
  | 'quip'         // Short, witty remark that still adds substance
  | 'summarize'    // Distill the key points or takeaways
  | 'question'     // Ask a direct question about the work
  | 'extend'       // Build on the idea: new implications, applications, or connections to other work
  | 'probe'        // Ask a substantive question that exposes a gap, assumption, or unstated dependency
  | 'synthesize';  // Connect multiple threads, papers, or perspectives into a coherent frame

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
  | 'comment'      // Someone commented on your paper/take/review/challenge/submission
  | 'reply'        // Someone replied to your comment
  | 'mention'      // You were @mentioned
  | 'follow'       // Someone followed you
  | 'vote'         // Someone upvoted your content
  | 'review'       // Someone peer-reviewed your paper
  | 'take'         // Someone wrote a take on your paper
  | 'challenge'    // A new challenge was posted
  | 'submission'   // Someone submitted a solution to your challenge
  | 'improvement'; // Someone built on your submission (improvesUpon)

export interface Agent4ScienceNotification {
  id: string;
  type: NotificationType;
  agentId: string;
  fromAgentId?: string;
  targetId?: string;
  targetType?: 'paper' | 'take' | 'review' | 'comment' | 'challenge' | 'submission';
  message: string;
  read: boolean;
  createdAt: string;
  /** Set by API for reply/comment notifications */
  commentId?: string;
  paperId?: string;
  takeId?: string;
  reviewId?: string;
  challengeId?: string;
  submissionId?: string;
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
  | 'paper'
  | 'submission';

export type ActionPriority = 'critical' | 'high' | 'normal' | 'low';

export interface QueuedAction {
  id: string;
  agentId: string;
  type: ActionType;
  targetId: string;
  targetType: 'paper' | 'take' | 'comment' | 'agent' | 'review' | 'challenge' | 'submission';
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
  action: ActionType | 'paper' | 'sciencesub' | 'challenge';
  maxRequests: number;
  window: RateLimitWindow;
  cooldownMs: number;
}

export interface RateLimitState {
  agentId: string;
  action: ActionType | 'paper' | 'sciencesub' | 'challenge';
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
  /** Optional separate model for verifying challenge submissions.
   *  When set, verification uses this model instead of the primary — cross-model
   *  verification catches errors that self-verification misses. */
  verifier?: {
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
