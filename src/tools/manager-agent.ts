/**
 * Manager Agent
 *
 * Orchestrates the paper generation lifecycle for idea-explorer agents:
 *   1. Discover interesting topics from Agent4Science (trending papers, discussions)
 *   2. Use LLM to formulate a research idea
 *   3. Invoke idea-explorer CLI
 *   4. Post the results to Agent4Science via normal API (using agent's own API key)
 *
 * This runs on a schedule (default: once per 24h per agent) as part of the
 * main event loop.
 */

import { createLogger } from '../logging/logger.js';
import { getAgent4ScienceClient } from '../api/agent4science-client.js';
import { ensureFirstTagIsSciencesub } from '../engagement/proactive-engine.js';
import { runIdeaExplorer, resolveIdeaExplorerPath, type IdeaExplorerResult } from './paper-tools.js';
import { getDatabase } from '../db/database.js';
import type { AgentCapability, Agent4SciencePaper } from '../types.js';

const logger = createLogger('manager-agent');

// ============================================================================
// Types
// ============================================================================

export interface ManagerAgentConfig {
  /** Agent's Agent4Science API key (for posting papers + reading feed) */
  apiKey: string;
  /** Agent's database ID */
  agentId: string;
  /** Agent capability type */
  capability: AgentCapability;
  /** Research domain (e.g. 'mathematics', 'artificial_intelligence') */
  researchDomain?: string;
  /** LLM API key (OpenRouter or compatible) */
  llmApiKey: string;
  /** LLM model */
  llmModel?: string;
  /** GitHub Personal Access Token (needed for idea-explorer) */
  githubToken?: string;
  /** GitHub org name */
  githubOrg?: string;
  /** Path to idea-explorer installation */
  ideaExplorerPath?: string;
  /** AI provider for idea-explorer (default: claude) */
  ideaExplorerProvider?: 'claude' | 'codex' | 'gemini';
}

export interface PaperGenerationResult {
  success: boolean;
  agent4sciencePaperId?: string;
  title?: string;
  githubUrl?: string;
  error?: string;
}

// ============================================================================
// Topic Discovery
// ============================================================================

/**
 * Discover what's trending on Agent4Science and generate a research topic.
 */
async function discoverTopic(
  apiKey: string,
  llmApiKey: string,
  llmModel?: string,
): Promise<string> {
  const client = getAgent4ScienceClient();

  // Fetch recent papers and takes for inspiration
  const [papersResult, takesResult] = await Promise.all([
    client.getPapers(apiKey, { limit: 10, sort: 'hot' }),
    client.getTakes(apiKey, { limit: 10, sort: 'hot' }),
  ]);

  // The API client extracts wrapper keys, so data is the array directly
  const papers: Agent4SciencePaper[] = Array.isArray(papersResult.data) ? papersResult.data : [];
  const takes: Array<{ title: string; hotTake: string }> = Array.isArray(takesResult.data) ? takesResult.data : [];

  // Build context from recent activity
  const context = [
    'Recent papers on Agent4Science:',
    ...papers.slice(0, 5).map((p: Agent4SciencePaper) => `- "${p.title}" (tags: ${p.tags.join(', ')})`),
    '',
    'Recent hot takes:',
    ...takes.slice(0, 5).map((t: { title: string; hotTake: string }) => `- "${t.title}": ${t.hotTake}`),
  ].join('\n');

  // Use LLM to generate a novel research topic
  const baseUrl = 'https://openrouter.ai/api/v1';
  const model = llmModel || 'anthropic/claude-sonnet-4';

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${llmApiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: `You are a creative research scientist who identifies promising research directions.
Given recent activity on a science discussion platform, suggest a novel, specific research topic
that would contribute meaningfully to the ongoing discussions. The topic should be original and not
just repeat what's already been posted. Return ONLY the topic as a single sentence - no explanation.`,
        },
        {
          role: 'user',
          content: context || 'Suggest a novel mathematical research topic.',
        },
      ],
      temperature: 0.9,
      max_tokens: 256,
    }),
  });

  if (!response.ok) {
    logger.warn('Topic discovery LLM call failed, using fallback');
    return 'Generate a novel mathematical research topic';
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
  };
  const topic = data.choices[0]?.message?.content?.trim();
  return topic || 'Generate a novel mathematical research topic';
}

// ============================================================================
// Paper Generation Flows
// ============================================================================

/**
 * Use LLM to generate a structured idea YAML from a topic string.
 * Produces a YAML that matches idea-explorer's schema (title, domain, hypothesis,
 * background, methodology).
 */
async function generateIdeaYaml(
  topic: string,
  llmApiKey: string,
  llmModel?: string,
  domain?: string,
): Promise<string> {
  const baseUrl = 'https://openrouter.ai/api/v1';
  const model = llmModel || 'anthropic/claude-sonnet-4';

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${llmApiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: `You are a research scientist. Given a topic, generate a structured research idea in YAML format.
Output ONLY valid YAML (no markdown fences). Follow this schema exactly:

idea:
  title: "Clear, descriptive title"
  domain: ${domain || 'artificial_intelligence'}
  hypothesis: |
    A specific, testable hypothesis (2-3 sentences).
  background:
    description: |
      Context and motivation (2-3 sentences).
  methodology:
    approach: "High-level strategy (1 sentence)"
    steps:
      - "Step 1"
      - "Step 2"
      - "Step 3"
    metrics:
      - "Metric 1"
      - "Metric 2"
  constraints:
    compute: cpu_only
    time_limit: 3600
  metadata:
    tags:
      - "tag1"
      - "tag2"

Valid domains: machine_learning, artificial_intelligence, data_science, nlp, computer_vision, reinforcement_learning, systems, theory, scientific_computing, mathematics

Use domain "${domain || 'artificial_intelligence'}" unless the topic clearly belongs to another domain.`,
          },
          { role: 'user', content: topic },
        ],
        temperature: 0.7,
        max_tokens: 1024,
      }),
    });

    if (!response.ok) {
      logger.warn('Idea YAML generation LLM call failed, using minimal YAML');
      return buildMinimalYaml(topic, domain);
    }

    const data = await response.json() as { choices: Array<{ message: { content: string } }> };
    const yaml = data.choices[0]?.message?.content?.trim();
    if (yaml && yaml.includes('idea:')) return yaml;
  } catch {
    logger.warn('Failed to generate idea YAML via LLM');
  }

  return buildMinimalYaml(topic, domain);
}

/** Fallback: build a minimal but valid idea YAML. */
function buildMinimalYaml(topic: string, domain?: string): string {
  const escaped = topic.replace(/"/g, '\\"');
  return [
    'idea:',
    `  title: "${escaped}"`,
    `  domain: ${domain || 'artificial_intelligence'}`,
    '  hypothesis: |',
    `    ${escaped}`,
    '  methodology:',
    '    approach: "Empirical study with controlled experiments"',
    '    steps:',
    '      - "Literature review and baseline identification"',
    '      - "Design and implement experiments"',
    '      - "Run experiments and collect results"',
    '      - "Analyze results and draw conclusions"',
    '    metrics:',
    '      - "Accuracy"',
    '      - "Statistical significance"',
    '  constraints:',
    '    compute: cpu_only',
    '    time_limit: 3600',
  ].join('\n');
}

/**
 * Summarize a research report (REPORT.md) into a concise post for Agent4Science.
 * Returns a title, abstract (2-3 paragraphs), and relevant tags.
 */
interface ReportSummary {
  title: string;
  abstract: string;
  tldr: string;
  hypothesis: string;
  experimentPlan: string;
  conclusion: string;
  tags: string[];
  claims: string[];
  limitations: string[];
}

async function summarizeReportForPost(
  reportContent: string,
  llmApiKey: string,
  llmModel?: string,
  sciencesubs?: { slug: string; name: string }[],
): Promise<ReportSummary | null> {
  const baseUrl = 'https://openrouter.ai/api/v1';
  const model = llmModel || 'anthropic/claude-sonnet-4';

  let tagsInstruction = '- "tags": An array of 3-6 lowercase tags relevant to the research (e.g., "machine-learning", "mathematics", "nlp", "computer-vision")';
  if (sciencesubs && sciencesubs.length > 0) {
    const slugList = sciencesubs.map(s => s.slug).join(', ');
    tagsInstruction = `- "tags": An array of 3-6 lowercase tags. The FIRST tag MUST be one of these sciencesub slugs: ${slugList}. Remaining tags are free-form research area tags.`;
  }

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${llmApiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: `You are writing a post for a scientific discussion platform (like academic Twitter/Reddit).
Given a research report, produce a JSON object with:
- "title": A clear, engaging paper title (max 120 chars)
- "tldr": A single-sentence summary of the paper (min 10 chars, max 200 chars)
- "abstract": A concise summary (2-3 paragraphs, ~200-400 words) that covers the research question, methodology, key findings, and significance. Write in an accessible academic style.
- "hypothesis": The main hypothesis or research question (1-2 sentences)
- "experimentPlan": Brief description of how the hypothesis was tested (1-2 sentences)
- "conclusion": The main conclusion from the research (1-2 sentences)
${tagsInstruction}
- "claims": An array of 2-5 key claims or findings from the research (each a single sentence, max 100 chars)
- "limitations": An array of 1-3 limitations of the work (each a single sentence)

Output ONLY valid JSON, no markdown fences.`,
          },
          { role: 'user', content: reportContent },
        ],
        temperature: 0.3,
        max_tokens: 1500,
      }),
    });

    if (!response.ok) {
      logger.warn('Report summarization LLM call failed');
      return null;
    }

    const data = await response.json() as { choices: Array<{ message: { content: string } }> };
    const content = data.choices[0]?.message?.content?.trim();
    if (!content) return null;

    const parsed = JSON.parse(content) as Partial<ReportSummary>;
    if (!parsed.abstract) return null;

    return {
      title: parsed.title || '',
      tldr: parsed.tldr || parsed.title || '',
      abstract: parsed.abstract,
      hypothesis: parsed.hypothesis ?? parsed.claims?.[0] ?? 'This work investigates a novel approach',
      experimentPlan: parsed.experimentPlan ?? '',
      conclusion: parsed.conclusion ?? 'Results demonstrate the validity of the proposed approach',
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      claims: Array.isArray(parsed.claims) && parsed.claims.length > 0
        ? parsed.claims
        : ['This paper presents novel research findings.'],
      limitations: Array.isArray(parsed.limitations) ? parsed.limitations : [],
    };
  } catch (error) {
    logger.warn({ error }, 'Failed to summarize report via LLM');
    return null;
  }
}

/**
 * Run the full idea-explorer paper generation flow:
 * discover topic → generate idea YAML → submit + run → post to Agent4Science
 */
async function runIdeaExplorerFlow(config: ManagerAgentConfig): Promise<PaperGenerationResult> {
  const iePath = config.ideaExplorerPath || resolveIdeaExplorerPath();
  if (!iePath) {
    return {
      success: false,
      error: 'Idea Explorer not found. Install it: curl -fsSL https://raw.githubusercontent.com/ChicagoHAI/idea-explorer/main/install.sh | bash',
    };
  }

  // Step 1: Discover topic from Agent4Science
  logger.info({ agentId: config.agentId }, 'Discovering research topic for Idea Explorer');
  const topic = await discoverTopic(config.apiKey, config.llmApiKey, config.llmModel);
  logger.info({ topic }, 'Topic selected');

  // Step 2: Generate a structured idea YAML
  logger.info('Generating structured idea YAML');
  const ideaYaml = await generateIdeaYaml(topic, config.llmApiKey, config.llmModel, config.researchDomain);

  // Write YAML to a temp file
  const fs = await import('fs');
  const path = await import('path');
  const tmpDir = path.join(iePath, '.tmp-ideas');
  fs.mkdirSync(tmpDir, { recursive: true });
  const yamlPath = path.join(tmpDir, `idea-${Date.now()}.yaml`);
  fs.writeFileSync(yamlPath, ideaYaml);
  logger.info({ yamlPath }, 'Idea YAML written');

  // Step 3: Run idea-explorer (submit + run via Docker)
  const ieResult: IdeaExplorerResult = await runIdeaExplorer(iePath, {
    source: yamlPath,
    provider: config.ideaExplorerProvider || 'claude',
    autoRun: true,
  });

  // Clean up temp file
  try { fs.unlinkSync(yamlPath); } catch { /* ignore */ }

  if (!ieResult.success) {
    return { success: false, error: ieResult.error || 'Idea Explorer run failed' };
  }

  // Step 4: Summarize REPORT.md via LLM for a quality post
  let postTitle = ieResult.title || topic;
  let postAbstract = ieResult.abstract || `Research on: ${topic}`;
  let postTags = ieResult.tags || ['ai', 'research'];
  let postClaims: string[] = ['This paper presents novel research findings.'];
  let postLimitations: string[] = [];
  let postTldr = `Research on ${topic}`;
  let postHypothesis = `This work investigates a novel approach to ${topic}`;
  let postExperimentPlan = '';
  let postConclusion = 'Results demonstrate the validity of the proposed approach';

  // Fetch sciencesubs for tag selection
  const client = getAgent4ScienceClient();
  let sciencesubs: { slug: string; name: string; description: string }[] = [];
  try {
    sciencesubs = await client.getCachedSciencesubs(config.apiKey);
  } catch {
    logger.debug('Failed to fetch sciencesubs for idea-explorer post tags');
  }

  // If abstract is the full REPORT.md (long), use LLM to summarize
  if (postAbstract.length > 500) {
    logger.info('Summarizing research report via LLM for Agent4Science post');
    const summary = await summarizeReportForPost(
      postAbstract,
      config.llmApiKey,
      config.llmModel,
      sciencesubs,
    );
    if (summary) {
      postTitle = summary.title || postTitle;
      postAbstract = summary.abstract;
      postTldr = summary.tldr || postTldr;
      postHypothesis = summary.hypothesis || postHypothesis;
      postExperimentPlan = summary.experimentPlan || postExperimentPlan;
      postConclusion = summary.conclusion || postConclusion;
      if (summary.tags.length > 0) postTags = summary.tags;
      if (summary.claims.length > 0) postClaims = summary.claims;
      if (summary.limitations.length > 0) postLimitations = summary.limitations;
    }
  }

  // Ensure tldr is present (required by API, min 10 chars)
  if (!postTldr || postTldr.length < 10) {
    postTldr = postTitle.length >= 10 ? postTitle : `Research on ${topic}`;
  }

  // Ensure required URLs are present
  const githubUrl = ieResult.githubUrl || '';
  const pdfUrl = ieResult.pdfUrl || (githubUrl ? `${githubUrl}/blob/main/paper_draft/main.pdf` : '');

  if (!githubUrl.startsWith('https://') || !pdfUrl.startsWith('https://')) {
    return {
      success: false,
      title: postTitle,
      githubUrl,
      error: `Research completed but missing required URLs. githubUrl=${githubUrl}, pdfUrl=${pdfUrl}`,
    };
  }

  // Ensure first tag is a valid sciencesub slug
  if (sciencesubs.length > 0) {
    postTags = ensureFirstTagIsSciencesub(postTags, sciencesubs);
  }

  // Step 5: Post to Agent4Science
  const postResult = await client.createPaper({
    title: postTitle,
    abstract: postAbstract,
    tldr: postTldr,
    hypothesis: postHypothesis || undefined,
    experimentPlan: postExperimentPlan || undefined,
    conclusion: postConclusion || undefined,
    tags: postTags,
    claims: postClaims,
    limitations: postLimitations,
    githubUrl,
    pdfUrl,
  }, config.apiKey);

  if (!postResult.success) {
    return {
      success: false,
      title: postTitle,
      githubUrl: ieResult.githubUrl,
      error: `Research completed but Agent4Science posting failed: ${postResult.error}`,
    };
  }

  return {
    success: true,
    agent4sciencePaperId: postResult.data?.id,
    title: postTitle,
    githubUrl: ieResult.githubUrl,
  };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Check if an agent is due for paper generation and run it if so.
 * Called by the event loop on each tick for idea-explorer agents.
 */
export async function tickPaperGeneration(config: ManagerAgentConfig): Promise<PaperGenerationResult | null> {
  if (config.capability !== 'idea-explorer') return null;

  const db = getDatabase();
  const genConfig = db.getPaperGenerationConfig(config.agentId);

  // Check if it's time to generate
  if (genConfig.lastGenerationTime) {
    const elapsed = Date.now() - genConfig.lastGenerationTime.getTime();
    if (elapsed < genConfig.intervalMs) {
      return null; // Not yet time
    }
  }

  // Check prerequisite: agent must have at least 5 sciencesub memberships
  // (Agent4Science requires this before agents can publish papers)
  const membershipCount = db.getMembershipCount(config.agentId);
  if (membershipCount < 5) {
    logger.debug({
      agentId: config.agentId,
      membershipCount,
    }, 'Skipping paper generation — agent needs at least 5 sciencesub memberships');
    return null;
  }

  logger.info({
    agentId: config.agentId,
    capability: config.capability,
  }, 'Paper generation triggered');

  let result: PaperGenerationResult;

  try {
    result = await runIdeaExplorerFlow(config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg, agentId: config.agentId }, 'Paper generation failed');
    result = { success: false, error: msg };
  }

  // Record the generation attempt (even if failed, to avoid rapid retries)
  db.recordPaperGeneration(config.agentId);

  if (result.success) {
    logger.info({
      agentId: config.agentId,
      title: result.title,
      paperId: result.agent4sciencePaperId,
    }, 'Paper published to Agent4Science');

    // Log to audit
    db.logAction(config.agentId, 'paper', result.agent4sciencePaperId || null, 'paper', true, undefined, {
      title: result.title,
      githubUrl: result.githubUrl,
    });
  } else {
    logger.warn({
      agentId: config.agentId,
      error: result.error,
    }, 'Paper generation attempt failed');

    db.logAction(config.agentId, 'paper', null, 'paper', false, result.error);
  }

  return result;
}
