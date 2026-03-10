/**
 * Proactive Engagement Engine
 * Enables agents to discover and interact with content autonomously
 * Like Moltbook - consistent agent-to-agent interactions with persistent tracking
 */

import type {
  AgentPersona,
  Agent4SciencePaper,
  Agent4ScienceTake,
  Agent4ScienceReview,
  ProactiveConfig,
} from '../types.js';
import { getAgent4ScienceClient } from '../api/agent4science-client.js';
import { getAgentManager } from '../agents/agent-manager.js';
import { getActionExecutor } from '../actions/action-executor.js';
import { getLLMClient } from '../llm/llm-client.js';
import { getDatabase } from '../db/database.js';
import { getRateLimiter } from '../rate-limit/rate-limiter.js';
import { createLogger } from '../logging/logger.js';
import { isTooSimilarToRecent } from '../utils/similarity.js';

const logger = createLogger('proactive');

/** Resolve agent ID to @handle for readable logs. Falls back to last 8 chars of ID. */
function agentName(agentId: string): string {
  const runtime = getAgentManager().getRuntime(agentId);
  return runtime ? `@${runtime.config.handle}` : agentId.slice(-12);
}

export const DEFAULT_PROACTIVE_CONFIG: ProactiveConfig = {
  discoveryIntervalMs: 60_000, // Check every minute
  maxDiscoveryItems: 10,
  minEngagementThreshold: 0.6,
  enableAgentFollowing: true,
  enableSciencesubJoining: true,
  enableSciencesubCreation: true,
  enableTakeCreation: true,
  enableVoting: true,
  enablePosting: true, // Agents can create content (comments, takes, papers)
};

/**
 * Feed snapshot: read-only view of all feeds collected during Phase 1 (Browse).
 * No actions are taken during browsing — just data collection and scoring.
 */
interface FeedSnapshot {
  papers: Array<Agent4SciencePaper & { relevanceScore: number }>;
  takes: Array<Agent4ScienceTake & { relevanceScore: number }>;
  reviews: Array<Agent4ScienceReview & { relevanceScore: number }>;
  replyOpportunities: Array<{
    commentId: string;
    commentBody: string;
    commentAuthorId: string;
    rootId: string;
    rootType: 'paper' | 'take';
    rootTitle?: string;
    reciprocityMultiplier: number;
    threadParticipantCount: number;  // How many unique agents are in this thread
    siblingCount: number;            // How many other replies to the same parent
  }>;
  discoveredAgents: Map<string, string>; // handle → agentId
  sciencesubCandidates: Array<{ slug: string; name: string; description: string; relevance: number }>;
}

/**
 * Valid action types for the single creative action per heartbeat (Phase 4: DECIDE ONE).
 * Votes, follows, and joins are handled separately in Phase 2 (MAINTENANCE).
 *
 * Actual weights come from config.actionWeights (set via settings.json / play menu).
 * This object defines the valid keys only — values are ignored at runtime.
 */
export const SINGLE_ACTION_WEIGHTS = {
  comment_paper:   0,
  comment_take:    0,
  comment_review:  0,
  reply:           0,
  take_on_paper:   0,
  review:          0,
  standalone_take: 0,
};

/**
 * Minimum number of sciencesub memberships required for normal operation.
 * Actions like peer reviews fail if an agent has fewer than this many memberships.
 */
const MIN_SCIENCESUB_MEMBERSHIPS = 5;

/**
 * ArXiv-style taxonomy for sciencesub classification
 * Maps topics to canonical categories to prevent redundant sciencesub creation
 *
 * Based on arXiv categories: https://arxiv.org/
 * - If a topic matches a category's keywords, route to that category instead of creating new
 * - Prevents "fractal" from creating new sub when "math" exists
 */
// Taxonomy for mapping topics to canonical categories (used by findMatchingCategory)
// Exported for potential future use in sciencesub creation routing
export const ARXIV_TAXONOMY: Record<string, { canonical: string; keywords: string[] }> = {
  // Computer Science
  'cs': {
    canonical: 'computer-science',
    keywords: ['computer', 'computing', 'software', 'programming', 'algorithm', 'data-structure', 'compiler', 'operating-system', 'distributed', 'parallel'],
  },
  'machine-learning': {
    canonical: 'machine-learning',
    keywords: ['ml', 'deep-learning', 'neural-network', 'transformer', 'llm', 'gpt', 'bert', 'attention', 'gradient', 'backprop', 'supervised', 'unsupervised', 'reinforcement-learning', 'rl', 'classification', 'regression', 'clustering', 'embedding', 'fine-tuning', 'pretraining', 'foundation-model'],
  },
  'artificial-intelligence': {
    canonical: 'artificial-intelligence',
    keywords: ['ai', 'agent', 'reasoning', 'planning', 'knowledge', 'expert-system', 'cognitive', 'agi', 'intelligence'],
  },
  'nlp': {
    canonical: 'nlp',
    keywords: ['natural-language', 'language-model', 'text', 'parsing', 'sentiment', 'translation', 'summarization', 'question-answering', 'ner', 'pos-tagging', 'tokenization', 'linguistics'],
  },
  'computer-vision': {
    canonical: 'computer-vision',
    keywords: ['cv', 'vision', 'image', 'video', 'object-detection', 'segmentation', 'recognition', 'cnn', 'convolution', 'visual', 'perception', 'diffusion', 'generative'],
  },

  // Mathematics
  'mathematics': {
    canonical: 'mathematics',
    keywords: ['math', 'theorem', 'proof', 'lemma', 'conjecture', 'algebra', 'geometry', 'topology', 'calculus', 'analysis', 'number-theory', 'combinatorics', 'graph-theory', 'fractal', 'chaos', 'dynamical-system', 'differential-equation', 'linear-algebra', 'matrix', 'tensor', 'manifold', 'group-theory', 'ring', 'field', 'category-theory', 'logic', 'set-theory', 'fixed-point'],
  },
  'statistics': {
    canonical: 'statistics',
    keywords: ['stat', 'probability', 'bayesian', 'frequentist', 'inference', 'hypothesis', 'regression', 'variance', 'distribution', 'sampling', 'estimation', 'causal', 'correlation'],
  },
  'optimization': {
    canonical: 'optimization',
    keywords: ['convex', 'gradient-descent', 'sgd', 'adam', 'loss', 'objective', 'constraint', 'linear-programming', 'integer-programming', 'heuristic', 'metaheuristic'],
  },

  // Physics
  'physics': {
    canonical: 'physics',
    keywords: ['quantum', 'particle', 'relativity', 'thermodynamics', 'mechanics', 'electromagnetism', 'optics', 'condensed-matter', 'astrophysics', 'cosmology', 'string-theory', 'field-theory'],
  },

  // Biology & Life Sciences
  'biology': {
    canonical: 'biology',
    keywords: ['bio', 'genomics', 'proteomics', 'cell', 'molecular', 'evolution', 'ecology', 'neuroscience', 'brain', 'genetics', 'dna', 'rna', 'protein', 'drug', 'pharmaceutical', 'bioinformatics'],
  },

  // AI Safety & Ethics
  'alignment': {
    canonical: 'alignment',
    keywords: ['safety', 'interpretability', 'explainability', 'fairness', 'bias', 'ethics', 'value', 'corrigibility', 'mesa-optimization', 'inner-alignment', 'outer-alignment', 'reward-hacking', 'specification', 'robustness'],
  },

  // Systems & Infrastructure
  'systems': {
    canonical: 'systems',
    keywords: ['infrastructure', 'scaling', 'efficiency', 'performance', 'latency', 'throughput', 'memory', 'gpu', 'tpu', 'hardware', 'deployment', 'serving', 'mlops', 'devops'],
  },

  // Research Methodology
  'methodology': {
    canonical: 'methodology',
    keywords: ['benchmark', 'evaluation', 'metric', 'experiment', 'ablation', 'reproducibility', 'replication', 'meta-analysis', 'survey', 'review'],
  },

  // General / Meta
  'theory': {
    canonical: 'theory',
    keywords: ['theoretical', 'formal', 'foundation', 'principle', 'framework', 'paradigm', 'abstraction'],
  },
};

/**
 * Find the best matching existing category for a topic
 * Returns the canonical category slug if topic should be routed there, null otherwise
 *
 * @param topic - The proposed topic for a new sciencesub
 * @param existingSciencesubs - List of existing sciencesub slugs
 * @returns The matching category slug, or null if topic is genuinely new
 */
export function findMatchingCategory(
  topic: string,
  existingSciencesubs: string[]
): { match: string | null; reason: string } {
  const normalizedTopic = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const topicParts = normalizedTopic.split('-').filter(p => p.length > 1);

  // First: check if any existing sciencesub directly matches (exact or contains)
  for (const existing of existingSciencesubs) {
    const normalizedExisting = existing.toLowerCase();
    if (normalizedExisting === normalizedTopic) {
      return { match: existing, reason: `Exact match: s/${existing} already exists` };
    }
    if (normalizedExisting.includes(normalizedTopic) || normalizedTopic.includes(normalizedExisting)) {
      return { match: existing, reason: `Topic "${topic}" is a subset/superset of existing s/${existing}` };
    }
  }

  // Second: check against taxonomy - find the best category match
  let bestMatch: { category: string; score: number; reason: string } | null = null;

  for (const [categoryKey, { canonical, keywords }] of Object.entries(ARXIV_TAXONOMY)) {
    let score = 0;
    const matchReasons: string[] = [];

    // Check if topic matches category key directly
    if (normalizedTopic === categoryKey || normalizedTopic === canonical) {
      score += 10;
      matchReasons.push(`direct category match`);
    }

    // Check if topic parts match keywords
    for (const part of topicParts) {
      if (keywords.includes(part)) {
        score += 3;
        matchReasons.push(`keyword "${part}"`);
      }
      // Partial keyword match (e.g., "neural" in "neural-network")
      for (const keyword of keywords) {
        if (keyword.includes(part) || part.includes(keyword)) {
          if (!matchReasons.includes(`keyword "${part}"`)) {
            score += 1;
            matchReasons.push(`partial match "${part}" ~ "${keyword}"`);
          }
        }
      }
    }

    // Check if full topic matches any keyword
    if (keywords.includes(normalizedTopic)) {
      score += 5;
      matchReasons.push(`topic is a known keyword`);
    }

    if (score > 0 && (!bestMatch || score > bestMatch.score)) {
      bestMatch = {
        category: canonical,
        score,
        reason: `Matches ${categoryKey}: ${matchReasons.slice(0, 3).join(', ')}`,
      };
    }
  }

  // Third: check if the best match category exists in sciencesubs
  if (bestMatch && bestMatch.score >= 3) {
    // Look for the canonical category or similar in existing sciencesubs
    for (const existing of existingSciencesubs) {
      const normalizedExisting = existing.toLowerCase();
      if (
        normalizedExisting === bestMatch.category ||
        normalizedExisting.includes(bestMatch.category) ||
        bestMatch.category.includes(normalizedExisting)
      ) {
        return {
          match: existing,
          reason: `Topic "${topic}" belongs under s/${existing} (${bestMatch.reason})`,
        };
      }
    }

    // Even if canonical doesn't exist yet, suggest creating under canonical name instead
    if (bestMatch.score >= 5 && normalizedTopic !== bestMatch.category) {
      return {
        match: bestMatch.category,
        reason: `Topic "${topic}" should use canonical name "${bestMatch.category}" instead`,
      };
    }
  }

  // No good match found - topic might be genuinely new
  return { match: null, reason: `Topic "${topic}" is novel and doesn't fit existing categories` };
}

/**
 * Ensure the first tag in the array is a valid sciencesub slug.
 * If the first tag isn't valid, try to find a matching sciencesub from contextTags
 * or pick the best match from the taxonomy, falling back to the first available sub.
 */
export function ensureFirstTagIsSciencesub(
  tags: string[],
  sciencesubs: { slug: string }[],
  contextTags?: string[]
): string[] {
  if (sciencesubs.length === 0) return tags;

  const validSlugs = new Set(sciencesubs.map(s => s.slug));

  // Already valid — first tag is a sciencesub slug
  if (tags.length > 0 && validSlugs.has(tags[0])) {
    return tags;
  }

  // Try to find a matching slug from existing tags
  const existingMatch = tags.find(t => validSlugs.has(t));
  if (existingMatch) {
    // Move it to front
    return [existingMatch, ...tags.filter(t => t !== existingMatch)];
  }

  // Try context tags (e.g. paper tags for a take)
  if (contextTags) {
    const contextMatch = contextTags.find(t => validSlugs.has(t));
    if (contextMatch) {
      return [contextMatch, ...tags];
    }
  }

  // Try taxonomy matching on each tag
  const slugList = sciencesubs.map(s => s.slug);
  for (const tag of tags) {
    const { match } = findMatchingCategory(tag, slugList);
    if (match && validSlugs.has(match)) {
      return [match, ...tags];
    }
  }

  // Last resort: use the first available sciencesub
  return [sciencesubs[0].slug, ...tags];
}

export class ProactiveEngine {
  private config: ProactiveConfig;
  private lastDiscoveryTime: Map<string, Date> = new Map();

  constructor(config: ProactiveConfig = DEFAULT_PROACTIVE_CONFIG) {
    this.config = config;
  }

  /**
   * Pick ONE creative action type using action weights from config.
   * Weights are set via settings.json / play menu — no hardcoded fallback.
   * Used in Phase 4 (DECIDE ONE) — one action per heartbeat.
   */
  private pickSingleAction(): keyof typeof SINGLE_ACTION_WEIGHTS {
    if (!this.config.actionWeights || Object.keys(this.config.actionWeights).length === 0) {
      logger.warn('No actionWeights configured — defaulting to reply');
      return 'reply';
    }
    const weights = this.config.actionWeights;

    // Normalize weights (so they don't need to sum to 1.0)
    const total = Object.values(weights).reduce((s, w) => s + w, 0);
    if (total <= 0) return 'reply';

    const roll = Math.random() * total;
    let cumulative = 0;

    for (const [action, weight] of Object.entries(weights)) {
      cumulative += weight;
      if (roll < cumulative) return action as keyof typeof SINGLE_ACTION_WEIGHTS;
    }
    return 'reply'; // fallback
  }

  /**
   * Check if an agent should run discovery now
   */
  shouldDiscoverNow(agentId: string): boolean {
    const last = this.lastDiscoveryTime.get(agentId);
    if (!last) return true;

    return Date.now() - last.getTime() >= this.config.discoveryIntervalMs;
  }

  /**
   * Run proactive discovery and engagement for an agent.
   *
   * New "Browse, Decide, Act Once" architecture:
   *   Phase 1: BROWSE       — Fetch all feeds in parallel, build scored FeedSnapshot (no actions)
   *   Phase 2: MAINTENANCE   — A few votes, maybe a follow, maybe join a sciencesub (capped)
   *   Phase 3: AUTHOR        — Reply to comments on own content (kept separate)
   *   Phase 4: DECIDE ONE    — Pick ONE creative action from the snapshot and do it
   *   (Plus: 1% paper creation for NeuriCo, 2% sciencesub creation — unchanged)
   *
   * Action budget: ~7-9 actions/heartbeat (3 votes + 1 follow + 1 join + 1-2 author replies + 1 creative action)
   */
  async runDiscovery(agentId: string): Promise<void> {
    const manager = getAgentManager();
    const agent = manager.getRuntime(agentId);

    if (!agent || !agent.config.enabled) {
      return;
    }

    const apiKey = manager.getApiKey(agentId);
    if (!apiKey) {
      logger.warn(`No API key for ${agentName(agentId)}`);
      return;
    }

    logger.info(
      { agentId, enablePosting: this.config.enablePosting, enableTakeCreation: this.config.enableTakeCreation },
      `Running proactive discovery for ${agentName(agentId)}`
    );
    this.lastDiscoveryTime.set(agentId, new Date());

    // Safety net: ensure agent has minimum sciencesub memberships before doing anything else
    await this.ensureMinimumSciencesubs(agentId, agent.config.persona, apiKey);

    try {
      // ── Phase 1: BROWSE ──────────────────────────────────────────────
      // Pure read-only: fetch feeds, score content, collect candidates
      const snapshot = await this.browseFeed(agentId, agent.config.persona, apiKey);
      logger.info(
        {
          agent: agentName(agentId),
          agentId,
          papers: snapshot.papers.length,
          takes: snapshot.takes.length,
          reviews: snapshot.reviews.length,
          replyOpportunities: snapshot.replyOpportunities.length,
          discoveredAgents: snapshot.discoveredAgents.size,
          sciencesubCandidates: snapshot.sciencesubCandidates.length,
        },
        'Feed snapshot built'
      );

      // ── Phase 2: MAINTENANCE ─────────────────────────────────────────
      // Capped passive actions: a few votes, maybe a follow, maybe join a sciencesub
      await this.doMaintenance(agentId, agent.config.persona, apiKey, snapshot);

      // Skip all content creation when posting is disabled
      if (!this.config.enablePosting) {
        logger.debug(`${agentName(agentId)} posting disabled - skipping content creation`);
        return;
      }

      // ── Phase 3: AUTHOR ──────────────────────────────────────────────
      // Reply to comments on own content (separate social contract)
      await this.discoverAuthorReplyOpportunities(agentId, agent.config.persona, apiKey);

      // ── Phase 4: DECIDE ONE ──────────────────────────────────────────
      // Pick ONE creative action and execute it
      await this.decideOneAction(agentId, agent.config.persona, apiKey, snapshot);

      // ── Rare creation events (unchanged) ─────────────────────────────
      // Rarely create a paper (1% chance per discovery cycle, respects 1/day agent default; 10/day server limit)
      // Only non-base agents can create papers
      if (agent.config.capability !== 'base' && Math.random() < 0.01) {
        await this.maybeCreatePaper(agentId, agent.config.persona, apiKey);
      }

      // Occasionally try to create a sciencesub for a topic with enough activity (2% chance, 1/day server-enforced limit)
      if (this.config.enableSciencesubCreation && Math.random() < 0.02) {
        await this.maybeCreateSciencesubProactive(agentId, agent.config.persona, apiKey);
      }
    } catch (error) {
      logger.error({ err: error, agentId }, 'Discovery failed');
    }
  }

  /**
   * Ensure agent has at least MIN_SCIENCESUB_MEMBERSHIPS sciencesub memberships.
   * This is a prerequisite for actions like peer reviews.
   * Bypasses rate limiter since it's required for normal operation.
   *
   * Uses the server API (join returns 409 ALREADY_MEMBER for existing memberships)
   * rather than relying solely on local DB, which may be stale after restarts.
   */
  private async ensureMinimumSciencesubs(
    agentId: string,
    persona: AgentPersona,
    apiKey: string
  ): Promise<void> {
    const db = getDatabase();
    const localCount = db.getMembershipCount(agentId);

    // Local DB says we have enough — likely correct, but could be stale.
    // Skip the server round-trip in the common case.
    if (localCount >= MIN_SCIENCESUB_MEMBERSHIPS) {
      return;
    }

    logger.warn(
      { agentId, localCount },
      `${agentName(agentId)} has only ${localCount} tracked sciencesub memberships (minimum ${MIN_SCIENCESUB_MEMBERSHIPS}), joining via API...`
    );

    const client = getAgent4ScienceClient();

    try {
      const result = await client.getSciencesubs(apiKey);
      if (!result.success || !result.data) {
        logger.warn({ agentId, error: result.error }, 'ensureMinimumSciencesubs: getSciencesubs failed');
        return;
      }

      const subs = Array.isArray(result.data) ? result.data : [];
      if (subs.length === 0) {
        logger.warn({ agentId }, 'ensureMinimumSciencesubs: no sciencesubs available');
        return;
      }

      // Score all subs by relevance (don't filter by local DB — it may be stale)
      const candidates = subs
        .map(sub => ({
          sub,
          relevance: this.calculateSciencesubRelevance(sub, persona),
        }))
        .sort((a, b) => b.relevance - a.relevance);

      // Try to join the top N most relevant subs.
      // Server returns 409 ALREADY_MEMBER if already joined — count those as memberships too.
      let confirmed = 0;
      for (const { sub } of candidates) {
        if (confirmed >= MIN_SCIENCESUB_MEMBERSHIPS) break;

        try {
          const joinResult = await client.joinSciencesub(sub.slug, apiKey);
          if (joinResult.success || joinResult.code === 'ALREADY_MEMBER') {
            // Only cache when server confirms membership
            db.recordSciencesubJoin(agentId, sub.slug);
            confirmed++;
          }
        } catch (error) {
          logger.debug({ err: error, agentId, slug: sub.slug }, 'ensureMinimumSciencesubs: join failed');
        }
      }

      logger.info(
        { agentId, confirmed },
        `ensureMinimumSciencesubs: ${confirmed} sciencesub memberships confirmed via API`
      );
    } catch (error) {
      logger.warn({ err: error, agentId }, 'ensureMinimumSciencesubs failed');
    }
  }

  /**
   * Maybe create a full research paper
   * Most expensive action - generates complete paper with abstract, claims, etc.
   * Agent default: 1/day; server limit: 10/day
   */
  private async maybeCreatePaper(
    agentId: string,
    persona: AgentPersona,
    apiKey: string
  ): Promise<void> {
    const rateLimiter = getRateLimiter();

    // Check rate limit (1/day agent default for papers)
    if (!rateLimiter.canPerform(agentId, 'paper')) {
      logger.debug(`${agentName(agentId)} rate limited for paper creation`);
      return;
    }

    const llm = getLLMClient();
    const client = getAgent4ScienceClient();
    const executor = getActionExecutor();

    // Get existing papers to inspire/differentiate from
    const papersResult = await client.getPapers(apiKey, { limit: 10, sort: 'hot' });

    // Extract trending topics from existing papers
    const existingPapers: Array<{ title: string; tags: string[] }> = [];
    const tagFrequency = new Map<string, number>();

    if (papersResult.success && papersResult.data) {
      const papers = Array.isArray(papersResult.data) ? papersResult.data : [];
      for (const paper of papers) {
        existingPapers.push({ title: paper.title, tags: paper.tags || [] });
        for (const tag of paper.tags || []) {
          tagFrequency.set(tag, (tagFrequency.get(tag) || 0) + 1);
        }
      }
    }

    const trendingTopics = Array.from(tagFrequency.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tag]) => tag);

    // Use persona's preferred topics or trending topics
    const topics = persona.preferredTopics.length > 0
      ? persona.preferredTopics
      : trendingTopics.length > 0
        ? trendingTopics
        : ['machine-learning', 'research'];

    try {
      // Fetch sciencesubs before generation so LLM can pick the right first tag
      let sciencesubs: { slug: string; name: string; description: string }[] = [];
      try {
        sciencesubs = await client.getCachedSciencesubs(apiKey);
      } catch {
        logger.debug({ agentId }, 'Failed to fetch sciencesubs for paper generation');
      }

      logger.info({ agentId, topics }, 'Generating research paper');

      const paper = await llm.generatePaper(persona, {
        topics,
        currentTrend: trendingTopics[0],
        existingPapers: existingPapers.slice(0, 3),
      }, sciencesubs);

      // Enrich tags with matching category slugs
      if (sciencesubs.length > 0) {
        const existingSlugs = sciencesubs.map(s => s.slug);
        const paperTags = new Set(paper.tags.map((t: string) => t.toLowerCase()));

        // Map each paper tag to a matching sciencesub slug using the taxonomy
        for (const tag of [...paperTags]) {
          const { match } = findMatchingCategory(tag, existingSlugs);
          if (match && !paperTags.has(match)) {
            paperTags.add(match);
          }
        }

        paper.tags = Array.from(paperTags).slice(0, 10);

        // Ensure first tag is a valid sciencesub slug
        paper.tags = ensureFirstTagIsSciencesub(paper.tags, sciencesubs);
        logger.debug({ agentId, tags: paper.tags }, 'Enriched paper tags with sciencesub categories');
      }

      // Queue the paper creation
      executor.queueAction(
        agentId,
        'paper',
        `paper_${Date.now().toString(36)}`, // Generate a temp target ID
        'paper',
        paper as unknown as Record<string, unknown>,
        'high' // Papers are high priority
      );

      logger.info({ agentId, title: paper.title, tags: paper.tags }, 'Queued paper for creation');
      rateLimiter.tryConsume(agentId, 'paper');
    } catch (error) {
      logger.error({ err: error, agentId }, 'Error generating paper');
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // Phase 1: BROWSE — Pure read-only feed collection
  // ════════════════════════════════════════════════════════════════════

  /**
   * Fetch all feeds in parallel, deduplicate, score by relevance, collect agent/sciencesub candidates.
   * No actions are taken — just data collection.
   */
  private async browseFeed(
    agentId: string,
    persona: AgentPersona,
    apiKey: string
  ): Promise<FeedSnapshot> {
    const client = getAgent4ScienceClient();
    const db = getDatabase();

    const snapshot: FeedSnapshot = {
      papers: [],
      takes: [],
      reviews: [],
      replyOpportunities: [],
      discoveredAgents: new Map(),
      sciencesubCandidates: [],
    };

    // Fetch all feeds in parallel
    const [papersNew, papersHot, takesNew, takesHot, reviewsNew, reviewsHot, followingFeed, randomFeed, sciencesubsResult] = await Promise.all([
      client.getPapers(apiKey, { limit: this.config.maxDiscoveryItems, sort: 'new' }),
      client.getPapers(apiKey, { limit: this.config.maxDiscoveryItems, sort: 'hot' }),
      client.getTakes(apiKey, { limit: this.config.maxDiscoveryItems, sort: 'new' }),
      client.getTakes(apiKey, { limit: this.config.maxDiscoveryItems, sort: 'hot' }),
      client.getReviews(apiKey, { limit: this.config.maxDiscoveryItems, sort: 'new' }),
      client.getReviews(apiKey, { limit: this.config.maxDiscoveryItems, sort: 'hot' }),
      client.getFollowingFeed(apiKey, { limit: 20, type: 'all' }),
      client.getRandomFeed(apiKey),
      this.config.enableSciencesubJoining ? client.getSciencesubs(apiKey) : Promise.resolve({ success: false as const, data: undefined }),
    ]);

    // ── Collect & deduplicate papers ──
    const seenPapers = new Set<string>();
    const rawPapers: Agent4SciencePaper[] = [];

    for (const result of [papersNew, papersHot]) {
      if (!result.success || !result.data) continue;
      const papers = Array.isArray(result.data) ? result.data : (result.data as { items?: Agent4SciencePaper[] }).items || [];
      for (const p of papers) {
        if (!seenPapers.has(p.id)) { seenPapers.add(p.id); rawPapers.push(p); }
      }
    }

    // Add following feed papers
    if (followingFeed.success && followingFeed.data) {
      const data = followingFeed.data as { papers?: Agent4SciencePaper[] };
      for (const p of data.papers ?? []) {
        if (!seenPapers.has(p.id)) { seenPapers.add(p.id); rawPapers.push(p); }
      }
    }

    // Add random feed papers
    if (randomFeed.success && randomFeed.data) {
      const data = randomFeed.data as { papers?: Agent4SciencePaper[]; takes?: Agent4ScienceTake[]; reviews?: Agent4ScienceReview[] };
      for (const p of data.papers ?? []) {
        if (!seenPapers.has(p.id)) { seenPapers.add(p.id); rawPapers.push(p); }
      }

      // Collect reviews from random feed (deduplication handled below)
      // Reviews are now primarily collected from dedicated hot/new feeds
    }

    // Score & filter papers
    for (const paper of rawPapers) {
      if (paper.agentId === agentId || paper.authorAgentId === agentId) continue;
      const score = this.scorePaper(paper, persona);
      snapshot.papers.push({ ...paper, relevanceScore: score });

      // Collect discovered agents
      const handle = paper.agent?.handle;
      const authorId = paper.agent?.id || paper.authorAgentId || paper.agentId;
      if (handle && authorId && authorId !== agentId) {
        snapshot.discoveredAgents.set(handle, authorId);
      }
    }

    // ── Collect & deduplicate takes ──
    const seenTakes = new Set<string>();
    const rawTakes: Agent4ScienceTake[] = [];

    for (const result of [takesNew, takesHot]) {
      if (!result.success || !result.data) continue;
      const takes = Array.isArray(result.data) ? result.data : (result.data as { items?: Agent4ScienceTake[] }).items || [];
      for (const t of takes) {
        if (!seenTakes.has(t.id)) { seenTakes.add(t.id); rawTakes.push(t); }
      }
    }

    // Add following feed takes
    if (followingFeed.success && followingFeed.data) {
      const data = followingFeed.data as { takes?: Agent4ScienceTake[] };
      for (const t of data.takes ?? []) {
        if (!seenTakes.has(t.id)) { seenTakes.add(t.id); rawTakes.push(t); }
      }
    }

    // Add random feed takes
    if (randomFeed.success && randomFeed.data) {
      const data = randomFeed.data as { takes?: Agent4ScienceTake[] };
      for (const t of data.takes ?? []) {
        if (!seenTakes.has(t.id)) { seenTakes.add(t.id); rawTakes.push(t); }
      }
    }

    // Score & filter takes
    for (const take of rawTakes) {
      if (take.agentId === agentId || take.authorAgentId === agentId) continue;
      const score = this.scoreTake(take, persona);
      snapshot.takes.push({ ...take, relevanceScore: score });

      // Collect discovered agents from takes
      const handle = take.agent?.handle;
      const authorId = take.agent?.id || take.authorAgentId || take.agentId;
      if (handle && authorId && authorId !== agentId) {
        snapshot.discoveredAgents.set(handle, authorId);
      }
    }

    // ── Collect & deduplicate reviews ──
    const seenReviews = new Set<string>();
    const rawReviews: Agent4ScienceReview[] = [];

    for (const result of [reviewsNew, reviewsHot]) {
      if (!result.success || !result.data) continue;
      const reviews = Array.isArray(result.data) ? result.data : (result.data as { items?: Agent4ScienceReview[] }).items || [];
      for (const r of reviews) {
        if (!seenReviews.has(r.id)) { seenReviews.add(r.id); rawReviews.push(r); }
      }
    }

    // Add following feed reviews
    if (followingFeed.success && followingFeed.data) {
      const data = followingFeed.data as { reviews?: Agent4ScienceReview[] };
      for (const r of data.reviews ?? []) {
        if (!seenReviews.has(r.id)) { seenReviews.add(r.id); rawReviews.push(r); }
      }
    }

    // Add random feed reviews
    if (randomFeed.success && randomFeed.data) {
      const rData = randomFeed.data as { reviews?: Agent4ScienceReview[] };
      for (const r of rData.reviews ?? []) {
        if (!seenReviews.has(r.id)) { seenReviews.add(r.id); rawReviews.push(r); }
      }
    }

    // Score & filter reviews
    // Note: only exclude reviews already commented on (not just voted on),
    // so agents can still comment on reviews they've voted on.
    for (const review of rawReviews) {
      if (review.reviewerAgentId === agentId) continue;
      if (db.hasEngaged(agentId, review.id, 'comment')) continue;
      const score = this.scoreReview(review, persona);
      snapshot.reviews.push({ ...review, relevanceScore: score });
    }

    // Sort by relevance (highest first)
    snapshot.papers.sort((a, b) => b.relevanceScore - a.relevanceScore);
    snapshot.takes.sort((a, b) => b.relevanceScore - a.relevanceScore);
    snapshot.reviews.sort((a, b) => b.relevanceScore - a.relevanceScore);

    // ── Scan reply opportunities (read-only) ──
    snapshot.replyOpportunities = await this.scanReplyOpportunities(agentId, apiKey, snapshot);

    // ── Scan sciencesub candidates (read-only) ──
    if (sciencesubsResult.success && sciencesubsResult.data) {
      snapshot.sciencesubCandidates = this.scanSciencesubCandidates(agentId, persona, sciencesubsResult.data);
    }

    return snapshot;
  }

  /**
   * Score a paper's relevance to the agent's persona (0-1).
   * Based on topic relevance, recency, and comment count.
   */
  private scorePaper(paper: Agent4SciencePaper, persona: AgentPersona): number {
    let score = 0.3; // base score

    // Topic relevance (0-0.4)
    if (this.isTopicRelevant(paper.tags || [], persona.preferredTopics)) {
      score += 0.4;
    }

    // Recency bonus (0-0.15) — newer papers get a boost
    const ageHours = (Date.now() - new Date(paper.createdAt).getTime()) / (1000 * 60 * 60);
    if (ageHours < 1) score += 0.15;
    else if (ageHours < 6) score += 0.10;
    else if (ageHours < 24) score += 0.05;

    // Comment count bonus (0-0.15) — more comments = more interesting
    if (paper.commentCount >= 5) score += 0.15;
    else if (paper.commentCount >= 2) score += 0.10;
    else if (paper.commentCount >= 1) score += 0.05;

    return Math.min(1, score);
  }

  /**
   * Score a take's relevance to the agent's persona (0-1).
   * Based on stance interest, recency, and comment count.
   */
  private scoreTake(take: Agent4ScienceTake, persona: AgentPersona): number {
    let score = 0.3; // base score

    // Stance interest (0-0.3) — controversial takes are more interesting
    if (this.stanceStrictlyConflicts(take.stance, persona)) {
      score += 0.3; // disagreement is engaging
    } else if (take.stance === 'hot' || take.stance === 'critical') {
      score += 0.2; // spicy takes are interesting
    } else if (take.stance !== 'neutral') {
      score += 0.1;
    }

    // Recency bonus (0-0.15)
    const ageHours = (Date.now() - new Date(take.createdAt).getTime()) / (1000 * 60 * 60);
    if (ageHours < 1) score += 0.15;
    else if (ageHours < 6) score += 0.10;
    else if (ageHours < 24) score += 0.05;

    // Comment count bonus (0-0.15)
    if (take.commentCount >= 5) score += 0.15;
    else if (take.commentCount >= 2) score += 0.10;
    else if (take.commentCount >= 1) score += 0.05;

    return Math.min(1, score);
  }

  /**
   * Score a review's relevance to the agent's persona (0-1).
   */
  private scoreReview(review: Agent4ScienceReview, persona: AgentPersona): number {
    let score = 0.3; // base score

    // Topic relevance via paper tags (0-0.4)
    const paperTags = review.paper?.tags || [];
    if (paperTags.length > 0 && this.isTopicRelevant(paperTags, persona.preferredTopics)) {
      score += 0.4;
    }

    // Recency bonus (0-0.15)
    const ageHours = (Date.now() - new Date(review.createdAt).getTime()) / (1000 * 60 * 60);
    if (ageHours < 1) score += 0.15;
    else if (ageHours < 6) score += 0.10;
    else if (ageHours < 24) score += 0.05;

    // Comment count bonus (0-0.15)
    const commentCount = review.commentCount || 0;
    if (commentCount >= 5) score += 0.15;
    else if (commentCount >= 2) score += 0.10;
    else if (commentCount >= 1) score += 0.05;

    return Math.min(1, score);
  }

  /**
   * Scan threads for reply candidates (read-only, no actions).
   * Prioritizes content with comments, falls back to top content by relevance.
   */
  private async scanReplyOpportunities(
    agentId: string,
    apiKey: string,
    snapshot: FeedSnapshot
  ): Promise<FeedSnapshot['replyOpportunities']> {
    const client = getAgent4ScienceClient();
    const db = getDatabase();
    const opportunities: FeedSnapshot['replyOpportunities'] = [];

    // Prioritize roots with comments — sorted by commentCount desc
    const papersWithComments = [...snapshot.papers]
      .filter(p => (p.commentCount || 0) > 0)
      .sort((a, b) => (b.commentCount || 0) - (a.commentCount || 0));
    const takesWithComments = [...snapshot.takes]
      .filter(t => (t.commentCount || 0) > 0)
      .sort((a, b) => (b.commentCount || 0) - (a.commentCount || 0));

    const roots: { id: string; type: 'paper' | 'take'; title?: string }[] = [];
    for (const p of papersWithComments.slice(0, 10)) {
      roots.push({ id: p.id, type: 'paper', title: p.title });
    }
    for (const t of takesWithComments.slice(0, 10)) {
      roots.push({ id: t.id, type: 'take', title: t.title || t.hotTake?.slice(0, 60) });
    }

    // Fallback: if no content has comments yet, scan top papers/takes by relevance
    // (they might have comments the listing didn't report, or comments from this cycle)
    if (roots.length === 0) {
      for (const p of snapshot.papers.slice(0, 5)) {
        roots.push({ id: p.id, type: 'paper', title: p.title });
      }
      for (const t of snapshot.takes.slice(0, 5)) {
        roots.push({ id: t.id, type: 'take', title: t.title || t.hotTake?.slice(0, 60) });
      }
    }

    roots.sort(() => Math.random() - 0.5);

    logger.info({
      agent: agentName(agentId),
      agentId,
      papersWithComments: papersWithComments.length,
      takesWithComments: takesWithComments.length,
      rootsToScan: roots.length,
      usingFallback: roots.length === 0 || (papersWithComments.length === 0 && takesWithComments.length === 0),
      commentCounts: snapshot.papers.slice(0, 5).map(p => ({ id: p.id.slice(-8), cc: p.commentCount })),
    }, 'scanReplyOpportunities: selecting roots');

    type ReplyableComment = { id: string; body: string; agentId?: string; parentId?: string | null; depth?: number };

    for (const { id: rootId, type: rootType, title: rootTitle } of roots) {
      try {
        let comments: ReplyableComment[] = [];

        // Try thread endpoint first, fall back to comments endpoint
        const threadResult = await client.getThread(rootId, apiKey);
        if (threadResult.success && threadResult.data) {
          const data = threadResult.data;
          comments = Array.isArray(data) ? data : (data as { comments?: ReplyableComment[] }).comments ?? [];
        } else {
          // Fallback: fetch comments directly from paper/take comments endpoint
          const fallbackResult = rootType === 'paper'
            ? await client.getPaperComments(rootId, apiKey)
            : await client.getTakeComments(rootId, apiKey);
          if (fallbackResult.success && fallbackResult.data) {
            const fbData = fallbackResult.data;
            comments = Array.isArray(fbData) ? fbData : (fbData as { comments?: ReplyableComment[] }).comments ?? [];
          } else {
            logger.info({ agentId, rootId, rootType, error: fallbackResult.error }, 'Both thread and comments fetch failed');
            continue;
          }
          logger.info({ agentId, rootId: rootId.slice(-8), rootType, comments: comments.length }, 'Thread fetch failed, used comments fallback');
        }

        logger.info({
          agent: agentName(agentId),
          agentId,
          rootId: rootId.slice(-8),
          rootType,
          totalComments: comments.length,
          sampleAgentIds: comments.slice(0, 3).map((c: ReplyableComment) => c.agentId?.slice(-8) || 'no-agentId'),
        }, 'Thread fetched');

        const replyable = (comments as ReplyableComment[]).filter(
          (c) => c.agentId && c.agentId !== agentId && c.id && c.body && !db.hasEngaged(agentId, c.id)
        );

        if (comments.length > 0 && replyable.length === 0) {
          logger.info({
            agentId,
            rootId: rootId.slice(-8),
            totalComments: comments.length,
            noAgentId: comments.filter((c: ReplyableComment) => !c.agentId).length,
            selfComments: comments.filter((c: ReplyableComment) => c.agentId === agentId).length,
            alreadyEngaged: comments.filter((c: ReplyableComment) => c.agentId && c.agentId !== agentId && c.id && c.body && db.hasEngaged(agentId, c.id)).length,
          }, 'Thread has comments but none replyable — breakdown');
        }

        // Compute thread-level stats for prioritization
        const uniqueParticipants = new Set(
          (comments as ReplyableComment[]).filter(c => c.agentId).map(c => c.agentId!)
        );

        for (const c of replyable) {
          if (!c.agentId) continue;
          // Count siblings — other replies to the same parent
          const siblingCount = (comments as ReplyableComment[]).filter(
            (s) => s.parentId === c.parentId && s.id !== c.id
          ).length;

          opportunities.push({
            commentId: c.id,
            commentBody: c.body,
            commentAuthorId: c.agentId,
            rootId,
            rootType,
            rootTitle,
            reciprocityMultiplier: this.getReciprocityMultiplier(agentId, c.agentId),
            threadParticipantCount: uniqueParticipants.size,
            siblingCount,
          });
        }
      } catch (err) {
        logger.info({ err, agentId, rootId }, 'Thread scan error');
      }
    }

    return opportunities;
  }

  /**
   * Score joinable sciencesubs by relevance (read-only, no actions).
   */
  private scanSciencesubCandidates(
    agentId: string,
    persona: AgentPersona,
    sciencesubs: { slug: string; name: string; description: string }[]
  ): FeedSnapshot['sciencesubCandidates'] {
    const db = getDatabase();
    const candidates: FeedSnapshot['sciencesubCandidates'] = [];

    for (const sub of sciencesubs) {
      if (db.hasJoinedSciencesub(agentId, sub.slug)) continue;
      const relevance = this.calculateSciencesubRelevance(sub, persona);
      if (relevance > 0.25) {
        candidates.push({ ...sub, relevance });
      }
    }

    candidates.sort((a, b) => b.relevance - a.relevance);
    return candidates;
  }

  // ════════════════════════════════════════════════════════════════════
  // Phase 2: MAINTENANCE — Capped passive actions
  // ════════════════════════════════════════════════════════════════════

  /**
   * Capped passive actions while "scrolling":
   * - Up to 3 votes (not 40+)
   * - At most 1 follow
   * - At most 1 sciencesub join
   * - Auto-join sciencesubs from browsed takes
   */
  private async doMaintenance(
    agentId: string,
    persona: AgentPersona,
    apiKey: string,
    snapshot: FeedSnapshot
  ): Promise<void> {
    const executor = getActionExecutor();
    const rateLimiter = getRateLimiter();
    const db = getDatabase();
    const client = getAgent4ScienceClient();

    // ── Up to 3 votes ──
    let votesQueued = 0;
    const maxVotes = 3;

    // Mix papers, takes, and reviews for voting
    const voteTargets: Array<{ id: string; type: 'paper' | 'take' | 'review'; direction: 'up' | 'down' }> = [];

    for (const paper of snapshot.papers) {
      if (!db.hasEngaged(agentId, paper.id)) {
        voteTargets.push({ id: paper.id, type: 'paper', direction: 'up' });
      }
    }
    for (const take of snapshot.takes) {
      if (!db.hasEngaged(agentId, take.id)) {
        const direction = this.stanceStrictlyConflicts(take.stance, persona) ? 'down' : 'up';
        voteTargets.push({ id: take.id, type: 'take', direction });
      }
    }
    for (const review of snapshot.reviews) {
      if (!db.hasEngaged(agentId, review.id)) {
        voteTargets.push({ id: review.id, type: 'review', direction: 'up' });
      }
    }

    // Shuffle then pick top N
    voteTargets.sort(() => Math.random() - 0.5);

    for (const target of voteTargets) {
      if (votesQueued >= maxVotes) break;
      if (!this.config.enableVoting) break;
      if (!rateLimiter.canPerform(agentId, 'vote')) break;

      executor.queueAction(agentId, 'vote', target.id, target.type, { direction: target.direction }, 'low');
      db.recordEngagement(agentId, target.id, target.type, 'vote');
      votesQueued++;
      logger.debug(`${agentName(agentId)} maintenance-voted ${target.direction} on ${target.type} ${target.id}`);
    }

    // ── At most 1 follow ──
    if (this.config.enableAgentFollowing) {
      const candidates = Array.from(snapshot.discoveredAgents.entries())
        .filter(([, targetId]) => !db.hasFollowed(agentId, targetId));

      if (candidates.length > 0 && rateLimiter.canPerform(agentId, 'follow')) {
        // Pick one random candidate with 60% chance
        if (Math.random() < 0.6) {
          const [handle, targetId] = candidates[Math.floor(Math.random() * candidates.length)];
          executor.queueAction(agentId, 'follow', handle, 'agent', {}, 'low');
          db.recordFollow(agentId, targetId);
          logger.info(`${agentName(agentId)} will follow @${handle}`);
        }
      }
    }

    // ── At most 1 sciencesub join ──
    if (this.config.enableSciencesubJoining && snapshot.sciencesubCandidates.length > 0) {
      if (rateLimiter.canPerform(agentId, 'sciencesub')) {
        const candidate = snapshot.sciencesubCandidates[0]; // most relevant
        try {
          const joinResult = await client.joinSciencesub(candidate.slug, apiKey);
          if (joinResult.success || joinResult.code === 'ALREADY_MEMBER') {
            if (joinResult.success) rateLimiter.tryConsume(agentId, 'sciencesub');
            db.recordSciencesubJoin(agentId, candidate.slug);
            logger.info(`${agentName(agentId)} joined sciencesub ${candidate.slug} (relevance: ${(candidate.relevance * 100).toFixed(0)}%)`);
          }
        } catch (error) {
          logger.error({ err: error, agentId, sciencesub: candidate.slug }, 'Failed to join sciencesub');
        }
      }
    }

    // ── Auto-join sciencesubs from browsed takes ──
    const autoJoinSlugs = new Set<string>();
    for (const take of snapshot.takes) {
      if (take.sciencesub && !db.hasJoinedSciencesub(agentId, take.sciencesub)) {
        autoJoinSlugs.add(take.sciencesub);
      }
    }
    for (const slug of autoJoinSlugs) {
      try {
        const joinResult = await client.joinSciencesub(slug, apiKey);
        if (joinResult.success || joinResult.code === 'ALREADY_MEMBER') {
          db.recordSciencesubJoin(agentId, slug);
          logger.info(`${agentName(agentId)} auto-joined sciencesub ${slug} (engaged with content)`);
        }
      } catch {
        // Ignore join errors — transient network issues
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // Phase 4: DECIDE ONE — Pick one creative action
  // ════════════════════════════════════════════════════════════════════

  /**
   * Pick ONE creative action from the snapshot and execute it.
   * Rolls pickSingleAction() to choose the action type, then finds the best target.
   * Falls back to a different action if no valid target exists.
   */
  private async decideOneAction(
    agentId: string,
    persona: AgentPersona,
    apiKey: string,
    snapshot: FeedSnapshot
  ): Promise<void> {
    const rateLimiter = getRateLimiter();
    const db = getDatabase();

    // Try up to 5 rolls to find a viable action
    for (let attempt = 0; attempt < 5; attempt++) {
      const action = this.pickSingleAction();

      try {
        switch (action) {
          case 'comment_paper': {
            let target = snapshot.papers.find(p => !db.hasEngaged(agentId, p.id, 'comment'));
            if (!target && snapshot.papers.length > 0) {
              target = snapshot.papers[Math.floor(Math.random() * snapshot.papers.length)];
            }
            if (target && rateLimiter.canPerform(agentId, 'comment')) {
              logger.info({ agentId, action, attempt }, `${agentName(agentId)} → comment_paper "${target.title}"`);
              await this.queueCommentOnPaper(agentId, target, persona);
              return;
            }
            break;
          }

          case 'comment_take': {
            let target = snapshot.takes.find(t => !db.hasEngaged(agentId, t.id, 'comment'));
            if (!target && snapshot.takes.length > 0) {
              target = snapshot.takes[Math.floor(Math.random() * snapshot.takes.length)];
            }
            if (target && rateLimiter.canPerform(agentId, 'comment')) {
              logger.info({ agentId, action, attempt }, `${agentName(agentId)} → comment_take "${target.title || target.hotTake?.slice(0, 60)}"`);
              await this.queueCommentOnTake(agentId, target, persona);
              return;
            }
            break;
          }

          case 'comment_review': {
            let reviewTarget = snapshot.reviews.find(r => !db.hasEngaged(agentId, r.id, 'comment'));
            if (!reviewTarget && snapshot.reviews.length > 0) {
              reviewTarget = snapshot.reviews[Math.floor(Math.random() * snapshot.reviews.length)];
            }
            if (reviewTarget && rateLimiter.canPerform(agentId, 'comment')) {
              logger.info({ agentId, action, attempt }, `${agentName(agentId)} → comment_review by ${agentName(reviewTarget.reviewerAgentId || '')} (${reviewTarget.id})`);
              await this.queueCommentOnReview(agentId, reviewTarget, persona);
              return;
            }
            break;
          }

          case 'reply': {
            if (snapshot.replyOpportunities.length > 0 && rateLimiter.canPerform(agentId, 'comment')) {
              logger.info({ agentId, action, attempt }, `${agentName(agentId)} → reply (${snapshot.replyOpportunities.length} opportunities)`);
              const success = await this.tryReply(agentId, persona, apiKey, snapshot);
              if (success) return;
            }
            break;
          }

          case 'take_on_paper': {
            if (!this.config.enableTakeCreation) break;
            if (db.hasPendingAction(agentId, 'take')) {
              logger.debug({ agentId }, 'Skipping take_on_paper: already has pending take in queue');
              break;
            }
            const eligibleForTake = snapshot.papers.filter(p => !db.hasEngaged(agentId, p.id, 'take'));
            if (eligibleForTake.length > 0 && rateLimiter.canPerform(agentId, 'take')) {
              const idx = Math.floor(Math.random() * Math.min(eligibleForTake.length, 5));
              const selectedPaper = eligibleForTake[idx];
              logger.info({ agentId, action, attempt }, `${agentName(agentId)} → take_on_paper "${selectedPaper.title}"`);
              const existingTakesOnPaper = snapshot.takes
                .filter((t: Agent4ScienceTake) => t.paperId === selectedPaper.id && (t.title || t.hotTake))
                .map((t: Agent4ScienceTake) => `- "${t.title}" (${t.stance || 'neutral'}): ${t.hotTake || ''}`.slice(0, 200));
              await this.queueTakeOnPaper(agentId, selectedPaper, persona, existingTakesOnPaper);
              return;
            }
            break;
          }

          case 'review': {
            if (db.hasPendingAction(agentId, 'review')) {
              logger.debug({ agentId }, 'Skipping review: already has pending review in queue');
              break;
            }
            const eligibleForReview = snapshot.papers.filter(p => !db.hasEngaged(agentId, p.id, 'review'));
            if (eligibleForReview.length > 0 && rateLimiter.canPerform(agentId, 'review')) {
              const idx = Math.floor(Math.random() * Math.min(eligibleForReview.length, 5));
              const reviewPaper = eligibleForReview[idx];
              logger.info({ agentId, action, attempt }, `${agentName(agentId)} → review "${reviewPaper.title}"`);
              await this.queueReviewOnPaper(agentId, reviewPaper, persona);
              return;
            }
            break;
          }

          case 'standalone_take': {
            if (!this.config.enableTakeCreation) break;
            if (db.hasPendingAction(agentId, 'take')) {
              logger.debug({ agentId }, 'Skipping standalone_take: already has pending take in queue');
              break;
            }
            if (rateLimiter.canPerform(agentId, 'take')) {
              logger.info({ agentId, action, attempt }, `${agentName(agentId)} → standalone_take`);
              await this.queueStandaloneTake(agentId, persona, apiKey, snapshot);
              return;
            }
            break;
          }
        }
      } catch (error) {
        logger.error({ err: error, agentId, action }, 'Failed to execute decided action');
      }

      // Action failed or had no valid target — retry with a different roll
      logger.debug({ agentId, action }, 'No valid target for action, re-rolling');
    }

    logger.debug({ agentId }, 'No viable creative action found after 5 attempts');
  }

  /**
   * Pick best reply candidate from snapshot.replyOpportunities,
   * weighted by reciprocity + randomness. Generate and queue the reply.
   */
  private async tryReply(
    agentId: string,
    persona: AgentPersona,
    apiKey: string,
    snapshot: FeedSnapshot
  ): Promise<boolean> {
    const llm = getLLMClient();
    const executor = getActionExecutor();
    const db = getDatabase();

    // Weight candidates by reciprocity
    const candidates = snapshot.replyOpportunities.filter(
      op => !db.hasEngaged(agentId, op.commentId)
    );
    if (candidates.length === 0) return false;

    // Sort by combined score: reciprocity + thread heat (active multi-agent discussions prioritized)
    candidates.sort((a, b) => {
      // Thread heat: multi-participant threads are more interesting to join
      const aThreadHeat = Math.min(a.threadParticipantCount * 0.5, 2.0) + Math.min(a.siblingCount * 0.3, 1.5);
      const bThreadHeat = Math.min(b.threadParticipantCount * 0.5, 2.0) + Math.min(b.siblingCount * 0.3, 1.5);
      const aScore = a.reciprocityMultiplier + aThreadHeat + Math.random() * 0.5;
      const bScore = b.reciprocityMultiplier + bThreadHeat + Math.random() * 0.5;
      return bScore - aScore;
    });

    const target = candidates[0];

    // Fetch thread context for coherent reply
    const threadContext = await this.getThreadContext(
      target.rootId, target.rootType, target.commentId, apiKey, 5
    );

    // Also fetch root content (paper/take) for broader context
    let rootContent: string | undefined;
    try {
      if (target.rootType === 'paper') {
        const paperResult = await getAgent4ScienceClient().getPaper(target.rootId, apiKey);
        if (paperResult.success && paperResult.data) {
          rootContent = `${paperResult.data.title}\n\n${paperResult.data.tldr || paperResult.data.abstract || ''}`;
        }
      } else if (target.rootType === 'take') {
        const takeResult = await getAgent4ScienceClient().getTake(target.rootId, apiKey);
        if (takeResult.success && takeResult.data) {
          rootContent = `${takeResult.data.title}\n\n${takeResult.data.hotTake || takeResult.data.summary?.join(' ') || ''}`;
        }
      }
    } catch {
      // Non-critical — we still have thread context
    }

    const generated = await llm.generateComment(persona, {
      targetType: 'comment',
      targetContent: target.commentBody,
      parentContent: rootContent,
      threadContext: threadContext || undefined,
      triggerType: 'reply',
      fromAgent: target.commentAuthorId,
    });

    // Check similarity to recent comments
    if (isTooSimilarToRecent(agentId, generated.body, db, 0.7, 10)) {
      logger.debug(`${agentName(agentId)} reply too similar to recent comments, skipping`);
      return false;
    }

    // Route to root content (paper/take) with parentId for threading
    // executeComment needs targetType='paper'|'take' — NOT 'comment'
    const payload = {
      intent: generated.intent ?? 'clarify',
      body: generated.body,
      confidence: generated.confidence ?? 0.8,
      parentId: target.commentId,
    };

    // Route to the root content type (paper/take) so executeComment uses the right API endpoint
    executor.queueAction(agentId, 'comment', target.rootId, target.rootType as 'paper' | 'take', payload, 'high');
    db.recordEngagement(agentId, target.commentId, 'comment', 'comment');
    db.recordInteraction(agentId, target.commentAuthorId, 'reply');

    logger.info(`${agentName(agentId)} queued reply on "${target.rootTitle || target.rootId}" to ${agentName(target.commentAuthorId)} (reciprocity: ${target.reciprocityMultiplier.toFixed(1)}×)`);
    return true;
  }

  /**
   * Generate and queue a standalone take (not linked to a specific paper).
   * Builds browsing context from snapshot and calls LLM.
   */
  private async queueStandaloneTake(
    agentId: string,
    persona: AgentPersona,
    apiKey: string,
    snapshot: FeedSnapshot
  ): Promise<void> {
    const llm = getLLMClient();
    const client = getAgent4ScienceClient();
    const executor = getActionExecutor();

    try {
      // Build browsing context from snapshot
      const recentPaperTitles = snapshot.papers.slice(0, 5).map(p => p.title);
      const trendingTags = new Map<string, number>();
      for (const paper of snapshot.papers) {
        for (const tag of paper.tags || []) {
          trendingTags.set(tag, (trendingTags.get(tag) || 0) + 1);
        }
      }
      const topTags = Array.from(trendingTags.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([tag]) => tag);

      // Fetch sciencesubs for tag selection
      let sciencesubs: { slug: string; name: string; description: string }[] = [];
      try {
        sciencesubs = await client.getCachedSciencesubs(apiKey);
      } catch {
        logger.debug({ agentId }, 'Failed to fetch sciencesubs for standalone take');
      }

      const take = await llm.generateStandaloneTake(persona, {
        recentPaperTitles,
        trendingTags: topTags,
        personaTopics: persona.preferredTopics,
      }, sciencesubs);

      // Enrich tags with matching sciencesub slugs (same as paper flow)
      if (sciencesubs.length > 0) {
        const existingSlugs = sciencesubs.map(s => s.slug);
        const takeTags = new Set(take.tags.map((t: string) => t.toLowerCase()));
        for (const tag of [...takeTags]) {
          const { match } = findMatchingCategory(tag, existingSlugs);
          if (match && !takeTags.has(match)) {
            takeTags.add(match);
          }
        }
        take.tags = Array.from(takeTags).slice(0, 10);
      }

      // Ensure first tag is a valid sciencesub slug
      // Pass trending tags from snapshot as contextTags fallback (like paper.tags for paper-linked takes)
      take.tags = ensureFirstTagIsSciencesub(take.tags, sciencesubs, topTags);

      if (take.tags.length === 0) {
        logger.warn({ agentId }, 'Standalone take has no valid tags after enrichment, skipping');
        return;
      }

      // Queue with synthetic targetId (standalone takes use 'take' targetType)
      const targetId = `standalone_${Date.now().toString(36)}`;
      executor.queueAction(agentId, 'take', targetId, 'take', take as unknown as Record<string, unknown>, 'normal');
      logger.info({ agentId, tags: take.tags }, 'Queued standalone take');
    } catch (error) {
      logger.error({ err: error, agentId }, 'Failed to generate standalone take');
    }
  }

  /**
   * Author heartbeat: agent replies to comments on its own papers/takes.
   * Fetches the agent's own content, finds unanswered comments, and queues author-framed replies.
   */
  private async discoverAuthorReplyOpportunities(
    agentId: string,
    persona: AgentPersona,
    apiKey: string
  ): Promise<void> {
    const client = getAgent4ScienceClient();
    const executor = getActionExecutor();
    const rateLimiter = getRateLimiter();
    const llm = getLLMClient();
    const db = getDatabase();

    if (!rateLimiter.canPerform(agentId, 'comment')) return;

    // Get this agent's own papers and takes
    const roots: { id: string; type: 'paper' | 'take'; title: string }[] = [];

    const myPapersResult = await client.getPapers(apiKey, { limit: 5, sort: 'new', agentId });
    if (myPapersResult.success && myPapersResult.data) {
      const papers = Array.isArray(myPapersResult.data)
        ? myPapersResult.data
        : (myPapersResult.data as { papers?: { id: string; title: string }[] }).papers ?? [];
      for (const p of (papers as { id: string; title: string }[]).slice(0, 5)) {
        roots.push({ id: p.id, type: 'paper', title: p.title || '' });
      }
    }

    const myTakesResult = await client.getTakes(apiKey, { limit: 5, sort: 'new', agentId });
    if (myTakesResult.success && myTakesResult.data) {
      const takes = Array.isArray(myTakesResult.data)
        ? myTakesResult.data
        : (myTakesResult.data as { takes?: { id: string; hotTake?: string; title?: string }[] }).takes ?? [];
      for (const t of (takes as { id: string; hotTake?: string; title?: string }[]).slice(0, 5)) {
        roots.push({ id: t.id, type: 'take', title: t.hotTake || t.title || '' });
      }
    }

    let repliesQueued = 0;
    const maxRepliesPerCycle = 3; // Author replies are rarer than general replies

    type ReplyableComment = { id: string; body: string; agentId?: string; parentId?: string | null; depth?: number };

    for (const { id: rootId, type: rootType, title: rootTitle } of roots) {
      if (repliesQueued >= maxRepliesPerCycle) break;

      try {
        const threadResult = await client.getThread(rootId, apiKey);
        if (!threadResult.success || !threadResult.data) continue;

        const data = threadResult.data;
        const comments = Array.isArray(data)
          ? data
          : (data as { comments?: ReplyableComment[] }).comments ?? [];

        // Only top-level comments on author's own content that the author hasn't replied to
        const unreplied = (comments as ReplyableComment[]).filter(
          (c) =>
            c.agentId &&
            c.agentId !== agentId &&   // Not the author's own comment
            !c.parentId &&             // Top-level only
            c.id &&
            c.body &&
            !db.hasEngaged(agentId, c.id)  // Not already replied
        );

        if (unreplied.length === 0) continue;

        // Pick the oldest unanswered comment (authors should respond in order)
        const target = unreplied[unreplied.length - 1] as ReplyableComment;

        // Use generateComment with author_reply trigger to get full persona system prompt
        const generated = await llm.generateComment(persona, {
          targetType: rootType,
          targetContent: target.body,
          triggerType: 'author_reply',
          fromAgent: target.agentId,
          rootTitle,
          rootType,
        });

        if (!generated.body) continue;

        const payload = {
          intent: generated.intent ?? 'clarify',
          body: generated.body,
          confidence: generated.confidence ?? 0.9,
          parentId: target.id,
        };

        // Route to root content type (paper/take) with parentId for threading
        executor.queueAction(agentId, 'comment', rootId, rootType, payload, 'high');
        db.recordEngagement(agentId, target.id, 'comment', 'comment');
        if (target.agentId) db.recordInteraction(agentId, target.agentId, 'reply');

        repliesQueued++;
        logger.info(`${agentName(agentId)} (author) queued reply to comment ${target.id} on their ${rootType}`);
      } catch (error) {
        logger.debug({ err: error, agentId, rootId }, 'Author reply discovery skip');
      }
    }
  }

  /**
   * Proactive sciencesub creation: try at most one candidate topic per cycle.
   * Only runs if rate limit allows (1/day server-enforced) and topic has enough activity.
   */
  private async maybeCreateSciencesubProactive(
    agentId: string,
    persona: AgentPersona,
    apiKey: string
  ): Promise<void> {
    const rateLimiter = getRateLimiter();
    if (!rateLimiter.canPerform(agentId, 'sciencesub')) {
      logger.debug(`${agentName(agentId)} rate limited for sciencesub creation`);
      return;
    }

    const client = getAgent4ScienceClient();
    const candidateTopics: string[] = [];

    // Prefer persona's preferred topics (agent is invested in these)
    if (persona.preferredTopics?.length) {
      candidateTopics.push(...persona.preferredTopics.slice(0, 5));
    }

    // Add trending tags from recent papers (only if we have few persona topics)
    const papersResult = await client.getPapers(apiKey, { limit: 30, sort: 'hot' });
    if (papersResult.success && papersResult.data) {
      const papers = Array.isArray(papersResult.data) ? papersResult.data : [];
      const tagCount = new Map<string, number>();
      for (const paper of papers) {
        for (const tag of paper.tags || []) {
          const t = tag.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
          if (t.length >= 2 && t.length <= 30) tagCount.set(t, (tagCount.get(t) || 0) + 1);
        }
      }
      const trending = Array.from(tagCount.entries())
        .filter(([, c]) => c >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([tag]) => tag);
      for (const t of trending) {
        if (!candidateTopics.includes(t)) candidateTopics.push(t);
      }
    }

    if (candidateTopics.length === 0) return;

    // Pick one candidate (shuffle and try first that passes shouldCreate)
    const shuffled = [...candidateTopics].sort(() => Math.random() - 0.5);
    const topic = shuffled[0];
    const description = `Research and discussion on ${topic}.`;

    const result = await this.maybeCreateSciencesub(topic, description, apiKey);
    if (result.created && result.slug) {
      rateLimiter.tryConsume(agentId, 'sciencesub');
    }
  }

  /**
   * Check if a topic has enough activity to warrant a new sciencesub
   *
   * Uses arXiv-style taxonomy to prevent redundant sciencesubs:
   * 1. Check if topic matches an existing sciencesub (exact or semantic match)
   * 2. Check if topic belongs under a broader category (e.g., "fractal" → "mathematics")
   * 3. Only allow creation if topic is genuinely novel AND has enough activity
   *
   * Minimum thresholds (prevents empty subs like s/fixed-point-theory):
   * - At least 3 papers with the topic tag
   * - OR at least 5 takes discussing the topic
   *
   * This is called before creating a new sciencesub to prevent proliferation
   * of empty, unused sciencesubs.
   */
  async shouldCreateSciencesub(
    topic: string,
    apiKey: string
  ): Promise<{ shouldCreate: boolean; reason: string; activity: { papers: number; takes: number }; suggestedCategory?: string }> {
    const client = getAgent4ScienceClient();

    // Get existing sciencesubs for taxonomy matching
    const existingResult = await client.getSciencesubs(apiKey);
    const existingSlugs: string[] = existingResult.success && existingResult.data
      ? existingResult.data.map(sub => sub.slug)
      : [];

    // TAXONOMY CHECK: Use arXiv-style classification to find matching category
    const { match, reason: matchReason } = findMatchingCategory(topic, existingSlugs);

    if (match) {
      logger.info(`Taxonomy match for "${topic}": ${matchReason}`);
      return {
        shouldCreate: false,
        reason: matchReason,
        activity: { papers: 0, takes: 0 },
        suggestedCategory: match,
      };
    }

    // No taxonomy match - topic is novel, check activity thresholds
    // Count papers with this topic tag
    const papersResult = await client.getPapers(apiKey, { limit: 50, tag: topic });
    const paperCount = papersResult.success && papersResult.data
      ? (Array.isArray(papersResult.data) ? papersResult.data.length : 0)
      : 0;

    // Count takes (would need tag support in takes API, estimate from papers)
    const takeCount = Math.floor(paperCount * 1.5); // Rough estimate: 1.5 takes per paper

    const activity = { papers: paperCount, takes: takeCount };

    // Check thresholds - only create if genuinely new AND has activity
    if (paperCount >= 3) {
      return {
        shouldCreate: true,
        reason: `Novel topic "${topic}" has ${paperCount} papers - enough activity for a dedicated sciencesub`,
        activity,
      };
    }

    if (takeCount >= 5) {
      return {
        shouldCreate: true,
        reason: `Novel topic "${topic}" has ~${takeCount} takes - enough discussion for a dedicated sciencesub`,
        activity,
      };
    }

    return {
      shouldCreate: false,
      reason: `Not enough activity yet (${paperCount} papers, ~${takeCount} takes). Need at least 3 papers or 5 takes.`,
      activity,
    };
  }

  /**
   * Maybe create a new sciencesub for a trending topic
   * Only creates if activity thresholds are met
   */
  async maybeCreateSciencesub(
    topic: string,
    description: string,
    apiKey: string
  ): Promise<{ created: boolean; slug?: string; reason: string }> {
    const { shouldCreate, reason, activity } = await this.shouldCreateSciencesub(topic, apiKey);

    if (!shouldCreate) {
      logger.debug(`Skipping sciencesub creation for "${topic}": ${reason}`);
      return { created: false, reason };
    }

    const client = getAgent4ScienceClient();
    const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-');

    try {
      const result = await client.createSciencesub(
        { name: topic, slug, description },
        apiKey
      );

      if (result.success) {
        logger.info(`Created sciencesub s/${slug} (${activity.papers} papers, ${activity.takes} takes)`);
        return { created: true, slug, reason: `Created with ${activity.papers} papers` };
      }

      return { created: false, reason: result.error || 'Creation failed' };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ err: error, topic }, 'Failed to create sciencesub');
      return { created: false, reason: errorMsg };
    }
  }

  /**
   * Queue a take on a paper
   */
  private async queueTakeOnPaper(
    agentId: string,
    paper: Agent4SciencePaper,
    persona: AgentPersona,
    existingTakes: string[] = []
  ): Promise<void> {
    const llm = getLLMClient();
    const client = getAgent4ScienceClient();
    const executor = getActionExecutor();
    const db = getDatabase();
    const agentManager = getAgentManager();
    const apiKey = agentManager.getApiKey(agentId);

    try {
      // Fetch sciencesubs for tag selection
      let sciencesubs: { slug: string; name: string; description: string }[] = [];
      if (apiKey) {
        try {
          sciencesubs = await client.getCachedSciencesubs(apiKey);
        } catch {
          logger.debug({ agentId }, 'Failed to fetch sciencesubs for take tags');
        }
      }

      const take = await llm.generateTake(persona, {
        title: paper.title,
        abstract: paper.abstract || paper.tldr || '',
        claims: paper.claims || [],
        limitations: paper.limitations || [],
      }, sciencesubs, existingTakes);

      // Enrich tags with matching sciencesub slugs (same as paper flow)
      if (sciencesubs.length > 0) {
        const existingSlugs = sciencesubs.map(s => s.slug);
        const takeTags = new Set(take.tags.map((t: string) => t.toLowerCase()));
        for (const tag of [...takeTags]) {
          const { match } = findMatchingCategory(tag, existingSlugs);
          if (match && !takeTags.has(match)) {
            takeTags.add(match);
          }
        }
        take.tags = Array.from(takeTags).slice(0, 10);
      }

      // Ensure first tag is a valid sciencesub slug
      take.tags = ensureFirstTagIsSciencesub(take.tags, sciencesubs, paper.tags);

      if (take.tags.length === 0) {
        logger.warn({ agentId, paperId: paper.id }, 'Take has no valid tags after enrichment, skipping');
        return;
      }

      executor.queueAction(agentId, 'take', paper.id, 'paper', take as unknown as Record<string, unknown>, 'normal');
      db.recordEngagement(agentId, paper.id, 'paper', 'take');
      logger.info({ agentId, paperId: paper.id, tags: take.tags }, 'Queued take on paper');
    } catch (error) {
      logger.error({ err: error, agentId, paperId: paper.id }, 'Failed to generate take');
    }
  }

  /**
   * Queue a peer review on a paper
   */
  private async queueReviewOnPaper(
    agentId: string,
    paper: Agent4SciencePaper,
    persona: AgentPersona
  ): Promise<void> {
    const llm = getLLMClient();
    const client = getAgent4ScienceClient();
    const executor = getActionExecutor();
    const db = getDatabase();
    const agentManager = getAgentManager();
    const apiKey = agentManager.getApiKey(agentId);

    if (!apiKey) {
      logger.warn({ agentId, paperId: paper.id }, 'Skipping review: no API key for agent');
      return;
    }

    try {
      // Anti-collusion: skip reviews on own papers or papers from followed agents
      if (paper.agentId === agentId) {
        logger.debug({ agentId, paperId: paper.id }, 'Skipping review: cannot review own paper');
        return;
      }
      if (paper.agentId && db.hasEngaged(agentId, paper.agentId, 'follow')) {
        logger.debug({ agentId, paperId: paper.id, authorId: paper.agentId }, 'Skipping review: following paper author');
        return;
      }

      // Verify paper still exists before generating a review
      const paperResult = await client.getPaper(paper.id, apiKey);
      if (!paperResult.success || !paperResult.data) {
        logger.warn({ agentId, paperId: paper.id }, 'Skipping review: paper not found in database');
        return;
      }

      // Use verified paper data for the review (full content instead of listing metadata)
      const verifiedPaper = paperResult.data;

      const review = await llm.generateReview(persona, {
        id: paper.id,
        title: verifiedPaper.title,
        abstract: verifiedPaper.abstract || verifiedPaper.tldr || '',
        claims: verifiedPaper.claims || [],
        limitations: verifiedPaper.limitations || [],
        pdfUrl: verifiedPaper.pdfUrl,
      });

      executor.queueAction(agentId, 'review', paper.id, 'paper', {
        paperId: paper.id,
        ...review,
      }, 'normal');
      db.recordEngagement(agentId, paper.id, 'paper', 'review');
      logger.info(`${agentName(agentId)} queued review on paper "${paper.title}"`);
    } catch (error) {
      logger.error({ err: error, agentId, paperId: paper.id }, 'Failed to generate review');
    }
  }

  /**
   * Fetch full conversation thread for context-aware replies
   * Traverses up the parent chain to get conversation context
   *
   * @param rootId - Paper or take ID
   * @param rootType - 'paper' or 'take'
   * @param commentId - Starting comment ID
   * @param apiKey - Agent API key
   * @param maxDepth - Maximum parent levels to fetch (default: 3)
   * @returns Formatted thread context string
   */
  /**
   * Build rich multi-agent conversation context for a reply.
   * Returns the parent chain PLUS sibling comments (other replies to the same parent),
   * and a participant summary showing who's in the discussion and their positions.
   */
  private async getThreadContext(
    rootId: string,
    _rootType: 'paper' | 'take',
    commentId: string,
    apiKey: string,
    maxDepth: number = 5
  ): Promise<string> {
    const client = getAgent4ScienceClient();

    try {
      const result = await client.getThread(rootId, apiKey);

      if (!result.success || !result.data) {
        return '';
      }

      const allComments = (result.data as any).comments || [];
      if (allComments.length === 0) return '';

      // Find the target comment
      const targetComment = allComments.find((c: any) => c.id === commentId);
      if (!targetComment) return '';

      // 1. Build parent chain (oldest first)
      const parentChain: string[] = [];
      let currentId = commentId;
      let depth = 0;

      while (currentId && depth < maxDepth) {
        const comment = allComments.find((c: any) => c.id === currentId);
        if (!comment) break;
        const handle = comment.agent?.handle || comment.agentId || 'Agent';
        parentChain.unshift(`@${handle}: "${comment.body}"`);
        currentId = comment.parentId || '';
        depth++;
      }

      // 2. Find sibling comments — other replies to the same parent as the target
      const siblingContext: string[] = [];
      if (targetComment.parentId) {
        const siblings = allComments.filter(
          (c: any) => c.parentId === targetComment.parentId && c.id !== commentId
        );
        for (const sib of siblings.slice(0, 5)) {
          const handle = sib.agent?.handle || sib.agentId || 'Agent';
          siblingContext.push(`@${handle} (${sib.intent || 'comment'}): "${sib.body}"`);
        }
      }

      // 3. Find child comments — direct replies to the target (if any)
      const childContext: string[] = [];
      const children = allComments.filter(
        (c: any) => c.parentId === commentId
      );
      for (const child of children.slice(0, 3)) {
        const handle = child.agent?.handle || child.agentId || 'Agent';
        childContext.push(`@${handle} (${child.intent || 'comment'}): "${child.body}"`);
      }

      // 4. Build participant map — who's in this thread and what positions they hold
      const participants = new Map<string, { intent: string; count: number }>();
      for (const c of allComments) {
        const handle = c.agent?.handle || c.agentId || 'Agent';
        const existing = participants.get(handle);
        if (existing) {
          existing.count++;
        } else {
          participants.set(handle, { intent: c.intent || 'comment', count: 1 });
        }
      }

      // 5. Assemble the full context
      let context = '';

      if (participants.size > 1) {
        context += `=== DISCUSSION PARTICIPANTS (${participants.size} researchers) ===\n`;
        for (const [handle, info] of participants) {
          context += `- @${handle}: ${info.count} comment${info.count > 1 ? 's' : ''}, last intent: ${info.intent}\n`;
        }
        context += '\n';
      }

      context += `=== CONVERSATION THREAD ===\n`;
      context += parentChain.join('\n\n');

      if (siblingContext.length > 0) {
        context += `\n\n=== OTHER REPLIES IN THIS BRANCH (${siblingContext.length} other researchers also responded) ===\n`;
        context += siblingContext.join('\n\n');
      }

      if (childContext.length > 0) {
        context += `\n\n=== REPLIES TO THE COMMENT YOU'RE JOINING (others have already responded) ===\n`;
        context += childContext.join('\n\n');
      }

      return context;
    } catch (error) {
      logger.debug({ err: error, rootId, commentId }, 'Failed to fetch thread context');
      return '';
    }
  }

  /**
   * Queue a comment on a paper
   */
  private async queueCommentOnPaper(
    agentId: string,
    paper: Agent4SciencePaper,
    persona: AgentPersona
  ): Promise<void> {
    const llm = getLLMClient();
    const executor = getActionExecutor();
    const db = getDatabase();

    try {
      const comment = await llm.generateComment(persona, {
        targetType: 'paper',
        targetContent: `${paper.title}\n\n${paper.abstract || paper.tldr || ''}`,
        triggerType: 'new_content',
      });

      executor.queueAction(agentId, 'comment', paper.id, 'paper', comment as unknown as Record<string, unknown>, 'normal');
      db.recordEngagement(agentId, paper.id, 'paper', 'comment');
      logger.info(`${agentName(agentId)} queued comment on paper "${paper.title}"`);
    } catch (error) {
      logger.error({ err: error, agentId, paperId: paper.id }, 'Failed to generate comment');
    }
  }

  /**
   * Queue a comment on a take
   */
  private async queueCommentOnTake(
    agentId: string,
    take: Agent4ScienceTake,
    persona: AgentPersona
  ): Promise<void> {
    const llm = getLLMClient();
    const executor = getActionExecutor();
    const db = getDatabase();

    try {
      const comment = await llm.generateComment(persona, {
        targetType: 'take',
        targetContent: `${take.title}\n\n${take.hotTake || take.summary?.join('\n') || ''}`,
        triggerType: 'new_content',
      });

      executor.queueAction(agentId, 'comment', take.id, 'take', comment as unknown as Record<string, unknown>, 'normal');
      db.recordEngagement(agentId, take.id, 'take', 'comment');
      logger.info(`${agentName(agentId)} queued comment on take "${take.title || take.hotTake?.slice(0, 60)}"`);
    } catch (error) {
      logger.error({ err: error, agentId, takeId: take.id }, 'Failed to generate comment');
    }
  }

  /**
   * Queue a comment on a peer review
   */
  private async queueCommentOnReview(
    agentId: string,
    review: Agent4ScienceReview & { relevanceScore: number },
    persona: AgentPersona
  ): Promise<void> {
    const llm = getLLMClient();
    const executor = getActionExecutor();
    const db = getDatabase();

    try {
      const reviewContent = [
        review.summary,
        review.strengths?.length ? `Strengths: ${review.strengths.join('; ')}` : '',
        review.weaknesses?.length ? `Weaknesses: ${review.weaknesses.join('; ')}` : '',
        review.suggestions || '',
      ].filter(Boolean).join('\n\n');

      const comment = await llm.generateComment(persona, {
        targetType: 'review',
        targetContent: reviewContent,
        triggerType: 'new_content',
      });

      executor.queueAction(agentId, 'comment', review.id, 'review', comment as unknown as Record<string, unknown>, 'normal');
      db.recordEngagement(agentId, review.id, 'review', 'comment');
      logger.info(`${agentName(agentId)} queued comment on review by ${agentName(review.reviewerAgentId || '')}`);
    } catch (error) {
      logger.error({ err: error, agentId, reviewId: review.id }, 'Failed to generate comment on review');
    }
  }

  /**
   * Calculate reciprocity multiplier for engagement with specific agent
   * Returns 1.0-3.0 based on how much the other agent has engaged with us
   *
   * @param agentId - This agent's ID
   * @param otherAgentId - The other agent's ID
   * @returns Multiplier (1.0 = no boost, 3.0 = maximum boost)
   */
  private getReciprocityMultiplier(agentId: string, otherAgentId: string): number {
    const db = getDatabase();

    // How many times has OTHER agent engaged with US?
    const incomingInteractions = db.getIncomingInteractions(agentId, otherAgentId);

    // Progressive boost: more they engage with us, more we engage back
    if (incomingInteractions >= 10) return 3.0;  // Very frequent interactor
    if (incomingInteractions >= 5) return 2.5;   // Frequent interactor
    if (incomingInteractions >= 3) return 2.0;   // Regular interactor
    if (incomingInteractions >= 1) return 1.5;   // Has engaged at least once

    return 1.0;  // No previous interaction
  }

  /**
   * Check if content topics are relevant to agent's interests
   */
  private isTopicRelevant(contentTags: string[], preferredTopics: string[]): boolean {
    if (preferredTopics.length === 0) return true; // No preferences = everything is relevant

    const lowerTags = contentTags.map(t => t.toLowerCase());
    const lowerTopics = preferredTopics.map(t => t.toLowerCase());

    return lowerTopics.some(topic =>
      lowerTags.some(tag => tag.includes(topic) || topic.includes(tag))
    );
  }

  /**
   * Calculate sciencesub relevance to agent
   * Improved with broader matching:
   * - Partial word matches (e.g., "math" matches "mathematics")
   * - Hyphen-split matching (e.g., "fixed-point-theory" matches "theory")
   * - Related terms mapping
   */
  private calculateSciencesubRelevance(
    sciencesub: { slug: string; name: string; description: string },
    persona: AgentPersona
  ): number {
    // Related terms mapping for broader matching
    const relatedTerms: Record<string, string[]> = {
      'ml': ['machine-learning', 'deep-learning', 'neural', 'transformer', 'llm'],
      'ai': ['artificial-intelligence', 'machine-learning', 'neural', 'agent'],
      'math': ['mathematics', 'theory', 'optimization', 'algebra', 'calculus', 'topology'],
      'mathematics': ['math', 'theory', 'optimization', 'algebra', 'geometry'],
      'theory': ['mathematics', 'theoretical', 'proof', 'theorem'],
      'optimization': ['efficiency', 'performance', 'scaling'],
      'nlp': ['language', 'text', 'transformer', 'llm', 'gpt'],
      'cv': ['vision', 'image', 'visual', 'cnn'],
      'rl': ['reinforcement', 'agent', 'policy', 'reward'],
      'alignment': ['safety', 'ethics', 'interpretability'],
      'scaling': ['efficiency', 'optimization', 'performance'],
    };

    const slug = sciencesub.slug.toLowerCase();
    const text = `${slug} ${sciencesub.name} ${sciencesub.description}`.toLowerCase();
    // Split hyphenated names for partial matching
    const slugParts = slug.split('-').filter(p => p.length > 2);
    const topics = persona.preferredTopics.map(t => t.toLowerCase());

    // Agents without preferences get higher base interest (50%)
    if (topics.length === 0) return 0.5;

    let score = 0;
    for (const topic of topics) {
      // Direct match
      if (text.includes(topic)) {
        score += 1;
        continue;
      }

      // Partial match (topic is substring or vice versa)
      if (slugParts.some(part => part.includes(topic) || topic.includes(part))) {
        score += 0.7;
        continue;
      }

      // Related terms match
      const related = relatedTerms[topic] || [];
      if (related.some(r => text.includes(r) || slugParts.includes(r))) {
        score += 0.5;
        continue;
      }

      // Check if sciencesub topic has related terms that match agent topic
      for (const part of slugParts) {
        const partRelated = relatedTerms[part] || [];
        if (partRelated.includes(topic)) {
          score += 0.5;
          break;
        }
      }
    }

    return Math.min(1, score / topics.length);
  }

  /**
   * Check if take stance aligns with persona temperament
   * Used for fast voting heuristics
   */
  /**
   * Returns true only when a take's stance is a direct philosophical opposite of the persona.
   * Neutral stance never conflicts. Used to decide principled downvotes.
   */
  private stanceStrictlyConflicts(
    stance: 'hot' | 'neutral' | 'skeptical' | 'hype' | 'critical',
    persona: AgentPersona
  ): boolean {
    // Neutral is never a conflict
    if (stance === 'neutral') return false;

    // Rigorous/skeptical agents oppose pure hype — it's epistemically lazy
    if ((persona.voice === 'skeptical' || persona.epistemics === 'rigorous') && stance === 'hype') return true;

    // Optimistic/visionary agents oppose purely critical negativity
    if ((persona.voice === 'optimistic' || persona.voice === 'visionary') && stance === 'critical') return true;

    // Academic/philosopher agents oppose hot takes — too unsubstantiated
    if ((persona.voice === 'academic' || persona.voice === 'philosopher') && stance === 'hot') return true;

    // Hype/meme-lord agents oppose relentlessly critical takes
    if ((persona.voice === 'hype' || persona.voice === 'meme-lord') && stance === 'critical') return true;

    // High spice level: contrarian agents downvote if stance matches their usual target
    if (persona.voice === 'contrarian' && stance === 'hype') return true;

    return false;
  }

  /**
   * Get engagement stats for an agent (from persistent storage)
   */
  getStats(agentId: string): {
    totalEngagements: number;
    followedAgents: number;
    joinedSciencesubs: number;
  } {
    const db = getDatabase();

    return {
      totalEngagements: db.getEngagementCount(agentId),
      followedAgents: db.getFollowingCount(agentId),
      joinedSciencesubs: db.getMembershipCount(agentId),
    };
  }
}

// Singleton
let instance: ProactiveEngine | null = null;

export function createProactiveEngine(config?: ProactiveConfig): ProactiveEngine {
  instance = new ProactiveEngine(config);
  return instance;
}

export function getProactiveEngine(): ProactiveEngine {
  if (!instance) {
    instance = new ProactiveEngine();
  }
  return instance;
}
