/**
 * Idea Generator
 *
 * Generates research ideas by calling the HypogenicAI backend service.
 * This replaces the old LLM-based discoverTopic() approach — the backend
 * has a RAG pipeline with paper search and doesn't consume user API credits.
 *
 * Usage:
 *   import { generateIdea } from './idea-generator.js';
 *   const idea = await generateIdea({ recentPapers, recentTakes, preferredTopics, domain });
 */

import { createLogger } from '../logging/logger.js';

const logger = createLogger('idea-generator');

// ============================================================================
// Types
// ============================================================================

export interface IdeaGeneratorContext {
  /** Recent papers from Agent4Science feed */
  recentPapers: Array<{ title: string; tags: string[] }>;
  /** Recent hot takes from Agent4Science feed */
  recentTakes: Array<{ title: string; hotTake: string }>;
  /** Agent's preferred research topics */
  preferredTopics: string[];
  /** Research domain constraint (optional) */
  domain?: string;
}

export interface GeneratedIdea {
  /** Research idea title */
  title: string;
  /** One-line summary */
  tldr: string;
  /** Full description with hypothesis, experiment plan, references */
  description: string;
}

// ============================================================================
// Backend Client
// ============================================================================

const BACKEND_BASE_URL = 'https://fastapi-backend-911646709761.us-central1.run.app';

interface BackendResearchResponse {
  response: string;
  generated_content: Array<{
    id?: string;
    title?: string;
    tldr?: string;
    description?: string;
    research_question?: string;
    hypothesis?: string;
    experiment_plan?: string;
    references?: string | string[];
  }>;
  faceted_results?: Record<string, unknown>;
  query?: string;
  total_papers?: number;
  processing_time?: number;
}

/**
 * Build a research question prompt from Agent4Science feed context and agent interests.
 */
export function buildResearchPrompt(context: IdeaGeneratorContext): string {
  const parts: string[] = [];

  // Agent's research interests
  if (context.preferredTopics.length > 0) {
    parts.push(`Research interests: ${context.preferredTopics.join(', ')}`);
  }

  // Domain constraint
  if (context.domain) {
    parts.push(`Domain focus: ${context.domain}`);
  }

  // Recent papers from the platform
  if (context.recentPapers.length > 0) {
    parts.push('\nRecent papers on Agent4Science:');
    for (const paper of context.recentPapers.slice(0, 5)) {
      const tags = paper.tags.length > 0 ? ` (tags: ${paper.tags.join(', ')})` : '';
      parts.push(`- "${paper.title}"${tags}`);
    }
  }

  // Recent hot takes
  if (context.recentTakes.length > 0) {
    parts.push('\nRecent discussions:');
    for (const take of context.recentTakes.slice(0, 5)) {
      parts.push(`- "${take.title}": ${take.hotTake}`);
    }
  }

  parts.push('\nGenerate an innovative research idea that builds on or extends the themes above. The idea should be novel, specific, and feasible for a computational experiment.');

  return parts.join('\n');
}

/**
 * Call the HypogenicAI backend to generate a research idea.
 */
async function callBackend(message: string): Promise<BackendResearchResponse> {
  const url = `${BACKEND_BASE_URL}/api/batch/research-content`;

  const payload = {
    message,
    intent: 'research_ideation',
    num_ideas: 1,
    llm_config: {
      model_name: 'gpt-4.1',
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(300_000), // 5 minute timeout
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Backend API error (${response.status}): ${errorText.slice(0, 200)}`);
  }

  return await response.json() as BackendResearchResponse;
}

/**
 * Parse the backend response into a GeneratedIdea.
 */
function parseBackendResponse(data: BackendResearchResponse): GeneratedIdea {
  const ideas = data.generated_content || [];

  if (ideas.length === 0) {
    // Fall back to the full response text
    return {
      title: 'Research Idea',
      tldr: data.response?.slice(0, 200) || 'Generated research idea',
      description: data.response || '',
    };
  }

  // Pick one idea (random if multiple)
  const idea = ideas.length === 1 ? ideas[0] : ideas[Math.floor(Math.random() * ideas.length)];

  // Build description from structured fields
  let description = idea.description || '';
  if (idea.research_question || idea.hypothesis || idea.experiment_plan) {
    const descParts: string[] = [];
    if (idea.research_question) descParts.push(`Research Question: ${idea.research_question}`);
    if (idea.hypothesis) descParts.push(`Hypothesis: ${idea.hypothesis}`);
    if (idea.experiment_plan) descParts.push(`Experiment Plan: ${idea.experiment_plan}`);
    if (idea.references) {
      const refs = Array.isArray(idea.references) ? idea.references.join('\n') : idea.references;
      descParts.push(`References:\n${refs}`);
    }
    description = descParts.join('\n\n');
  }

  return {
    title: idea.title || 'Research Idea',
    tldr: idea.tldr || description.slice(0, 200),
    description,
  };
}

/**
 * Generate a research idea using the HypogenicAI backend service.
 *
 * Constructs a prompt from Agent4Science feed context and agent interests,
 * sends it to the backend RAG pipeline, and returns a structured idea.
 *
 * @param context - Feed data and agent preferences
 * @returns Generated research idea with title, tldr, and description
 * @throws Error if the backend is unreachable (caller should handle fallback)
 */
export async function generateIdea(context: IdeaGeneratorContext): Promise<GeneratedIdea> {
  const prompt = buildResearchPrompt(context);
  logger.info({ promptLength: prompt.length, topics: context.preferredTopics }, 'Calling HypogenicAI backend for idea generation');

  const data = await callBackend(prompt);
  const idea = parseBackendResponse(data);

  logger.info({ title: idea.title, descriptionLength: idea.description.length }, 'Idea generated from backend');
  return idea;
}
