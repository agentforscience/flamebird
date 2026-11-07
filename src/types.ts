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

/** How an agent works on a problem (separate from tone). Unset means the default pipeline. */
export type WorkStyle = 'grinder' | 'intuition' | 'decomposer' | 'checker' | 'reuser';

/** How hard an agent checks its own work before submitting. */
export type SelfCheckLevel = 'off' | 'normal' | 'strict';

/** Optional working settings. Missing values fall back to the defaults in llm/work-style.ts. */
export interface WorkSettings {
  /** Candidate solutions per challenge attempt (default 1). */
  attempts?: number;
  /** Show other agents' prior submissions before solving (default true, up to 3). */
  readOthersFirst?: boolean;
  /** Own-work checking before submit (default 'normal'). */
  selfCheck?: SelfCheckLevel;
}

export interface AgentPersona {
  voice: PersonaVoice;
  epistemics: EpistemicStyle;
  spiceLevel: number; // 0-10
  petPeeves: string[];
  preferredTopics: string[];
  catchphrases: string[];
  /** Optional custom persona markdown loaded from ~/.flamebird/agents/{handle}/persona.md at runtime. Not persisted to DB. */
  customPersonaMarkdown?: string;
  /** Persistent memory loaded from ~/.flamebird/agents/{handle}/memory.md at runtime. Grows over time as agent learns. */
  persistentMemoryMarkdown?: string;
  /** Working style for solving and reviewing. Unset: prompts are unchanged. */
  workStyle?: WorkStyle;
  /** Free-text domain expertise used in solving and reviewing prompts, e.g. "fine-grained complexity". */
  domain?: string;
  /** Working settings (attempts, readOthersFirst, selfCheck). */
  workSettings?: WorkSettings;
  /** Short digest of GET /agents/me/memory, attached at runtime before generating. Not persisted to DB. */
  siteMemoryMarkdown?: string;
  /** Private notes from GET /agents/me/notes, read at session start. Not persisted to DB. */
  siteNotesMarkdown?: string;
  /**
   * The agent's active public positions from the memory digest. Not persisted to DB.
   * undefined: the site did not return positions (prompts ask for none); []: none yet.
   */
  sitePositions?: SitePosition[];
  /** What the owner wants the agent to work on (`flamebird set-focus`). Also sent to the site. */
  focus?: AgentFocus;
  /** How the agent works and argues (`flamebird persona`). Unset: the voice and topics above only. */
  card?: PersonaCard;
  /** This agent's recent openings, newest first, attached before generating. Not persisted to DB. */
  recentOpenings?: RecentOpening[];
  /** Local agent id, attached before generating so openings can be recorded. Not persisted to DB. */
  runtimeAgentId?: string;
  /** Set for one discourse post (comment, take, review): how to open and which move to use. Not persisted. */
  postVariation?: PostVariation;
  /** Set on the one retry after a repeated opening. Not persisted. */
  openingRetryNote?: string;
}

/** A source for a method-of card: the scientist's own published work. */
export interface CardSource {
  title: string;
  year?: number;
  doi?: string;
  arxiv?: string;
  /** resolves | no_record | unchecked (books and other works without a DOI or arXiv ID). */
  check?: 'resolves' | 'no_record' | 'unchecked';
}

/**
 * A persona card: how an agent works, not words it says.
 * - archetype: one of the built-in cards (src/personas/archetypes.ts)
 * - method_of: built from a historical scientist's published methods; every check and move cites a source as [n]
 * - custom: written by the owner
 */
export interface PersonaCard {
  kind: 'archetype' | 'method_of' | 'custom';
  id: string;
  name: string;
  approach: string;
  alwaysChecks: string[];
  moves: string[];
  blindSpots: string[];
  style: string;
  /** method_of only. */
  basedOn?: { scientist: string; died: number; sources: CardSource[] };
}

export interface RecentOpening {
  text: string;
  kind: string;
  openingType?: string;
  usedCatchphrase?: boolean;
  at: string;
}

export interface PostVariation {
  kind: 'comment' | 'take' | 'review';
  opening: { id: string; instruction: string };
  move: string;
}

/** Owner-set focus: topics rank targets ahead of preferredTopics; goal is shown in the attempt decision. */
export interface AgentFocus {
  topics: string[];
  goal?: string;
}

export type PositionAboutType = 'paper' | 'take' | 'review' | 'challenge' | 'submission';

/** A public, revisable belief (GET /agents/{handle}/positions). */
export interface SitePosition {
  id: string;
  claim: string;
  /** How likely the agent thinks the claim is true, 0-1. */
  confidence: number;
  tags?: string[];
  status?: 'active' | 'retracted';
  about?: { type: PositionAboutType; id: string } | null;
  citationChecks?: unknown;
  revisions?: Array<{ from: number; to: number; reason: string; trigger?: { type: string; id: string } | null; at: string }>;
  createdAt?: string;
  updatedAt?: string;
}

/** What an agent can do — drives runtime behavior. */
export type AgentCapability = 'base' | 'neurico';

/** Per-agent LLM override. When set, this agent uses its own model instead of the global default. */
export interface AgentLLMOverride {
  provider: 'openrouter' | 'local' | 'claude';
  model: string;
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
  /** Methods and results (markdown); empty on some papers. */
  experimentPlan?: string;
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
  /** Best public result for the problem (exact value), and its source */
  referenceScore?: number | null;
  referenceLabel?: string | null;
  /** Bound listed for the problem (proven bound, conjecture or estimate; see label) */
  theoreticalScore?: number | null;
  theoreticalLabel?: string | null;
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
  /** Set when the score beat the best public result: candidate, certified or failed */
  sota?: { status: 'candidate' | 'certified' | 'failed'; method?: string; reason?: string } | null;
  createdAt: string;
}

/** One row of GET /api/v1/challenges/:id/leaderboard (each agent's personal best) */
export interface ChallengeLeaderboardEntry {
  rank: number;
  agent: { id: string; handle?: string; displayName?: string; model?: string | null };
  score: number;
  submissionId: string;
  title: string;
  approach: string;
  gapClosed: number | null;
  beatsReference: boolean;
  sota: Agent4ScienceSubmission['sota'];
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
// Agent Working Memory
// ============================================================================

/** A position the agent has taken on a topic, with provenance. */
export interface AgentMemoryPosition {
  topic: string;
  stance: string;
  summary: string;
  /** ID of the comment/take/review where this position was stated. */
  sourceContentId: string;
  confidence: number;
  updatedAt: string;
}

/** Compact record of past exchanges with another agent. */
export interface AgentMemoryRelationship {
  exchanges: number;
  tone: string;
  lastTopic: string;
  lastAt: string;
  /** Last few exchange summaries for continuity (max 3). */
  recentExchanges?: Array<{ topic: string; myStance: string; theirPoint?: string; at: string }>;
}

/** Per-thread memory: what the agent said and argued in a specific discussion thread. */
export interface AgentThreadMemory {
  rootId: string;
  rootTitle: string;
  /** Summary of the agent's overall argument in this thread. */
  myArgument: string;
  /** The agent's comments in this thread (most recent last). */
  myComments: Array<{ intent: string; summary: string; at: string }>;
  /** Key points from others that the agent responded to. */
  keyPoints: Array<{ from: string; point: string }>;
  lastAt: string;
}

/** A recent activity entry with provenance. */
export interface AgentMemoryActivity {
  summary: string;
  /** ID of the action/content that produced this activity. */
  sourceContentId: string;
  at: string;
}

/**
 * Lightweight working memory for an agent.
 * Stored as a single JSON blob in SQLite (~3KB max).
 * Injected into the persona prompt to give interaction continuity.
 */
export interface AgentWorkingMemory {
  positions: AgentMemoryPosition[];
  relationships: Record<string, AgentMemoryRelationship>;
  recentActivity: AgentMemoryActivity[];
  /** Per-thread argument tracking for deep conversation continuity (max 5 threads). */
  threads?: Record<string, AgentThreadMemory>;
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
    provider: 'openrouter' | 'local' | 'claude';
    apiKey: string;
    model: string;
  };
  /** Optional separate model for verifying challenge submissions.
   *  When set, verification uses this model instead of the primary — cross-model
   *  verification catches errors that self-verification misses. */
  verifier?: {
    provider: 'openrouter' | 'local' | 'claude';
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
