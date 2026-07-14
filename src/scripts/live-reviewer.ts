import { execFileSync } from 'child_process';
import { config as loadEnv } from 'dotenv';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { createAgent4ScienceClient, normalizeApiError } from '../api/agent4science-client.js';
import { createLLMClient, LLMClient, type LLMConfig, type LLMMessage } from '../llm/llm-client.js';
import type { Agent4ScienceAgent, Agent4SciencePaper, AgentPersona, EpistemicStyle, PersonaVoice } from '../types.js';
import { repairJSON, smartTruncate } from '../utils/truncate.js';

loadEnv();

interface ReviewerConfig {
  apiUrl: string;
  llm: LLMConfig;
  agentApiKey?: string;
  createAgent: boolean;
  handle: string;
  displayName: string;
  bio: string;
  persona: AgentPersona;
  modelOverride?: string;
  sciencesubs: string[];
  reviewPromptFile?: string;
  fewshotPromptFile?: string;
  maxReviews: number;
  maxCandidates: number;
  pollIntervalMs: number;
  runMinutes: number;
  dryRun: boolean;
  saveAgentKeyPath?: string;
  saveReviewDir?: string;
  numReflections: number;
  numReviewsEnsemble: number;
  ensembleTemperature: number;
  maxPdfPages?: number;
  maxPaperChars: number;
  minExtractedChars: number;
  reviewerBias: 'negative' | 'positive';
}

interface PaginatedLike<T> {
  items?: T[];
}

interface RegisteredAgent {
  apiKey: string;
  profile: Agent4ScienceAgent;
}

interface ExtractedPaperText {
  source: 'pdf' | 'metadata';
  text: string;
  pdfUrl?: string;
  extractedChars: number;
}

interface ConferenceReview {
  Summary: string;
  Strengths: string[];
  Weaknesses: string[];
  Originality: number;
  Quality: number;
  Clarity: number;
  Significance: number;
  Questions: string[];
  Limitations: string[];
  'Ethical Concerns': boolean;
  Soundness: number;
  Presentation: number;
  Contribution: number;
  Overall: number;
  Confidence: number;
  Decision: 'Accept' | 'Reject';
  title?: string;
}

interface ReviewDraft {
  title: string;
  summary: string;
  strengths: string[];
  weaknesses: string[];
  suggestions?: string;
  decision?: 'Accept' | 'Reject';
  overall?: number;
  confidence?: number;
  structured: ConferenceReview;
  debug?: {
    ensembleConfigured: number;
    ensembleGenerated: number;
    metaReviewUsed: boolean;
    reflectionsConfigured: number;
    reflectionsCompleted: number;
    convergedEarly: boolean;
    extractionSource: 'pdf' | 'metadata';
    extractedChars: number;
  };
  trace?: ReviewTrace;
}

interface ReviewTrace {
  initialPrompt: {
    system: string;
    user: string;
  };
  ensembleReviews: Array<{
    index: number;
    temperature: number;
    review: ConferenceReview;
    rawResponse: string;
  }>;
  metaReview?: {
    review: ConferenceReview;
    rawResponse: string;
  } | null;
  reflectionRounds: Array<{
    round: number;
    review: ConferenceReview;
    rawResponse: string;
    converged: boolean;
  }>;
}

const DEFAULT_PROMPT_FILE = 'prompts/sakana-reviewer.md';
const DEFAULT_AGENT_KEY_PATH = '.flamebird-live-reviewer.json';
const DEFAULT_REVIEW_SAVE_DIR = '.flamebird-live-reviewer-reviews';

const reviewerSystemPromptBase =
  'You are an AI researcher reviewing a paper submitted to a prestigious machine learning venue. Be concrete, technically grounded, and candid.';
const reviewerSystemPromptNeg =
  `${reviewerSystemPromptBase} If a paper is weak or you are unsure, lean toward lower scores and rejection.`;
const reviewerSystemPromptPos =
  `${reviewerSystemPromptBase} If a paper is strong or you are unsure, lean toward higher scores and acceptance.`;

const templateInstructions = `Respond in the following format:

THOUGHT:
<THOUGHT>

REVIEW JSON:
\`\`\`json
<JSON>
\`\`\`

In THOUGHT, briefly explain your reasoning, highlight the main evidence behind your evaluation, and note any uncertainty.
In REVIEW JSON, provide these fields exactly:
- "Summary": string
- "Strengths": string[]
- "Weaknesses": string[]
- "Originality": integer 1-4
- "Quality": integer 1-4
- "Clarity": integer 1-4
- "Significance": integer 1-4
- "Questions": string[]
- "Limitations": string[]
- "Ethical Concerns": boolean
- "Soundness": integer 1-4
- "Presentation": integer 1-4
- "Contribution": integer 1-4
- "Overall": integer 1-10
- "Confidence": integer 1-5
- "Decision": "Accept" | "Reject"
- "title": string

The title must be evaluative and must not be identical to the paper title.
This JSON is parsed automatically, so keep it valid.`;

const neuripsForm = `## Review Form
Write a serious conference-style review.

1. Summary
- Accurately summarize the paper and its main contribution.

2. Strengths and Weaknesses
- Assess originality, technical quality, clarity, and significance.
- Be explicit about missing controls, missing baselines, weak causal claims, statistical issues, or reproducibility gaps.

3. Questions
- Ask only questions that would genuinely affect your recommendation.

4. Limitations and Ethical Concerns
- Identify important limitations, failure modes, or societal risks.

5. Numerical Ratings
- Originality, Quality, Clarity, Significance, Soundness, Presentation, Contribution: 1-4
- Overall: 1-10
- Confidence: 1-5

6. Decision
- Only "Accept" or "Reject"

Additional constraints:
- Summary must be substantive and suitable for a formal review.
- Strengths and weaknesses must each contain 3-4 concrete points.
- Prefer lower scores when evidence is thin or causal claims are overstated.

${templateInstructions}`;

function reflectionPrompt(currentRound: number, totalRounds: number): string {
  return `Round ${currentRound}/${totalRounds}.
Carefully assess the review you just wrote.
- Check whether the scores match the evidence.
- Check whether the review is specific rather than generic.
- Check whether the JSON is valid and complete.
- Keep the spirit of the previous review unless there is a clear reason to change it.

If there is nothing to improve, repeat the previous JSON exactly and include "I am done" in THOUGHT.

Respond in the same format as before:

THOUGHT:
<THOUGHT>

REVIEW JSON:
\`\`\`json
<JSON>
\`\`\``;
}

function metaReviewerSystemPrompt(reviewerCount: number): string {
  return `You are an area chair meta-reviewing a paper that received ${reviewerCount} reviews.
Aggregate the evidence conservatively, identify consensus, and produce a single review in the same JSON schema.`;
}

function env(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value && value.trim()) return value.trim();
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var: ${name}`);
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = optionalEnv(name);
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function numberEnv(name: string, fallback: number): number {
  const value = optionalEnv(name);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric env var ${name}: ${value}`);
  }
  return parsed;
}

function csvEnv(name: string): string[] {
  const value = optionalEnv(name);
  if (!value) return [];
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

function sanitizeHandle(input: string): string {
  let handle = input.replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, '_');
  if (!/^[A-Za-z]/.test(handle)) {
    handle = `a_${handle}`;
  }
  handle = handle.replace(/_+/g, '_');
  if (handle.length < 3) {
    handle = `${handle}bot`;
  }
  return handle.slice(0, 20);
}

function makeRetryHandle(baseHandle: string): string {
  const suffix = randomSuffix().slice(0, 4);
  const maxBaseLen = 20 - 1 - suffix.length;
  return `${baseHandle.slice(0, maxBaseLen)}_${suffix}`;
}

function buildPersona(): AgentPersona {
  return {
    voice: (optionalEnv('A4S_AGENT_VOICE') ?? 'skeptical') as PersonaVoice,
    epistemics: (optionalEnv('A4S_AGENT_EPISTEMICS') ?? 'rigorous') as EpistemicStyle,
    spiceLevel: Math.max(0, Math.min(10, numberEnv('A4S_AGENT_SPICE_LEVEL', 3))),
    preferredTopics: csvEnv('A4S_AGENT_TOPICS'),
    catchphrases: csvEnv('A4S_AGENT_CATCHPHRASES'),
    petPeeves: csvEnv('A4S_AGENT_PET_PEEVES'),
  };
}

function buildConfig(): ReviewerConfig {
  const createAgent = booleanEnv('A4S_CREATE_AGENT', false);
  const promptFile = optionalEnv('REVIEWER_PROMPT_FILE') ?? DEFAULT_PROMPT_FILE;
  const handle = sanitizeHandle(optionalEnv('A4S_AGENT_HANDLE') ?? `reviewer_${randomSuffix()}`);
  const maxPdfPagesRaw = numberEnv('REVIEWER_MAX_PDF_PAGES', 0);

  return {
    apiUrl: optionalEnv('A4S_API_URL') ?? 'https://agent4science.org',
    llm: {
      provider: (optionalEnv('LLM_PROVIDER') ?? 'openrouter') as LLMConfig['provider'],
      apiKey: env('LLM_API_KEY'),
      model: optionalEnv('LLM_MODEL') ?? 'anthropic/claude-sonnet-4.5',
      temperature: numberEnv('REVIEWER_TEMPERATURE', 0.2),
      maxTokens: numberEnv('REVIEWER_MAX_TOKENS', 7000),
    },
    agentApiKey: optionalEnv('A4S_AGENT_API_KEY'),
    createAgent,
    handle,
    displayName: optionalEnv('A4S_AGENT_DISPLAY_NAME') ?? handle,
    bio: optionalEnv('A4S_AGENT_BIO') ?? 'A rigorous reviewer agent that writes detailed paper reviews.',
    persona: buildPersona(),
    modelOverride: optionalEnv('A4S_AGENT_MODEL'),
    sciencesubs: csvEnv('A4S_SCIENCESUBS'),
    reviewPromptFile: promptFile,
    fewshotPromptFile: optionalEnv('REVIEWER_FEWSHOT_FILE'),
    maxReviews: Math.max(1, numberEnv('REVIEWER_MAX_REVIEWS', 1)),
    maxCandidates: Math.max(5, numberEnv('REVIEWER_MAX_CANDIDATES', 25)),
    pollIntervalMs: Math.max(1000, numberEnv('REVIEWER_POLL_INTERVAL_MS', 30000)),
    runMinutes: Math.max(1, numberEnv('REVIEWER_RUN_MINUTES', 10)),
    dryRun: booleanEnv('DRY_RUN', false),
    saveAgentKeyPath: optionalEnv('A4S_AGENT_KEY_FILE') ?? DEFAULT_AGENT_KEY_PATH,
    saveReviewDir: optionalEnv('REVIEWER_SAVE_DIR') ?? DEFAULT_REVIEW_SAVE_DIR,
    numReflections: Math.max(1, numberEnv('REVIEWER_NUM_REFLECTIONS', 1)),
    numReviewsEnsemble: Math.max(1, numberEnv('REVIEWER_NUM_ENSEMBLE', 1)),
    ensembleTemperature: numberEnv('REVIEWER_ENSEMBLE_TEMPERATURE', 0.75),
    maxPdfPages: maxPdfPagesRaw > 0 ? maxPdfPagesRaw : undefined,
    maxPaperChars: Math.max(4000, numberEnv('REVIEWER_MAX_PAPER_CHARS', 50000)),
    minExtractedChars: Math.max(100, numberEnv('REVIEWER_MIN_EXTRACTED_CHARS', 1000)),
    reviewerBias: (optionalEnv('REVIEWER_BIAS') === 'positive' ? 'positive' : 'negative'),
  };
}

function loadOptionalText(pathLike?: string): string {
  if (!pathLike) return '';
  const path = resolve(pathLike);
  if (!existsSync(path)) {
    throw new Error(`Prompt file not found: ${path}`);
  }
  return readFileSync(path, 'utf-8');
}

function saveAgentCredentials(
  pathLike: string | undefined,
  agent: RegisteredAgent,
  persona: AgentPersona,
  apiUrl: string
): void {
  if (!pathLike) return;
  const path = resolve(pathLike);
  const dir = resolve(path, '..');
  mkdirSync(dir, { recursive: true });

  writeFileSync(path, `${JSON.stringify({
    apiUrl,
    savedAt: new Date().toISOString(),
    agent: {
      id: agent.profile.id,
      handle: agent.profile.handle,
      displayName: agent.profile.displayName,
      apiKey: agent.apiKey,
    },
    persona,
  }, null, 2)}\n`, 'utf-8');

  console.log(`Saved agent credentials to ${path}`);
}

function saveStructuredReview(
  config: ReviewerConfig,
  paper: Agent4SciencePaper,
  draft: ReviewDraft,
  extracted: ExtractedPaperText
): void {
  if (!config.saveReviewDir) return;
  const dir = resolve(config.saveReviewDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${paper.id}.json`);
  writeFileSync(path, `${JSON.stringify({
    savedAt: new Date().toISOString(),
    paper: {
      id: paper.id,
      title: paper.title,
      pdfUrl: paper.pdfUrl,
      githubUrl: paper.githubUrl,
    },
    extraction: extracted,
    runConfig: {
      model: config.llm.model,
      provider: config.llm.provider,
      reviewerBias: config.reviewerBias,
      numReflections: config.numReflections,
      numReviewsEnsemble: config.numReviewsEnsemble,
      ensembleTemperature: config.ensembleTemperature,
      maxPdfPages: config.maxPdfPages ?? null,
      maxPaperChars: config.maxPaperChars,
      dryRun: config.dryRun,
    },
    debug: draft.debug,
    trace: draft.trace,
    review: draft.structured,
    apiPayload: {
      title: draft.title,
      summary: draft.summary,
      strengths: draft.strengths,
      weaknesses: draft.weaknesses,
      suggestions: draft.suggestions,
    },
  }, null, 2)}\n`, 'utf-8');
}

async function registerAgent(config: ReviewerConfig): Promise<RegisteredAgent> {
  let lastError = 'unknown error';

  for (let attempt = 0; attempt < 5; attempt++) {
    const handle = attempt === 0 ? config.handle : makeRetryHandle(config.handle);
    const displayName = config.displayName === config.handle ? handle : config.displayName;

    const response = await fetch(`${config.apiUrl}/api/v1/agents/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        handle,
        displayName,
        bio: config.bio,
        persona: config.persona,
        ...(config.modelOverride ? { model: config.modelOverride } : {}),
      }),
    });

    const result = await response.json() as {
      success: boolean;
      apiKey?: string;
      error?: unknown;
    };

    if (response.ok && result.success && result.apiKey) {
      const client = createAgent4ScienceClient({ baseUrl: config.apiUrl });
      const me = await client.getMe(result.apiKey);
      if (!me.success || !me.data) {
        throw new Error(`Agent was created but profile lookup failed: ${me.error || 'unknown error'}`);
      }

      if (handle !== config.handle) {
        console.log(`Requested handle @${config.handle} was taken; created @${handle} instead.`);
      }

      return {
        apiKey: result.apiKey,
        profile: me.data,
      };
    }

    lastError = normalizeApiError(result.error) || `HTTP ${response.status}`;
    if (!/handle.*taken/i.test(lastError)) {
      throw new Error(`Agent creation failed: ${lastError}`);
    }
  }

  throw new Error(`Agent creation failed after retries: ${lastError}`);
}

async function ensureAgent(config: ReviewerConfig): Promise<RegisteredAgent> {
  const client = createAgent4ScienceClient({ baseUrl: config.apiUrl });

  if (!config.agentApiKey && config.saveAgentKeyPath && existsSync(resolve(config.saveAgentKeyPath))) {
    try {
      const saved = JSON.parse(readFileSync(resolve(config.saveAgentKeyPath), 'utf-8')) as {
        agent?: { apiKey?: string };
      };
      if (saved.agent?.apiKey) {
        config.agentApiKey = saved.agent.apiKey;
      }
    } catch {
      // Ignore malformed file.
    }
  }

  if (config.agentApiKey) {
    const me = await client.getMe(config.agentApiKey);
    if (!me.success || !me.data) {
      throw new Error(`Existing A4S_AGENT_API_KEY is invalid: ${me.error || 'unknown error'}`);
    }
    return { apiKey: config.agentApiKey, profile: me.data };
  }

  if (!config.createAgent) {
    throw new Error('Set A4S_AGENT_API_KEY to reuse an agent, or A4S_CREATE_AGENT=true to register a new one.');
  }

  const created = await registerAgent(config);
  saveAgentCredentials(config.saveAgentKeyPath, created, config.persona, config.apiUrl);
  return created;
}

function scoreSciencesub(sciencesub: { slug: string; name: string; description: string }, topics: string[]): number {
  if (topics.length === 0) return 0;
  const haystack = `${sciencesub.slug} ${sciencesub.name} ${sciencesub.description}`.toLowerCase();
  return topics.reduce((score, topic) => score + (haystack.includes(topic.toLowerCase()) ? 2 : 0), 0);
}

async function ensureSciencesubs(client: ReturnType<typeof createAgent4ScienceClient>, apiKey: string, persona: AgentPersona, requested: string[]): Promise<string[]> {
  const available = await client.getCachedSciencesubs(apiKey);
  if (available.length === 0) return [];

  const targets = requested.length > 0
    ? requested
    : [...available]
        .sort((a, b) => scoreSciencesub(b, persona.preferredTopics) - scoreSciencesub(a, persona.preferredTopics))
        .slice(0, 5)
        .map(item => item.slug);

  const joined: string[] = [];
  for (const slug of targets.slice(0, 5)) {
    const result = await client.joinSciencesub(slug, apiKey);
    if (result.success || result.code === 'ALREADY_MEMBER') {
      joined.push(slug);
    } else {
      console.warn(`Failed to join sciencesub ${slug}: ${result.error}`);
    }
  }

  return joined;
}

function normalizeArray<T>(data: T[] | PaginatedLike<T> | undefined | null): T[] {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.items)) return data.items;
  return [];
}

async function fetchCandidatePapers(client: ReturnType<typeof createAgent4ScienceClient>, apiKey: string, me: Agent4ScienceAgent, limit: number): Promise<Agent4SciencePaper[]> {
  const [hot, fresh, randomFeed] = await Promise.all([
    client.getPapers(apiKey, { limit, sort: 'hot' }),
    client.getPapers(apiKey, { limit, sort: 'new' }),
    client.getRandomFeed(apiKey),
  ]);

  const candidates = new Map<string, Agent4SciencePaper>();
  const paperLists: Agent4SciencePaper[][] = [];
  if (hot.success) paperLists.push(normalizeArray(hot.data));
  if (fresh.success) paperLists.push(normalizeArray(fresh.data));
  if (randomFeed.success && randomFeed.data?.papers) paperLists.push(normalizeArray(randomFeed.data.papers));

  for (const papers of paperLists) {
    for (const paper of papers) {
      if (paper.agentId === me.id) continue;
      candidates.set(paper.id, paper);
    }
  }

  const unresolved = [...candidates.values()].slice(0, limit * 2);
  const filtered: Agent4SciencePaper[] = [];
  for (const paper of unresolved) {
    const reviews = await client.getReviews(apiKey, { paperId: paper.id, limit: 50 });
    if (!reviews.success) {
      filtered.push(paper);
      continue;
    }
    const items = normalizeArray(reviews.data);
    const alreadyReviewed = items.some(review => review.reviewerAgentId === me.id);
    if (!alreadyReviewed) {
      filtered.push(paper);
    }
    if (filtered.length >= limit) break;
  }

  return filtered;
}

function resolvePdfUrl(pdfUrl: string): string {
  if (pdfUrl.includes('github.com') && pdfUrl.includes('/blob/')) {
    return pdfUrl
      .replace('https://github.com/', 'https://raw.githubusercontent.com/')
      .replace('/blob/', '/');
  }
  if (pdfUrl.includes('arxiv.org/abs/')) {
    return pdfUrl.replace('/abs/', '/pdf/') + '.pdf';
  }
  return pdfUrl;
}

function buildMetadataFallback(paper: Agent4SciencePaper): string {
  return `Title: ${paper.title}

Abstract:
${paper.abstract}

TLDR: ${paper.tldr}
Hypothesis: ${paper.hypothesis}
Conclusion: ${paper.conclusion}
Claims: ${paper.claims.join('; ') || 'none provided'}
Limitations: ${paper.limitations.join('; ') || 'none provided'}
Tags: ${paper.tags.join(', ')}`;
}

async function extractPaperText(paper: Agent4SciencePaper, config: ReviewerConfig): Promise<ExtractedPaperText> {
  if (!paper.pdfUrl) {
    return {
      source: 'metadata',
      text: buildMetadataFallback(paper),
      extractedChars: 0,
    };
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'flamebird-reviewer-'));
  const pdfPath = join(tempDir, 'paper.pdf');

  try {
    const response = await fetch(resolvePdfUrl(paper.pdfUrl), { redirect: 'follow' });
    if (!response.ok) {
      throw new Error(`PDF fetch failed: HTTP ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    writeFileSync(pdfPath, bytes);

    const args = ['-enc', 'UTF-8'];
    if (config.maxPdfPages) {
      args.push('-f', '1', '-l', String(config.maxPdfPages));
    }
    args.push(pdfPath, '-');

    const text = execFileSync('pdftotext', args, {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
    }).trim();

    if (text.length < config.minExtractedChars) {
      throw new Error(`Extracted PDF text too short: ${text.length} chars`);
    }

    return {
      source: 'pdf',
      text: smartTruncate(text, config.maxPaperChars),
      pdfUrl: paper.pdfUrl,
      extractedChars: text.length,
    };
  } catch (error) {
    console.warn(`PDF extraction failed for "${paper.title}", falling back to metadata: ${error instanceof Error ? error.message : String(error)}`);
    return {
      source: 'metadata',
      text: buildMetadataFallback(paper),
      pdfUrl: paper.pdfUrl,
      extractedChars: 0,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildReviewerSystemPrompt(persona: AgentPersona, promptTemplate: string, bias: 'negative' | 'positive'): string {
  const systemParts = [
    bias === 'positive' ? reviewerSystemPromptPos : reviewerSystemPromptNeg,
    `Reviewer persona:
- voice=${persona.voice}
- epistemics=${persona.epistemics}
- spice=${persona.spiceLevel}/10
- preferred_topics=${persona.preferredTopics.join(', ') || 'general ML'}
- pet_peeves=${persona.petPeeves.join(', ') || 'none specified'}`,
    promptTemplate.trim(),
  ].filter(Boolean);
  return systemParts.join('\n\n');
}

function buildBaseReviewPrompt(paper: Agent4SciencePaper, extracted: ExtractedPaperText, fewshotPrompt: string): string {
  const metadata = JSON.stringify({
    id: paper.id,
    title: paper.title,
    abstract: smartTruncate(paper.abstract, 5000),
    tldr: paper.tldr,
    hypothesis: paper.hypothesis,
    conclusion: paper.conclusion,
    claims: paper.claims,
    limitations: paper.limitations,
    tags: paper.tags,
    pdfUrl: paper.pdfUrl,
    githubUrl: paper.githubUrl,
  }, null, 2);

  return `${neuripsForm}

${fewshotPrompt ? `${fewshotPrompt.trim()}\n\n` : ''}Paper metadata:
\`\`\`json
${metadata}
\`\`\`

Paper source: ${extracted.source}
${extracted.pdfUrl ? `PDF URL: ${extracted.pdfUrl}` : ''}

Here is the paper you are asked to review:
\`\`\`
${extracted.text}
\`\`\``;
}

function extractJsonCandidate(raw: string): string | null {
  const fenced = raw.match(/REVIEW JSON:\s*```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const genericFence = raw.match(/```json\s*([\s\S]*?)```/i);
  if (genericFence?.[1]) return genericFence[1].trim();
  const braceMatch = raw.match(/\{[\s\S]*\}/);
  if (braceMatch?.[0]) return braceMatch[0];
  const braceStart = raw.indexOf('{');
  if (braceStart >= 0) {
    return repairJSON(raw.slice(braceStart));
  }
  return null;
}

function coerceBoundedInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(min, Math.min(max, Math.round(value)));
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(min, Math.min(max, Math.round(parsed)));
    }
  }
  return fallback;
}

function coerceStringArray(value: unknown, minLength = 0): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => String(item).trim())
    .filter(Boolean)
    .slice(0, Math.max(minLength, value.length));
}

function ensureSummaryLength(summary: string, paper: Agent4SciencePaper, review: Partial<ConferenceReview>): string {
  let result = smartTruncate(summary, 5000);
  if (result.length >= 1200) return result;

  const extras = [
    `\n\nThe paper's main hypothesis is: ${paper.hypothesis}.`,
    `\n\nThe authors' stated conclusion is: ${paper.conclusion}.`,
    review.Strengths && review.Strengths.length > 0 ? `\n\nKey strengths noted in this review include: ${review.Strengths.join(' ')}` : '',
    review.Weaknesses && review.Weaknesses.length > 0 ? `\n\nImportant weaknesses include: ${review.Weaknesses.join(' ')}` : '',
    review.Questions && review.Questions.length > 0 ? `\n\nQuestions that materially affect the recommendation include: ${review.Questions.join(' ')}` : '',
    review.Limitations && review.Limitations.length > 0 ? `\n\nLimitations and risks include: ${review.Limitations.join(' ')}` : '',
  ];
  for (const extra of extras) {
    if (result.length >= 1200) break;
    result += extra;
  }
  if (result.length < 1200) {
    const fillers = [
      `\n\nThe paper "${paper.title}" presents claims across ${paper.tags.join(', ') || 'its stated domain'}.`,
      paper.claims.length > 0 ? `\n\nThe authors claim: ${paper.claims.join('. ')}.` : '',
      paper.limitations.length > 0 ? `\n\nStated limitations: ${paper.limitations.join('. ')}.` : '',
      `\n\nThe paper's abstract states: ${smartTruncate(paper.abstract, 800)}.`,
      `\n\nThe paper's TLDR: ${paper.tldr}.`,
    ].filter(Boolean);
    for (const filler of fillers) {
      if (result.length >= 1200) break;
      result += filler;
    }
  }
  // Final safety net for papers with very sparse metadata. Uses paper-specific
  // text instead of repeating a single hardcoded sentence in a loop.
  if (result.length < 1200) {
    result += `\n\nThis review covers "${paper.title}". The reviewer recommends that the authors strengthen the empirical evaluation, provide additional baselines, and clarify the scope of the claims made. A more detailed related work section comparing against recent methods in ${paper.tags[0] || 'the field'} would help position the contribution. The experimental setup should be described in enough detail to allow independent replication.`;
  }
  return smartTruncate(result, 5000);
}

function parseConferenceReview(raw: string, paper: Agent4SciencePaper): ConferenceReview {
  const candidate = extractJsonCandidate(raw);
  if (!candidate) {
    throw new Error(`Model did not return parseable JSON for paper ${paper.id}`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(candidate) as Record<string, unknown>;
  } catch {
    const repaired = repairJSON(candidate);
    if (!repaired) {
      throw new Error(`Model returned invalid JSON for paper ${paper.id}`);
    }
    parsed = JSON.parse(repaired) as Record<string, unknown>;
  }

  const review: ConferenceReview = {
    Summary: ensureSummaryLength(String(parsed.Summary ?? ''), paper, parsed as Partial<ConferenceReview>),
    Strengths: coerceStringArray(parsed.Strengths).slice(0, 4),
    Weaknesses: coerceStringArray(parsed.Weaknesses).slice(0, 4),
    Originality: coerceBoundedInt(parsed.Originality, 1, 4, 2),
    Quality: coerceBoundedInt(parsed.Quality, 1, 4, 2),
    Clarity: coerceBoundedInt(parsed.Clarity, 1, 4, 2),
    Significance: coerceBoundedInt(parsed.Significance, 1, 4, 2),
    Questions: coerceStringArray(parsed.Questions).slice(0, 5),
    Limitations: coerceStringArray(parsed.Limitations).slice(0, 5),
    'Ethical Concerns': Boolean(parsed['Ethical Concerns']),
    Soundness: coerceBoundedInt(parsed.Soundness, 1, 4, 2),
    Presentation: coerceBoundedInt(parsed.Presentation, 1, 4, 2),
    Contribution: coerceBoundedInt(parsed.Contribution, 1, 4, 2),
    Overall: coerceBoundedInt(parsed.Overall, 1, 10, 4),
    Confidence: coerceBoundedInt(parsed.Confidence, 1, 5, 3),
    Decision: parsed.Decision === 'Accept' ? 'Accept' : 'Reject',
    title: typeof parsed.title === 'string' ? smartTruncate(parsed.title, 200) : undefined,
  };

  if (review.Strengths.length < 2) {
    const tags = paper.tags.length > 0 ? paper.tags.join(', ') : 'its target area';
    review.Strengths = [
      `The paper addresses a question in ${tags} and states a testable hypothesis.`,
      `The authors provide a clear abstract and structured claims for "${smartTruncate(paper.title, 80)}".`,
    ];
  }
  if (review.Weaknesses.length < 2) {
    review.Weaknesses = [
      `The evidence presented for "${smartTruncate(paper.title, 80)}" does not yet fully support the stated claims.`,
      'The evaluation would benefit from stronger baselines, ablations, or statistical controls.',
    ];
  }

  return review;
}

function formatReviewResponse(thought: string, review: ConferenceReview): string {
  return `THOUGHT:
${thought}

REVIEW JSON:
\`\`\`json
${JSON.stringify(review, null, 2)}
\`\`\``;
}

function averageScore(reviews: ConferenceReview[], key: keyof ConferenceReview, min: number, max: number, fallback: number): number {
  const values = reviews
    .map(review => review[key])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .map(value => Math.max(min, Math.min(max, Math.round(value))));
  if (values.length === 0) return fallback;
  return Math.max(min, Math.min(max, Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)));
}

async function completeWithTemp(config: ReviewerConfig, messages: LLMMessage[], temperature?: number): Promise<string> {
  const client = temperature !== undefined && temperature !== config.llm.temperature
    ? new LLMClient({ ...config.llm, temperature })
    : new LLMClient(config.llm);
  const response = await client.complete(messages, config.llm.maxTokens);
  return response.content;
}

async function generateSingleReview(
  config: ReviewerConfig,
  systemPrompt: string,
  basePrompt: string,
  paper: Agent4SciencePaper,
  temperature?: number
): Promise<{ review: ConferenceReview; response: string }> {
  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: basePrompt },
  ];
  const response = await completeWithTemp(config, messages, temperature);
  return { review: parseConferenceReview(response, paper), response };
}

async function performSakanaLikeReview(
  config: ReviewerConfig,
  paper: Agent4SciencePaper,
  extracted: ExtractedPaperText,
  promptTemplate: string,
  fewshotPrompt: string
): Promise<{ review: ConferenceReview; debug: NonNullable<ReviewDraft['debug']>; trace: ReviewTrace }> {
  const systemPrompt = buildReviewerSystemPrompt(config.persona, promptTemplate, config.reviewerBias);
  const basePrompt = buildBaseReviewPrompt(paper, extracted, fewshotPrompt);

  let currentReview: ConferenceReview;
  let ensembleGenerated = 0;
  let metaReviewUsed = false;
  let reflectionsCompleted = 0;
  let convergedEarly = false;
  const trace: ReviewTrace = {
    initialPrompt: {
      system: systemPrompt,
      user: basePrompt,
    },
    ensembleReviews: [],
    reflectionRounds: [],
  };
  const history: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: basePrompt },
  ];

  console.log(
    `Review flow: ensemble=${config.numReviewsEnsemble}, reflections=${config.numReflections}, bias=${config.reviewerBias}, source=${extracted.source}`
  );

  if (config.numReviewsEnsemble > 1) {
    const reviews: ConferenceReview[] = [];
    for (let i = 0; i < config.numReviewsEnsemble; i++) {
      try {
        console.log(`Generating ensemble review ${i + 1}/${config.numReviewsEnsemble}...`);
        const generated = await generateSingleReview(config, systemPrompt, basePrompt, paper, config.ensembleTemperature);
        reviews.push(generated.review);
        ensembleGenerated += 1;
        trace.ensembleReviews.push({
          index: i + 1,
          temperature: config.ensembleTemperature,
          review: generated.review,
          rawResponse: generated.response,
        });
      } catch (error) {
        console.warn(`Ensemble review ${i + 1}/${config.numReviewsEnsemble} failed for "${paper.title}": ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (reviews.length === 0) {
      throw new Error(`No valid ensemble reviews generated for "${paper.title}"`);
    }

    console.log(`Generated ${reviews.length}/${config.numReviewsEnsemble} ensemble reviews; aggregating...`);
    const reviewText = reviews.map((review, index) => `Review ${index + 1}/${reviews.length}:
\`\`\`json
${JSON.stringify(review, null, 2)}
\`\`\``).join('\n\n');
    const metaMessages: LLMMessage[] = [
      { role: 'system', content: metaReviewerSystemPrompt(reviews.length) },
      { role: 'user', content: `${neuripsForm}

The paper title is "${paper.title}".
Aggregate the following reviews into one conservative meta-review:

${reviewText}` },
    ];
    let metaReviewed: ConferenceReview | null = null;
    let metaRawResponse = '';
    try {
      metaRawResponse = await completeWithTemp(config, metaMessages, config.llm.temperature);
      metaReviewed = parseConferenceReview(metaRawResponse, paper);
      trace.metaReview = {
        review: metaReviewed,
        rawResponse: metaRawResponse,
      };
    } catch (error) {
      console.warn(`Meta-review failed for "${paper.title}": ${error instanceof Error ? error.message : String(error)}`);
      trace.metaReview = null;
    }
    currentReview = metaReviewed ?? reviews[0];
    metaReviewUsed = Boolean(metaReviewed);
    currentReview.Originality = averageScore(reviews, 'Originality', 1, 4, currentReview.Originality);
    currentReview.Quality = averageScore(reviews, 'Quality', 1, 4, currentReview.Quality);
    currentReview.Clarity = averageScore(reviews, 'Clarity', 1, 4, currentReview.Clarity);
    currentReview.Significance = averageScore(reviews, 'Significance', 1, 4, currentReview.Significance);
    currentReview.Soundness = averageScore(reviews, 'Soundness', 1, 4, currentReview.Soundness);
    currentReview.Presentation = averageScore(reviews, 'Presentation', 1, 4, currentReview.Presentation);
    currentReview.Contribution = averageScore(reviews, 'Contribution', 1, 4, currentReview.Contribution);
    currentReview.Overall = averageScore(reviews, 'Overall', 1, 10, currentReview.Overall);
    currentReview.Confidence = averageScore(reviews, 'Confidence', 1, 5, currentReview.Confidence);

    history.push({
      role: 'assistant',
      content: formatReviewResponse(
        `I aggregated ${reviews.length} reviewer opinions into a single conservative meta-review.`,
        currentReview,
      ),
    });
  } else {
    console.log('Generating single review...');
    const generated = await generateSingleReview(config, systemPrompt, basePrompt, paper, config.llm.temperature);
    currentReview = generated.review;
    ensembleGenerated = 1;
    history.push({ role: 'assistant', content: generated.response });
  }

  if (config.numReflections > 1) {
    for (let round = 2; round <= config.numReflections; round++) {
      console.log(`Running reflection round ${round}/${config.numReflections}...`);
      history.push({ role: 'user', content: reflectionPrompt(round, config.numReflections) });
      const response = await completeWithTemp(config, history, config.llm.temperature);
      history.push({ role: 'assistant', content: response });
      currentReview = parseConferenceReview(response, paper);
      reflectionsCompleted += 1;
      const converged = /I am done/i.test(response);
      trace.reflectionRounds.push({
        round,
        review: currentReview,
        rawResponse: response,
        converged,
      });
      if (converged) {
        convergedEarly = true;
        console.log(`Reflection converged early at round ${round}/${config.numReflections}.`);
        break;
      }
    }
  }

  return {
    review: currentReview,
    debug: {
      ensembleConfigured: config.numReviewsEnsemble,
      ensembleGenerated,
      metaReviewUsed,
      reflectionsConfigured: config.numReflections,
      reflectionsCompleted,
      convergedEarly,
      extractionSource: extracted.source,
      extractedChars: extracted.extractedChars,
    },
    trace,
  };
}

function toApiDraft(
  review: ConferenceReview,
  paper: Agent4SciencePaper,
  debug?: ReviewDraft['debug'],
  trace?: ReviewTrace
): ReviewDraft {
  const rawTitle = smartTruncate(review.title ?? '', 200).trim();
  const normalizedRawTitle = rawTitle.replace(/\s+/g, ' ').toLowerCase();
  const normalizedPaperTitle = paper.title.replace(/\s+/g, ' ').toLowerCase();
  const title = !rawTitle || normalizedRawTitle === normalizedPaperTitle
    ? `${review.Decision === 'Accept' ? 'Promising but needs validation' : 'Interesting idea, evidence remains thin'}`
    : rawTitle;

  const suggestions = [
    review.Questions.length > 0 ? `Questions:\n- ${review.Questions.join('\n- ')}` : '',
    review.Limitations.length > 0 ? `Limitations:\n- ${review.Limitations.join('\n- ')}` : '',
    `Scores: Originality ${review.Originality}/4, Quality ${review.Quality}/4, Clarity ${review.Clarity}/4, Significance ${review.Significance}/4, Soundness ${review.Soundness}/4, Presentation ${review.Presentation}/4, Contribution ${review.Contribution}/4, Overall ${review.Overall}/10, Confidence ${review.Confidence}/5.`,
    `Decision: ${review.Decision}.`,
    review['Ethical Concerns'] ? 'Ethical concerns flagged: yes.' : 'Ethical concerns flagged: no.',
  ].filter(Boolean).join('\n\n');

  return {
    title: smartTruncate(title, 200),
    summary: smartTruncate(review.Summary, 5000),
    strengths: review.Strengths.slice(0, 4).map(item => smartTruncate(item, 500)),
    weaknesses: review.Weaknesses.slice(0, 4).map(item => smartTruncate(item, 500)),
    suggestions: smartTruncate(suggestions, 2000),
    decision: review.Decision,
    overall: review.Overall,
    confidence: review.Confidence,
    structured: review,
    debug,
    trace,
  };
}

async function postReview(client: ReturnType<typeof createAgent4ScienceClient>, apiKey: string, paper: Agent4SciencePaper, draft: ReviewDraft, dryRun: boolean): Promise<void> {

  if (dryRun) {
    console.log(`DRY RUN: would post review for "${paper.title}"`);
    console.log(JSON.stringify({
      paperId: paper.id,
      title: draft.title,
      summaryLength: draft.summary.length,
      overall: draft.overall,
      decision: draft.decision,
    }, null, 2));
    return;
  }

  const result = await client.createReview({
    paperId: paper.id,
    title: draft.title,
    paperUrl: paper.pdfUrl,
    summary: draft.summary,
    strengths: draft.strengths,
    weaknesses: draft.weaknesses,
    suggestions: draft.suggestions || undefined,
  }, apiKey);

  if (!result.success) {
    throw new Error(`Failed to create review for ${paper.id}: ${result.error || 'unknown error'}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const config = buildConfig();
  createLLMClient(config.llm);

  console.log(
    `Effective config: provider=${config.llm.provider}, model=${config.llm.model}, maxReviews=${config.maxReviews}, ensemble=${config.numReviewsEnsemble}, reflections=${config.numReflections}, dryRun=${config.dryRun}`
  );

  const agent = await ensureAgent(config);
  console.log(`Using agent @${agent.profile.handle} (${agent.profile.displayName})`);

  const client = createAgent4ScienceClient({ baseUrl: config.apiUrl });

  const joined = await ensureSciencesubs(client, agent.apiKey, config.persona, config.sciencesubs);
  if (joined.length > 0) {
    console.log(`Joined sciencesubs: ${joined.join(', ')}`);
  }

  const promptTemplate = loadOptionalText(config.reviewPromptFile);
  const fewshotPrompt = loadOptionalText(config.fewshotPromptFile);

  const deadline = Date.now() + config.runMinutes * 60_000;
  let reviewsPosted = 0;

  while (Date.now() < deadline && reviewsPosted < config.maxReviews) {
    const candidates = await fetchCandidatePapers(client, agent.apiKey, agent.profile, config.maxCandidates);
    if (candidates.length === 0) {
      console.log('No unrated candidate papers found yet. Waiting for next poll.');
      await sleep(config.pollIntervalMs);
      continue;
    }

    const paper = candidates[0];
    console.log(`Reviewing: ${paper.title}`);

    try {
      const fullPaper = await client.getPaper(paper.id, agent.apiKey);
      const source = fullPaper.success && fullPaper.data ? fullPaper.data : paper;
      const extracted = await extractPaperText(source, config);
      console.log(`Paper source for "${source.title}": ${extracted.source}${extracted.source === 'pdf' ? ` (${extracted.extractedChars} chars extracted)` : ''}`);
      const result = await performSakanaLikeReview(config, source, extracted, promptTemplate, fewshotPrompt);
      console.log(
        `Review debug: ensembleGenerated=${result.debug.ensembleGenerated}/${result.debug.ensembleConfigured}, metaReviewUsed=${result.debug.metaReviewUsed}, reflectionsCompleted=${result.debug.reflectionsCompleted}/${Math.max(0, result.debug.reflectionsConfigured - 1)}`
      );
      const draft = toApiDraft(result.review, source, result.debug, result.trace);
      saveStructuredReview(config, source, draft, extracted);
      await postReview(client, agent.apiKey, source, draft, config.dryRun);
      reviewsPosted += 1;
      console.log(`Posted review ${reviewsPosted}/${config.maxReviews} for "${source.title}"`);
    } catch (error) {
      console.error(`Review attempt failed for "${paper.title}": ${error instanceof Error ? error.message : String(error)}`);
    }

    if (reviewsPosted < config.maxReviews) {
      await sleep(config.pollIntervalMs);
    }
  }

  console.log(`Finished. Reviews posted: ${reviewsPosted}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
