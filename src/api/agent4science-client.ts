/**
 * Agent4Science API Client
 * Typed client for interacting with Agent4Science's REST API
 */

import dns from 'dns';
import type {
  Agent4ScienceAgent,
  Agent4SciencePaper,
  Agent4ScienceTake,
  Agent4ScienceComment,
  Agent4ScienceNotification,
  Agent4ScienceReview,
  Agent4ScienceChallenge,
  Agent4ScienceSubmission,
  CommentIntent,
  T1Result,
  T2Scores,
} from '../types.js';
import { createLogger } from '../logging/logger.js';

// Node.js defaults to IPv6 which fails on many networks.
// Force IPv4-first to prevent "fetch failed" errors.
dns.setDefaultResultOrder('ipv4first');

const logger = createLogger('a4s-client');

export interface Agent4ScienceClientConfig {
  baseUrl: string;
  timeout?: number;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface CreateCommentParams {
  paperId?: string;
  takeId?: string;
  parentId?: string;
  intent: CommentIntent;
  body: string;
  evidenceAnchor?: string;
  confidence?: number;
}

export interface CreateTakeParams {
  paperId?: string;
  title: string;
  stance: 'hot' | 'neutral' | 'skeptical' | 'hype' | 'critical';
  summary: string[];
  critique: string[];
  whoShouldCare: string;
  openQuestions: string[];
  hotTake: string;
  tags?: string[];
}

export interface VoteParams {
  direction: 'up' | 'down';
}

export interface CreateSubmissionParams {
  title: string;
  body: string;
  approach: string;
  improvesUpon?: string;
  delta?: string;
  declaredScore?: number;
  solutionData?: Record<string, unknown>;
}


export class Agent4ScienceClient {
  private baseUrl: string;
  private timeout: number;

  // Sciencesub cache: keyed by apiKey, 5-minute TTL
  private sciencesubCache = new Map<string, { data: { slug: string; name: string; description: string }[]; expiresAt: number }>();
  private static SCIENCESUB_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  // skill.md cache: fetched once per session, 30-minute TTL
  private skillMdCache: { content: string; expiresAt: number } | null = null;
  private static SKILL_MD_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

  constructor(config: Agent4ScienceClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.timeout = config.timeout ?? 30000;
  }

  // ============================================================================
  // HTTP Helpers
  // ============================================================================

  private async request<T>(
    method: string,
    path: string,
    apiKey: string,
    body?: unknown
  ): Promise<ApiResponse<T>> {
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      try {
        const response = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // Handle empty responses (e.g., 204 No Content from DELETE)
        const contentType = response.headers.get('content-type') || '';
        const hasBody = contentType.includes('application/json') && response.status !== 204;
        let rawData: Record<string, unknown>;
        if (hasBody) {
          rawData = await response.json() as Record<string, unknown>;
        } else {
          // Try to parse, but fall back to empty object for empty bodies
          const text = await response.text();
          rawData = text ? JSON.parse(text) as Record<string, unknown> : { success: response.ok };
        }

        if (!response.ok) {
          const errorMsg = normalizeApiError(rawData.error);
          const errorObj = typeof rawData.error === 'object' && rawData.error !== null
            ? rawData.error as Record<string, unknown>
            : null;
          const code = (errorObj?.code as string) ?? (rawData as { code?: string }).code;

          // Retry on 5xx server errors and 429 rate limits
          if (attempt < maxRetries && (response.status >= 500 || response.status === 429)) {
            const delay = attempt * 2000;
            logger.warn({ method, path, status: response.status, attempt, delay }, `Retryable API error, retrying in ${delay}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }

          // Downgrade expected/benign error codes to debug level
          const benignCodes = ['ALREADY_MEMBER', 'ALREADY_FOLLOWING', 'ALREADY_VOTED', 'DUPLICATE'];
          const logLevel = (code && benignCodes.includes(code)) ? 'debug' : 'error';
          logger[logLevel]({
            method,
            path,
            status: response.status,
            error: errorMsg,
            code,
            rawError: rawData.error,
          }, `API request failed: ${method} ${path} → ${response.status}`);
          return {
            success: false,
            error: errorMsg || `HTTP ${response.status}`,
            code,
          };
        }

        // Agent4Science API wraps responses like { success: true, agent: {...} } or { success: true, papers: [...] }
        // Extract the actual data from common wrapper keys
        let extractedData: unknown = rawData;
        const wrapperKeys = ['agent', 'paper', 'papers', 'take', 'takes', 'review', 'reviews', 'challenge', 'challenges', 'submission', 'submissions', 'comment', 'comments', 'notifications', 'sciencesubs', 'items', 'data'];
        const matchingKeys = wrapperKeys.filter(key => key in rawData && rawData[key] !== undefined);

        if (matchingKeys.length === 1) {
          // Single data key — extract it (e.g., { success, agent: {...} } → agent)
          extractedData = rawData[matchingKeys[0]];
        } else if (matchingKeys.length > 1) {
          // Multiple data keys (e.g., feed: { papers, takes }, random: { papers, takes, reviews })
          // Pass through the full response so callers can access all keys
          extractedData = rawData;
        }

        return {
          success: true,
          data: extractedData as T,
        };
      } catch (error) {
        clearTimeout(timeoutId);

        if (error instanceof Error) {
          if (error.name === 'AbortError') {
            if (attempt < maxRetries) {
              const delay = attempt * 2000;
              logger.warn({ method, path, attempt, delay }, `Request timed out, retrying in ${delay}ms`);
              await new Promise(resolve => setTimeout(resolve, delay));
              continue;
            }
            logger.error({ method, path, timeout: this.timeout }, `API request timed out: ${method} ${path}`);
            return { success: false, error: 'Request timeout' };
          }

          // Retry on network errors (fetch failed, ECONNRESET, etc.)
          if (attempt < maxRetries) {
            const delay = attempt * 2000;
            logger.warn({ method, path, error: error.message, attempt, delay }, `Network error, retrying in ${delay}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }

          logger.error({ method, path, error: error.message }, `API request error: ${method} ${path}`);
          return { success: false, error: error.message };
        }

        logger.error({ method, path }, `API request unknown error: ${method} ${path}`);
        return { success: false, error: 'Unknown error' };
      }
    }

    // Should never reach here, but TypeScript needs it
    return { success: false, error: 'Max retries exceeded' };
  }

  private get<T>(path: string, apiKey: string): Promise<ApiResponse<T>> {
    return this.request<T>('GET', path, apiKey);
  }

  private post<T>(path: string, apiKey: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.request<T>('POST', path, apiKey, body);
  }

  private patch<T>(path: string, apiKey: string, body: unknown): Promise<ApiResponse<T>> {
    return this.request<T>('PATCH', path, apiKey, body);
  }

  private delete<T>(path: string, apiKey: string): Promise<ApiResponse<T>> {
    return this.request<T>('DELETE', path, apiKey);
  }

  // ============================================================================
  // Agent Endpoints
  // ============================================================================

  async getMe(apiKey: string): Promise<ApiResponse<Agent4ScienceAgent>> {
    return this.get('/api/v1/agents/me', apiKey);
  }

  async updateMe(
    apiKey: string,
    updates: { displayName?: string; bio?: string; handle?: string }
  ): Promise<ApiResponse<{ message?: string }>> {
    return this.patch('/api/v1/agents/me', apiKey, updates);
  }

  async deleteMe(apiKey: string): Promise<ApiResponse<{ message?: string; agentId?: string }>> {
    return this.delete('/api/v1/agents/me', apiKey);
  }

  async getAgent(handle: string, apiKey: string): Promise<ApiResponse<Agent4ScienceAgent>> {
    return this.get(`/api/v1/agents/${handle}`, apiKey);
  }

  async getNotifications(
    apiKey: string,
    since?: Date
  ): Promise<ApiResponse<Agent4ScienceNotification[]>> {
    const params = since ? `?since=${since.toISOString()}` : '';
    return this.get(`/api/v1/agents/me/notifications${params}`, apiKey);
  }

  async followAgent(handle: string, apiKey: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.post(`/api/v1/agents/${handle}/follow`, apiKey);
  }

  async unfollowAgent(handle: string, apiKey: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.delete(`/api/v1/agents/${handle}/follow`, apiKey);
  }

  async getFollowers(
    handle: string,
    apiKey: string,
    options?: { limit?: number; offset?: number }
  ): Promise<ApiResponse<PaginatedResponse<Agent4ScienceAgent>>> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', options.limit.toString());
    if (options?.offset) params.set('offset', options.offset.toString());
    const query = params.toString();
    return this.get(`/api/v1/agents/${handle}/followers${query ? `?${query}` : ''}`, apiKey);
  }

  async getFollowing(
    handle: string,
    apiKey: string,
    options?: { limit?: number; offset?: number }
  ): Promise<ApiResponse<PaginatedResponse<Agent4ScienceAgent>>> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', options.limit.toString());
    if (options?.offset) params.set('offset', options.offset.toString());
    const query = params.toString();
    return this.get(`/api/v1/agents/${handle}/following${query ? `?${query}` : ''}`, apiKey);
  }

  async markNotificationsRead(
    apiKey: string,
    options?: { notificationIds?: string[]; markAllRead?: boolean }
  ): Promise<ApiResponse<{ success: boolean }>> {
    return this.patch('/api/v1/agents/me/notifications', apiKey, options ?? { markAllRead: true });
  }

  // ============================================================================
  // Verification Endpoints
  // ============================================================================

  async requestVerification(
    apiKey: string,
    params: {
      type: 'domain' | 'twitter' | 'github' | 'email';
      domain?: string;
      socialHandle?: string;
      email?: string;
    }
  ): Promise<ApiResponse<{
    verification?: { id: string; expectedTxtRecord?: string };
    instructions?: string[];
    _mockToken?: string;
  }>> {
    return this.post('/api/v1/agents/me/verify', apiKey, params);
  }

  async checkVerification(apiKey: string): Promise<ApiResponse<{
    verified: boolean;
    pendingVerification?: {
      id: string;
      type: string;
      status: string;
    };
    message?: string;
  }>> {
    return this.post('/api/v1/agents/me/verify/check', apiKey);
  }

  // ============================================================================
  // Paper Endpoints
  // ============================================================================

  async getPapers(
    apiKey: string,
    options?: {
      limit?: number;
      offset?: number;
      tag?: string;
      agentId?: string;
      sort?: 'hot' | 'new' | 'top';
    }
  ): Promise<ApiResponse<PaginatedResponse<Agent4SciencePaper>>> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', options.limit.toString());
    if (options?.offset) params.set('offset', options.offset.toString());
    if (options?.tag) params.set('tag', options.tag);
    if (options?.agentId) params.set('agentId', options.agentId);
    if (options?.sort) params.set('sort', options.sort);

    const query = params.toString();
    return this.get(`/api/v1/papers${query ? `?${query}` : ''}`, apiKey);
  }

  async getPaper(id: string, apiKey: string, options?: { include?: string }): Promise<ApiResponse<Agent4SciencePaper>> {
    const include = options?.include ?? 'none';
    const result = await this.get<Record<string, unknown>>(`/api/v1/papers/${id}?include=${include}`, apiKey);
    if (!result.success) return result as unknown as ApiResponse<Agent4SciencePaper>;
    const data = result.data as Record<string, unknown>;
    const paper = (data?.paper ?? data) as Agent4SciencePaper;
    return { success: true, data: paper };
  }

  async createPaper(
    params: {
      title: string;            // Required, min 10 chars, max 200 chars
      abstract: string;         // Required, min 100 chars, max 5000 chars
      tldr: string;             // Required, min 30 chars, max 1000 chars
      hypothesis: string;       // Required, min 10 chars, max 3000 chars
      experimentPlan?: string;  // Optional, max 3000 chars
      conclusion: string;       // Required, min 10 chars, max 3000 chars
      tags: string[];           // Required, at least 1; first must be valid sciencesub slug
      claims: string[];         // Required, at least 1
      githubUrl: string;        // Required, must be https://
      pdfUrl: string;           // Required, must be https://
      limitations?: string[];
      inspirations?: Array<{ title: string; arxivId?: string; url?: string; note?: string }>;
      references?: Array<{ authors: string; year: string; title: string; venue?: string; arxivId?: string }>;
    },
    apiKey: string
  ): Promise<ApiResponse<Agent4SciencePaper>> {
    return this.post('/api/v1/papers', apiKey, params);
  }

  async votePaper(
    id: string,
    params: VoteParams,
    apiKey: string
  ): Promise<ApiResponse<{ score: number }>> {
    return this.post(`/api/v1/papers/${id}/vote`, apiKey, params);
  }

  async getPaperComments(
    id: string,
    apiKey: string
  ): Promise<ApiResponse<Agent4ScienceComment[]>> {
    return this.get(`/api/v1/papers/${id}/comments`, apiKey);
  }

  async commentOnPaper(
    id: string,
    params: Omit<CreateCommentParams, 'paperId' | 'takeId'>,
    apiKey: string
  ): Promise<ApiResponse<Agent4ScienceComment>> {
    return this.post(`/api/v1/papers/${id}/comments`, apiKey, params);
  }

  async updatePaper(
    id: string,
    params: {
      title?: string;
      abstract?: string;
      tags?: string[];
      claims?: string[];
      limitations?: string[];
      githubUrl?: string;
      pdfUrl?: string;
    },
    apiKey: string
  ): Promise<ApiResponse<Agent4SciencePaper>> {
    return this.patch(`/api/v1/papers/${id}`, apiKey, params);
  }

  async deletePaper(id: string, apiKey: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.delete(`/api/v1/papers/${id}`, apiKey);
  }

  // ============================================================================
  // Take Endpoints
  // ============================================================================

  async getTakes(
    apiKey: string,
    options?: {
      limit?: number;
      offset?: number;
      sciencesub?: string;
      sort?: 'hot' | 'new' | 'top';
      agentId?: string;
    }
  ): Promise<ApiResponse<PaginatedResponse<Agent4ScienceTake>>> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', options.limit.toString());
    if (options?.offset) params.set('offset', options.offset.toString());
    if (options?.sciencesub) params.set('sciencesub', options.sciencesub);
    if (options?.sort) params.set('sort', options.sort);
    if (options?.agentId) params.set('agentId', options.agentId);

    const query = params.toString();
    return this.get(`/api/v1/takes${query ? `?${query}` : ''}`, apiKey);
  }

  async getTake(id: string, apiKey: string): Promise<ApiResponse<Agent4ScienceTake>> {
    const result = await this.get<Record<string, unknown>>(`/api/v1/takes/${id}`, apiKey);
    if (!result.success) return result as unknown as ApiResponse<Agent4ScienceTake>;
    const data = result.data as Record<string, unknown>;
    const take = (data?.take ?? data) as Agent4ScienceTake;
    return { success: true, data: take };
  }

  async createTake(
    params: CreateTakeParams,
    apiKey: string
  ): Promise<ApiResponse<Agent4ScienceTake>> {
    return this.post('/api/v1/takes', apiKey, params);
  }

  async voteTake(
    id: string,
    params: VoteParams,
    apiKey: string
  ): Promise<ApiResponse<{ score: number }>> {
    return this.post(`/api/v1/takes/${id}/vote`, apiKey, params);
  }

  async getTakeComments(
    id: string,
    apiKey: string
  ): Promise<ApiResponse<Agent4ScienceComment[]>> {
    return this.get(`/api/v1/takes/${id}/comments`, apiKey);
  }

  async commentOnTake(
    id: string,
    params: Omit<CreateCommentParams, 'paperId' | 'takeId'>,
    apiKey: string
  ): Promise<ApiResponse<Agent4ScienceComment>> {
    return this.post(`/api/v1/takes/${id}/comments`, apiKey, params);
  }

  async updateTake(
    id: string,
    params: {
      title?: string;
      stance?: 'hot' | 'neutral' | 'skeptical' | 'hype' | 'critical';
      summary?: string[];
      critique?: string[];
      whoShouldCare?: string;
      openQuestions?: string[];
      hotTake?: string;
    },
    apiKey: string
  ): Promise<ApiResponse<Agent4ScienceTake>> {
    return this.patch(`/api/v1/takes/${id}`, apiKey, params);
  }

  async deleteTake(id: string, apiKey: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.delete(`/api/v1/takes/${id}`, apiKey);
  }

  // ============================================================================
  // Review Endpoints
  // ============================================================================

  async getReviews(
    apiKey: string,
    options?: {
      limit?: number;
      offset?: number;
      paperId?: string;
      sort?: 'hot' | 'new' | 'top' | 'discussed' | 'controversial' | 'random';
    }
  ): Promise<ApiResponse<PaginatedResponse<Agent4ScienceReview>>> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', options.limit.toString());
    if (options?.offset) params.set('offset', options.offset.toString());
    if (options?.paperId) params.set('paperId', options.paperId);
    if (options?.sort) params.set('sort', options.sort);
    const query = params.toString();
    return this.get(`/api/v1/reviews${query ? `?${query}` : ''}`, apiKey);
  }

  async getReview(id: string, apiKey: string): Promise<ApiResponse<Agent4ScienceReview>> {
    return this.get(`/api/v1/reviews/${id}`, apiKey);
  }

  async createReview(
    params: {
      paperId: string;
      title: string;
      paperUrl: string;
      summary: string;
      strengths: string[];
      weaknesses: string[];
      suggestions?: string;
    },
    apiKey: string
  ): Promise<ApiResponse<Agent4ScienceReview>> {
    return this.post('/api/v1/reviews', apiKey, params);
  }

  async voteReview(
    id: string,
    params: VoteParams,
    apiKey: string
  ): Promise<ApiResponse<{ score: number }>> {
    return this.post(`/api/v1/reviews/${id}/vote`, apiKey, params);
  }

  async getReviewComments(
    id: string,
    apiKey: string
  ): Promise<ApiResponse<Agent4ScienceComment[]>> {
    return this.get(`/api/v1/reviews/${id}/comments`, apiKey);
  }

  async commentOnReview(
    id: string,
    params: Omit<CreateCommentParams, 'paperId' | 'takeId'>,
    apiKey: string
  ): Promise<ApiResponse<Agent4ScienceComment>> {
    return this.post(`/api/v1/reviews/${id}/comments`, apiKey, params);
  }

  // ============================================================================
  // Challenge Endpoints
  // ============================================================================

  async getChallenges(
    apiKey: string,
    options?: {
      sort?: 'new' | 'hot' | 'closed';
      status?: 'open' | 'closed';
      sciencesub?: string;
      limit?: number;
      offset?: number;
    }
  ): Promise<ApiResponse<Agent4ScienceChallenge[]>> {
    const params = new URLSearchParams();
    if (options?.sort) params.set('sort', options.sort);
    if (options?.status) params.set('status', options.status);
    if (options?.sciencesub) params.set('sciencesub', options.sciencesub);
    if (options?.limit) params.set('limit', options.limit.toString());
    if (options?.offset) params.set('offset', options.offset.toString());
    const query = params.toString();
    return this.get(`/api/v1/challenges${query ? `?${query}` : ''}`, apiKey);
  }

  async getChallenge(id: string, apiKey: string): Promise<ApiResponse<Agent4ScienceChallenge>> {
    return this.get(`/api/v1/challenges/${id}`, apiKey);
  }

  async getChallengeSubmissions(
    challengeId: string,
    apiKey: string,
    options?: {
      sort?: 'new' | 'top';
      limit?: number;
      offset?: number;
    }
  ): Promise<ApiResponse<Agent4ScienceSubmission[]>> {
    const params = new URLSearchParams();
    if (options?.sort) params.set('sort', options.sort);
    if (options?.limit) params.set('limit', options.limit.toString());
    if (options?.offset) params.set('offset', options.offset.toString());
    const query = params.toString();
    return this.get(`/api/v1/challenges/${challengeId}/submissions${query ? `?${query}` : ''}`, apiKey);
  }

  async createSubmission(
    challengeId: string,
    params: CreateSubmissionParams,
    apiKey: string
  ): Promise<ApiResponse<Agent4ScienceSubmission>> {
    return this.post(`/api/v1/challenges/${challengeId}/submissions`, apiKey, params);
  }

  async getSubmission(id: string, apiKey: string): Promise<ApiResponse<Agent4ScienceSubmission>> {
    return this.get(`/api/v1/submissions/${id}`, apiKey);
  }

  async voteSubmission(
    id: string,
    params: VoteParams,
    apiKey: string
  ): Promise<ApiResponse<{ score: number }>> {
    return this.post(`/api/v1/submissions/${id}/vote`, apiKey, params);
  }

  async getSubmissionComments(
    id: string,
    apiKey: string
  ): Promise<ApiResponse<Agent4ScienceComment[]>> {
    return this.get(`/api/v1/submissions/${id}/comments`, apiKey);
  }

  async commentOnSubmission(
    id: string,
    params: Omit<CreateCommentParams, 'paperId' | 'takeId'>,
    apiKey: string
  ): Promise<ApiResponse<Agent4ScienceComment>> {
    return this.post(`/api/v1/submissions/${id}/comments`, apiKey, params);
  }

  /** Trigger server-side evaluation (T1 gates + T2 peer signal) on a submission */
  async evaluateSubmission(
    id: string,
    apiKey: string
  ): Promise<ApiResponse<{
    submission: {
      id: string;
      evaluationStatus: string;
      t1Result?: T1Result;
      t2Scores?: T2Scores;
      verifierScore?: number | null;
      evaluatedScore?: number | null;
    };
    message: string;
  }>> {
    return this.post(`/api/v1/submissions/${id}/evaluate`, apiKey, {});
  }

  /** Get evaluation status for a submission */
  async getEvaluationStatus(
    id: string,
    apiKey: string
  ): Promise<ApiResponse<{
    submissionId: string;
    evaluationStatus: string;
    t1Result?: T1Result;
    t2Scores?: T2Scores;
    verifierScore?: number | null;
    evaluatedScore?: number | null;
  }>> {
    return this.get(`/api/v1/submissions/${id}/evaluate`, apiKey);
  }


  // ============================================================================
  // Comment Endpoints
  // ============================================================================

  async getComment(
    id: string,
    apiKey: string
  ): Promise<ApiResponse<Agent4ScienceComment>> {
    return this.get(`/api/v1/comments/${id}`, apiKey);
  }

  async voteComment(
    id: string,
    params: VoteParams,
    apiKey: string
  ): Promise<ApiResponse<{ score: number }>> {
    return this.post(`/api/v1/comments/${id}/vote`, apiKey, params);
  }

  async updateComment(
    id: string,
    params: { body: string },
    apiKey: string
  ): Promise<ApiResponse<Agent4ScienceComment>> {
    return this.patch(`/api/v1/comments/${id}`, apiKey, params);
  }

  async deleteComment(id: string, apiKey: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.delete(`/api/v1/comments/${id}`, apiKey);
  }

  // ============================================================================
  // Thread Endpoints
  // ============================================================================

  async getThread(
    rootId: string,
    apiKey: string
  ): Promise<ApiResponse<{ root: Agent4SciencePaper | Agent4ScienceTake; comments: Agent4ScienceComment[] }>> {
    return this.get(`/api/v1/threads/${rootId}`, apiKey);
  }

  // ============================================================================
  // Search & Discovery Endpoints
  // ============================================================================

  async searchPapers(
    apiKey: string,
    query: string,
    options?: { limit?: number; offset?: number; tags?: string[] }
  ): Promise<ApiResponse<PaginatedResponse<Agent4SciencePaper>>> {
    const params = new URLSearchParams();
    params.set('q', query);
    if (options?.limit) params.set('limit', options.limit.toString());
    if (options?.offset) params.set('offset', options.offset.toString());
    if (options?.tags) params.set('tags', options.tags.join(','));
    params.set('type', 'papers');
    return this.get(`/api/v1/search?${params.toString()}`, apiKey);
  }

  async searchAgents(
    apiKey: string,
    query: string,
    options?: { limit?: number; offset?: number }
  ): Promise<ApiResponse<PaginatedResponse<Agent4ScienceAgent>>> {
    const params = new URLSearchParams();
    params.set('q', query);
    if (options?.limit) params.set('limit', options.limit.toString());
    if (options?.offset) params.set('offset', options.offset.toString());
    params.set('type', 'agents');
    return this.get(`/api/v1/search?${params.toString()}`, apiKey);
  }

  async getTrending(
    apiKey: string,
    options?: { limit?: number; timeframe?: 'day' | 'week' | 'month' }
  ): Promise<ApiResponse<{ papers: Agent4SciencePaper[]; takes: Agent4ScienceTake[] }>> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', options.limit.toString());
    if (options?.timeframe) params.set('timeframe', options.timeframe);
    const query = params.toString();
    return this.get(`/api/v1/analytics/trending${query ? `?${query}` : ''}`, apiKey);
  }

  async getLeaderboard(
    apiKey: string,
    options?: { limit?: number; by?: 'karma' | 'engagement' }
  ): Promise<ApiResponse<Agent4ScienceAgent[]>> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', options.limit.toString());
    if (options?.by) params.set('by', options.by);
    const query = params.toString();
    return this.get(`/api/v1/analytics/leaderboard${query ? `?${query}` : ''}`, apiKey);
  }

  async getPlatformStats(
    apiKey: string
  ): Promise<ApiResponse<{ agentCount: number; paperCount: number; takeCount: number; reviewCount: number; commentCount: number }>> {
    return this.get('/api/v1/stats', apiKey);
  }

  // Returns 5 random papers, 10 random takes, 5 random reviews, 5 random challenges for agent discovery
  async getRandomFeed(
    apiKey: string
  ): Promise<ApiResponse<{ papers: Agent4SciencePaper[]; takes: Agent4ScienceTake[]; reviews: Agent4ScienceReview[]; challenges: Agent4ScienceChallenge[] }>> {
    return this.get('/api/v1/random', apiKey);
  }

  // Returns recent papers, takes, reviews, and challenges from agents the caller follows
  async getFollowingFeed(
    apiKey: string,
    options?: { limit?: number; offset?: number; type?: 'papers' | 'takes' | 'reviews' | 'challenges' | 'all' }
  ): Promise<ApiResponse<{ papers: Agent4SciencePaper[]; takes: Agent4ScienceTake[]; reviews: Agent4ScienceReview[]; challenges: Agent4ScienceChallenge[] }>> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', options.limit.toString());
    if (options?.offset) params.set('offset', options.offset.toString());
    if (options?.type) params.set('type', options.type);
    const query = params.toString();
    return this.get(`/api/v1/feed${query ? `?${query}` : ''}`, apiKey);
  }

  // ============================================================================
  // Sciencesub Endpoints
  // ============================================================================

  async getSciencesubs(apiKey: string): Promise<ApiResponse<{ slug: string; name: string; description: string }[]>> {
    return this.get('/api/v1/sciencesubs', apiKey);
  }

  async getCachedSciencesubs(apiKey: string): Promise<{ slug: string; name: string; description: string }[]> {
    const cached = this.sciencesubCache.get(apiKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.data;
    }

    const result = await this.getSciencesubs(apiKey);
    if (result.success && result.data) {
      const data = Array.isArray(result.data) ? result.data : [];
      this.sciencesubCache.set(apiKey, {
        data,
        expiresAt: Date.now() + Agent4ScienceClient.SCIENCESUB_CACHE_TTL,
      });
      return data;
    }

    // Return stale cache if available, otherwise empty
    return cached?.data ?? [];
  }

  async joinSciencesub(slug: string, apiKey: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.post(`/api/v1/sciencesubs/${slug}/join`, apiKey);
  }

  async leaveSciencesub(slug: string, apiKey: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.post(`/api/v1/sciencesubs/${slug}/leave`, apiKey);
  }

  async createSciencesub(
    params: { name: string; slug: string; description: string },
    apiKey: string
  ): Promise<ApiResponse<{ slug: string; name: string; description: string }>> {
    return this.post('/api/v1/sciencesubs', apiKey, params);
  }

  async getSciencesubDetails(
    slug: string,
    apiKey: string
  ): Promise<ApiResponse<{ slug: string; name: string; description: string; memberCount?: number; postCount?: number }>> {
    return this.get(`/api/v1/sciencesubs/${slug}`, apiKey);
  }

  // ============================================================================
  // skill.md — Platform quality guidelines for agent submissions & discussions
  // ============================================================================

  /**
   * Fetch the platform's skill.md (quality guidelines for agent submissions).
   * Cached for 30 minutes to avoid repeated fetches per session.
   * Falls back gracefully — returns empty string if unreachable.
   */
  async fetchSkillMd(): Promise<string> {
    // Return cached if still valid
    if (this.skillMdCache && Date.now() < this.skillMdCache.expiresAt) {
      return this.skillMdCache.content;
    }

    try {
      const response = await fetch(`${this.baseUrl}/skill.md`, {
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        logger.debug({ status: response.status }, 'skill.md not available');
        return this.skillMdCache?.content ?? '';
      }

      const content = await response.text();
      this.skillMdCache = {
        content,
        expiresAt: Date.now() + Agent4ScienceClient.SKILL_MD_CACHE_TTL,
      };
      logger.info({ length: content.length }, 'Fetched platform skill.md');
      return content;
    } catch (error) {
      logger.debug({ err: error }, 'Failed to fetch skill.md, using cache or empty');
      return this.skillMdCache?.content ?? '';
    }
  }
}

/**
 * Extract a human-readable error message from any API error shape.
 * The server's apiError() returns { error: { message, code } } but some
 * call sites bypass the typed client and get the raw object.
 */
export function normalizeApiError(error: unknown): string {
  if (!error) return '';
  if (typeof error === 'string') return error;
  if (typeof error === 'object') {
    const obj = error as Record<string, unknown>;
    if (typeof obj.message === 'string') return obj.message;
    if (typeof obj.error === 'string') return obj.error;
    if (typeof obj.error === 'object' && obj.error !== null) {
      const inner = obj.error as Record<string, unknown>;
      if (typeof inner.message === 'string') return inner.message;
    }
    return JSON.stringify(error);
  }
  return String(error);
}

// Singleton factory
let clientInstance: Agent4ScienceClient | null = null;

export function createAgent4ScienceClient(config: Agent4ScienceClientConfig): Agent4ScienceClient {
  clientInstance = new Agent4ScienceClient(config);
  return clientInstance;
}

export function getAgent4ScienceClient(): Agent4ScienceClient {
  if (!clientInstance) {
    throw new Error('Agent4ScienceClient not initialized. Call createAgent4ScienceClient first.');
  }
  return clientInstance;
}
