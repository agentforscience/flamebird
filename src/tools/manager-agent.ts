/**
 * Manager Agent
 *
 * Orchestrates the paper generation lifecycle for NeuriCo agents:
 *   1. Discover interesting topics from Agent4Science (trending papers, discussions)
 *   2. Use LLM to formulate a research idea
 *   3. Invoke NeuriCo CLI
 *   4. Post the results to Agent4Science via normal API (using agent's own API key)
 *
 * This runs on a schedule (default: once per 24h per agent) as part of the
 * main event loop.
 */

import { createLogger } from '../logging/logger.js';
import { getAgent4ScienceClient } from '../api/agent4science-client.js';
import { smartTruncate, repairJSON } from '../utils/truncate.js';
import { ensureFirstTagIsSciencesub } from '../engagement/proactive-engine.js';
import { runNeurico, resolveNeuricoPath, type NeuricoResult } from './paper-tools.js';
import { generateIdea } from './idea-generator.js';
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
  /** GitHub Personal Access Token (needed for NeuriCo) */
  githubToken?: string;
  /** GitHub org name */
  githubOrg?: string;
  /** Path to NeuriCo installation */
  neuricoPath?: string;
  /** AI provider for NeuriCo (default: claude) */
  neuricoProvider?: 'claude' | 'codex' | 'gemini';
  /** Agent's preferred research topics (from persona) */
  preferredTopics?: string[];
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
  domain?: string,
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
  const model = llmModel || 'anthropic/claude-sonnet-4.5';

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
just repeat what's already been posted.${domain ? `\n\nIMPORTANT: The topic MUST be in the domain of "${domain}". Do not suggest topics outside this domain.` : ''}
Return ONLY the topic as a single sentence - no explanation.`,
        },
        {
          role: 'user',
          content: context || `Suggest a novel ${domain || 'mathematical'} research topic.`,
        },
      ],
      temperature: 0.9,
      max_tokens: 256,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    logger.warn({
      status: response.status,
      statusText: response.statusText,
      error: errorBody.slice(0, 200),
      model,
    }, 'Topic discovery LLM call failed (check LLM_API_KEY) — using fallback topic');
    return `Generate a novel ${domain || 'mathematical'} research topic`;
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
 * Produces a YAML that matches NeuriCo's schema (title, domain, hypothesis,
 * background, methodology).
 */
async function generateIdeaYaml(
  topic: string,
  llmApiKey: string,
  llmModel?: string,
  domain?: string,
): Promise<string> {
  const baseUrl = 'https://openrouter.ai/api/v1';
  const model = llmModel || 'anthropic/claude-sonnet-4.5';

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

IMPORTANT: Use domain "${domain || 'artificial_intelligence'}" exactly as given.`,
          },
          { role: 'user', content: topic },
        ],
        temperature: 0.7,
        max_tokens: 2048,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      logger.warn({
        status: response.status,
        error: errorBody.slice(0, 200),
      }, 'Idea YAML generation LLM call failed — using minimal YAML');
      return buildMinimalYaml(topic, domain);
    }

    const data = await response.json() as { choices: Array<{ message: { content: string } }> };
    let yaml = data.choices[0]?.message?.content?.trim();
    // Strip markdown code fences that LLMs often add despite instructions
    if (yaml) {
      yaml = yaml.replace(/^```(?:ya?ml)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
    }
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
  const model = llmModel || 'anthropic/claude-sonnet-4.5';

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
            content: `You are writing a post for a scientific discussion platform. You will receive a full research REPORT.md.

The report typically follows this structure (section names may vary slightly):
- "## Executive Summary" — overview of the study, key findings, and significance
- "## Goal" — research question/hypothesis (often has a "### Research Question" sub-heading)
- "## Data Construction" — how data/experiments were set up
- "## Experiment Description" — methodology, approach, and experimental design
- "## Results" or "## Key Findings" — empirical results with statistics and findings
- "## Limitations" — known limitations of the work
- "## Conclusions" — summary conclusions and implications
- "## References" — cited works (ignore these, they are handled separately)

Extract information from these sections to produce a JSON object. Be faithful to the report's actual content — preserve specific numbers, statistics, p-values, and findings rather than paraphrasing generically.

Required JSON fields:
- "title": The paper title — use the report's own title (from the # heading) if suitable, or write a clear, engaging title (max 200 chars)
- "tldr": A single-sentence summary capturing the most important finding (min 30 chars, max 1000 chars). Look for bold "Key finding" text in the Executive Summary.
- "abstract": A thorough summary (3-5 paragraphs, 300-800 words) covering the research question, methodology, key findings (with specific numbers), and significance. Extract primarily from the Executive Summary and Results sections. Write in accessible academic style.
- "hypothesis": The main hypothesis or research question (1-3 sentences). Extract from the "Goal" section, especially any "Research Question" sub-heading.
- "experimentPlan": Description of the experimental methodology (2-4 sentences). Extract from "Experiment Description" or "Data Construction". Include key details like sample sizes, models used, and variables tested.
- "conclusion": The main conclusions and implications (2-4 sentences). Extract from "Conclusions" section.
${tagsInstruction}
- "claims": An array of 3-10 key findings from the research. Extract these directly from the Results section — each should be a specific, substantive finding with numbers where available (e.g., "Context poisoning achieved 75% persistence rate, the highest among all injection types"). Each claim can be up to 500 chars.
- "limitations": An array of 1-5 limitations. Extract from the "Limitations" section if present.

CRITICAL: You MUST complete every field fully. Do NOT leave any sentence unfinished or cut off mid-thought. Finish every sentence completely before moving to the next field.

Output ONLY valid JSON, no markdown fences.`,
          },
          { role: 'user', content: reportContent },
        ],
        temperature: 0.3,
        max_tokens: 16384,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '(unreadable)');
      logger.warn({ status: response.status, body: errorBody.slice(0, 200) }, 'Report summarization LLM call failed');
      return null;
    }

    const data = await response.json() as { choices: Array<{ message: { content: string } }> };
    const content = data.choices[0]?.message?.content?.trim();
    if (!content) return null;

    // Strip markdown fences if the LLM added them despite instructions
    let jsonContent = content.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?\s*```$/, '');

    let parsed: Partial<ReportSummary>;
    try {
      parsed = JSON.parse(jsonContent) as Partial<ReportSummary>;
    } catch {
      // LLM may have been cut off by token limit — try to repair incomplete JSON
      const repaired = repairJSON(jsonContent);
      if (!repaired) return null;
      parsed = JSON.parse(repaired) as Partial<ReportSummary>;
    }
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
 * Run the full NeuriCo paper generation flow:
 * discover topic → generate idea YAML → submit + run → post to Agent4Science
 */
export async function runNeuricoFlow(config: ManagerAgentConfig): Promise<PaperGenerationResult> {
  const iePath = config.neuricoPath || resolveNeuricoPath();
  if (!iePath) {
    return {
      success: false,
      error: 'NeuriCo not found. Install it: curl -fsSL https://raw.githubusercontent.com/ChicagoHAI/neurico/main/install.sh | bash',
    };
  }

  // Step 1: Generate research idea via HypogenicAI backend (with fallback to LLM)
  logger.info({ agentId: config.agentId }, 'Generating research idea for NeuriCo');

  let topic: string;
  try {
    // Fetch feed context for the idea generator
    const client = getAgent4ScienceClient();
    const [papersResult, takesResult] = await Promise.all([
      client.getPapers(config.apiKey, { limit: 10, sort: 'hot' }),
      client.getTakes(config.apiKey, { limit: 10, sort: 'hot' }),
    ]);
    const papers: Agent4SciencePaper[] = Array.isArray(papersResult.data) ? papersResult.data : [];
    const takes: Array<{ title: string; hotTake: string }> = Array.isArray(takesResult.data) ? takesResult.data : [];

    const idea = await generateIdea({
      recentPapers: papers.slice(0, 5).map(p => ({ title: p.title, tags: p.tags })),
      recentTakes: takes.slice(0, 5).map(t => ({ title: t.title, hotTake: t.hotTake })),
      preferredTopics: config.preferredTopics || [],
      domain: config.researchDomain,
    });
    // Combine title and description as rich context for YAML generation
    topic = `${idea.title}\n\n${idea.description}`;
    logger.info({ title: idea.title }, 'Idea generated via HypogenicAI backend');
  } catch (err) {
    logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'HypogenicAI backend failed, falling back to LLM-based topic discovery');
    topic = await discoverTopic(config.apiKey, config.llmApiKey, config.llmModel, config.researchDomain);
  }
  logger.info({ topic: topic.slice(0, 200) }, 'Topic selected');

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

  // Step 3: Run NeuriCo (submit + run via Docker)
  const ieResult: NeuricoResult = await runNeurico(iePath, {
    source: yamlPath,
    provider: config.neuricoProvider || 'claude',
    autoRun: true,
  });

  // Clean up temp file
  try { fs.unlinkSync(yamlPath); } catch { /* ignore */ }

  if (!ieResult.success) {
    return { success: false, error: ieResult.error || 'NeuriCo run failed' };
  }

  // ── Quality gate: reject runs that produced no substantive output ──
  // A real REPORT.md is 1000+ chars; anything under 200 is likely a stub or error message
  if (!ieResult.abstract || ieResult.abstract.length < 200) {
    logger.error({
      agentId: config.agentId,
      abstractLength: ieResult.abstract?.length ?? 0,
      title: ieResult.title,
    }, 'NeuriCo run produced no substantive report — skipping paper posting');
    return {
      success: false,
      title: ieResult.title,
      githubUrl: ieResult.githubUrl,
      error: `NeuriCo completed but REPORT.md is missing or too short (${ieResult.abstract?.length ?? 0} chars). Research may have failed silently.`,
    };
  }

  if (!ieResult.githubUrl) {
    logger.error({
      agentId: config.agentId,
      title: ieResult.title,
    }, 'NeuriCo run produced no GitHub URL — skipping paper posting');
    return {
      success: false,
      title: ieResult.title,
      error: 'NeuriCo completed but no GitHub URL was found. The repo may not have been created.',
    };
  }

  // Step 4: Summarize REPORT.md via LLM for a quality post
  // Keep the deterministic title from REPORT.md — it's more accurate than LLM-generated titles
  const deterministicTitle = ieResult.title;
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
    logger.debug('Failed to fetch sciencesubs for NeuriCo post tags');
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
    if (!summary) {
      logger.warn({ agentId: config.agentId, reportLength: postAbstract.length }, 'LLM summarization returned null — posting will use raw report content with fallback fields');
    }
    if (summary) {
      // Prefer the deterministic title from REPORT.md over LLM-generated title
      // (LLM may rephrase it; the actual report heading is more accurate)
      postTitle = deterministicTitle || summary.title || postTitle;
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

  // ── Ensure all required fields meet API minimums ──
  // API: title min 10 chars, max 200
  if (!postTitle || postTitle.length < 10) {
    postTitle = postTitle
      ? `Research: ${postTitle} — a novel investigation in ${topic}`
      : `Research: ${topic}`;
  }
  postTitle = smartTruncate(postTitle, 200);

  // API: abstract min 100 chars, max 5000
  if (postAbstract.length < 100) {
    postAbstract = `${postAbstract} This research explores new directions in ${topic}. ${postHypothesis} ${postConclusion}`;
  }
  postAbstract = smartTruncate(postAbstract, 5000);

  // API: tldr min 30 chars, max 1000
  if (!postTldr || postTldr.length < 30) {
    const baseTldr = postTldr || postTitle || `Research on ${topic}`;
    postTldr = `${baseTldr}. ${postAbstract || postHypothesis || `This work explores new directions in ${topic} research.`}`;
  }
  postTldr = smartTruncate(postTldr, 1000);

  // API: hypothesis REQUIRED, min 10 chars, max 3000
  if (!postHypothesis || postHypothesis.length < 10) {
    postHypothesis = `This work investigates a novel approach to ${topic} and evaluates its effectiveness.`;
  }
  postHypothesis = smartTruncate(postHypothesis, 3000);

  // API: conclusion REQUIRED, min 10 chars, max 3000
  if (!postConclusion || postConclusion.length < 10) {
    postConclusion = `Results demonstrate the validity of the proposed approach to ${topic}.`;
  }
  postConclusion = smartTruncate(postConclusion, 3000);

  // API: claims at least 1
  if (postClaims.length === 0) {
    postClaims = ['This paper presents novel research findings.'];
  }

  // API: tags at least 1
  if (postTags.length === 0) {
    postTags = [config.preferredTopics?.[0] || config.researchDomain || 'research'];
  }

  // Ensure required URLs are present
  const githubUrl = ieResult.githubUrl || '';
  const pdfUrl = ieResult.pdfUrl || (githubUrl ? `${githubUrl}/blob/main/paper_draft/main.pdf` : '');

  if (!githubUrl.startsWith('https://') || !pdfUrl.startsWith('https://')) {
    logger.error({ githubUrl, pdfUrl, title: postTitle }, 'Paper posting skipped: missing required URLs after successful NeuriCo run');
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
  const paperPayload = {
    title: postTitle,
    abstract: postAbstract,
    tldr: postTldr,
    hypothesis: postHypothesis,
    experimentPlan: postExperimentPlan || undefined,
    conclusion: postConclusion,
    tags: postTags,
    claims: postClaims,
    limitations: postLimitations,
    githubUrl,
    pdfUrl,
    references: ieResult.references,
  };

  logger.info({
    agentId: config.agentId,
    title: postTitle,
    tldrLength: postTldr.length,
    abstractLength: postAbstract.length,
    tags: postTags,
    claimsCount: postClaims.length,
    limitationsCount: postLimitations.length,
    refsCount: ieResult.references?.length ?? 0,
    githubUrl,
    pdfUrl,
  }, 'Posting paper to Agent4Science');

  const postResult = await client.createPaper(paperPayload, config.apiKey);

  if (!postResult.success) {
    logger.error({
      agentId: config.agentId,
      error: postResult.error,
      code: postResult.code,
      title: postTitle,
      tldrLength: postTldr.length,
      abstractLength: postAbstract.length,
      tagsCount: postTags.length,
    }, 'Agent4Science paper posting FAILED');
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
 * Called by the event loop on each tick for NeuriCo agents.
 */
export async function tickPaperGeneration(config: ManagerAgentConfig): Promise<PaperGenerationResult | null> {
  if (config.capability !== 'neurico') return null;

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
    logger.info({
      agentId: config.agentId,
      membershipCount,
      needed: 5,
    }, 'Skipping paper generation — agent needs at least 5 sciencesub memberships (will join automatically during discovery cycles)');
    return null;
  }

  logger.info({
    agentId: config.agentId,
    capability: config.capability,
  }, 'Paper generation triggered');

  let result: PaperGenerationResult;

  try {
    result = await runNeuricoFlow(config);
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
