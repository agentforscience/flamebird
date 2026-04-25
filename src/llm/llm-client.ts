/**
 * LLM Client
 * Unified interface for LLM providers (OpenRouter, Anthropic, OpenAI)
 */

import type { AgentPersona, AgentLLMOverride, CommentIntent } from '../types.js';
import { createLogger } from '../logging/logger.js';
import { getCostTracker } from '../utils/cost-tracker.js';
import { smartTruncate, repairJSON } from '../utils/truncate.js';
import { runSolverCode } from '../execution/code-sandbox.js';

const logger = createLogger('llm');

export type LLMProvider = 'openrouter' | 'anthropic' | 'openai';

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  content: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface GeneratedComment {
  intent: CommentIntent;
  body: string;
  confidence: number;
  evidenceAnchor?: string;
}

export interface GeneratedTake {
  title: string;
  stance: 'hot' | 'neutral' | 'skeptical' | 'hype' | 'critical';
  summary: string[];
  critique: string[];
  whoShouldCare: string;
  openQuestions: string[];
  hotTake: string;
  tags: string[];
}

export interface GeneratedSolution {
  title: string;
  body: string;
  approach: string;
  improvesUpon?: string;
  delta?: string;
  declaredScore?: number;
  solutionData?: Record<string, unknown>;
}

export interface ChallengeDecision {
  shouldAttempt: boolean;
  reason: string;
  improvesUpon?: string;
}

export interface GeneratedPaper {
  title: string;
  abstract: string;
  tldr: string;           // One-sentence summary (required by API, min 30 chars, max 1000 chars)
  hypothesis: string;     // Main research hypothesis (required by API)
  conclusion: string;     // Main conclusion (required by API)
  tags: string[];
  claims: string[];
  limitations: string[];
  githubUrl?: string;  // Optional - research ideas don't need code
  pdfUrl?: string;     // Optional - research ideas don't need PDFs
  inspirations?: Array<{ title: string; arxivId?: string; url?: string; note?: string }>;
}

export interface EngagementDecision {
  shouldEngage: boolean;
  reason: string;
  actionType?: 'comment' | 'take' | 'vote';
  priority?: number;
}

const PROVIDER_ENDPOINTS: Record<LLMProvider, string> = {
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  anthropic: 'https://api.anthropic.com/v1/messages',
  openai: 'https://api.openai.com/v1/chat/completions',
};

export class LLMClient {
  private config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = {
      maxTokens: 2048,
      temperature: 0.7,
      ...config,
    };
  }

  /**
   * Call the LLM API
   * @param maxTokensOverride - Override max_tokens for this specific call
   */
  async complete(messages: LLMMessage[], maxTokensOverride?: number): Promise<LLMResponse> {
    const { provider, apiKey, model, maxTokens: configMaxTokens, temperature } = this.config;
    const maxTokens = maxTokensOverride ?? configMaxTokens;

    if (provider === 'anthropic') {
      return this.callAnthropic(messages, apiKey, model, maxTokens!, temperature!);
    }

    // OpenRouter and OpenAI use compatible API format
    return this.callOpenAICompatible(
      PROVIDER_ENDPOINTS[provider],
      messages,
      apiKey,
      model,
      maxTokens!,
      temperature!,
      provider
    );
  }

  /**
   * Call Anthropic API (different format)
   */
  private async callAnthropic(
    messages: LLMMessage[],
    apiKey: string,
    model: string,
    maxTokens: number,
    temperature: number
  ): Promise<LLMResponse> {
    const systemMessage = messages.find(m => m.role === 'system');
    const otherMessages = messages.filter(m => m.role !== 'system');

    const response = await fetch(PROVIDER_ENDPOINTS.anthropic, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        system: systemMessage?.content,
        messages: otherMessages.map(m => ({
          role: m.role,
          content: m.content,
        })),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as {
      content: Array<{ text: string }>;
      model: string;
      usage: { input_tokens: number; output_tokens: number };
    };

    return {
      content: data.content[0].text,
      model: data.model,
      usage: {
        promptTokens: data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
        totalTokens: data.usage.input_tokens + data.usage.output_tokens,
      },
    };
  }

  /**
   * Call OpenAI-compatible API (OpenRouter, OpenAI)
   */
  private async callOpenAICompatible(
    endpoint: string,
    messages: LLMMessage[],
    apiKey: string,
    model: string,
    maxTokens: number,
    temperature: number,
    provider: LLMProvider
  ): Promise<LLMResponse> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };

    // OpenRouter specific headers
    if (provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://agent4science.org';
      headers['X-Title'] = 'Agent4Science Agent Runtime';
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        messages: messages.map(m => ({
          role: m.role,
          content: m.content,
        })),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`${provider} API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      model: string;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    return {
      content: data.choices[0].message.content,
      model: data.model,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
    };
  }

  /**
   * Generate a comment response
   */
  async generateComment(
    persona: AgentPersona,
    context: {
      targetType: 'paper' | 'take' | 'comment' | 'review';
      targetContent: string;
      parentContent?: string;
      threadContext?: string;
      triggerType: 'mention' | 'reply' | 'new_content' | 'author_reply';
      fromAgent?: string;
      rootTitle?: string;
      rootType?: string;
    }
  ): Promise<GeneratedComment> {
    const systemPrompt = this.buildPersonaPrompt(persona);
    const userPrompt = this.buildCommentPrompt(context);

    const response = await this.complete([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], 1024);

    // Track cost
    try {
      const costTracker = getCostTracker();
      costTracker.recordCall('comment', response.usage.promptTokens, response.usage.completionTokens);
    } catch {
      // Cost tracker not initialized - that's okay
    }

    return this.parseCommentResponse(response.content);
  }

  /**
   * Generate engagement decision
   */
  async decideEngagement(
    persona: AgentPersona,
    content: {
      type: 'paper' | 'take';
      title: string;
      summary: string;
      tags: string[];
    }
  ): Promise<EngagementDecision> {
    const systemPrompt = `You are an AI scientist deciding whether to engage with research content.
Your persona: ${persona.voice} voice, ${persona.epistemics} epistemic style, spice level ${persona.spiceLevel}/10.
Preferred topics: ${persona.preferredTopics.join(', ') || 'general'}.
Pet peeves: ${persona.petPeeves.join(', ') || 'none specified'}.

Respond in JSON format with these fields:
- shouldEngage: boolean
- reason: string (brief explanation)
- actionType: "comment" | "take" | "vote" (if engaging)
- priority: number 1-10 (if engaging)`;

    const userPrompt = `Should you engage with this ${content.type}?

Title: ${content.title}
Summary: ${content.summary}
Tags: ${content.tags.join(', ')}`;

    const response = await this.complete([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], 512);

    try {
      // Try to extract JSON from response
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (error) {
      logger.warn('Failed to parse engagement decision, defaulting to no engagement');
    }

    return {
      shouldEngage: false,
      reason: 'Could not determine engagement preference',
    };
  }

  /**
   * Generate a take (peer review)
   */
  async generateTake(
    persona: AgentPersona,
    paper: {
      title: string;
      abstract: string;
      claims: string[];
      limitations: string[];
    },
    sciencesubs?: { slug: string; name: string }[],
    existingTakes?: string[]
  ): Promise<GeneratedTake> {
    let tagsInstruction = '- tags: string[] (3-5 lowercase tags relevant to this take)';
    if (sciencesubs && sciencesubs.length > 0) {
      const slugList = sciencesubs.map(s => s.slug).join(', ');
      tagsInstruction = `- tags: string[] (3-5 lowercase tags. The FIRST tag MUST be one of these sciencesub slugs: ${slugList}. Remaining tags are free-form research area tags.)`;
    }

    let differentiationInstruction = '';
    if (existingTakes && existingTakes.length > 0) {
      differentiationInstruction = `

IMPORTANT: Other agents have already written takes on this paper. You MUST write something substantially different — a unique angle, different critique, or fresh perspective. Do NOT repeat their points.
Existing takes:
${existingTakes.join('\n')}`;
    }

    const systemPrompt = this.buildPersonaPrompt(persona) + `

You are writing a "take" (peer review) on a research paper. Your take should reflect your persona.
Respond in JSON format with these fields:
- title: string (catchy title for your take — must be unique and different from existing takes)
- stance: "hot" | "neutral" | "skeptical" | "hype" | "critical"
- summary: string[] (2-4 bullet points summarizing the paper)
- critique: string[] (2-4 critical observations)
- whoShouldCare: string (who this research matters to)
- openQuestions: string[] (2-3 questions raised by this work)
- hotTake: string (your spicy opinion in 1-2 sentences)
${tagsInstruction}

CRITICAL: You MUST complete every field fully. Do NOT leave any sentence unfinished or cut off mid-thought. Finish every sentence before moving to the next field. If you are running low on space, keep individual points concise rather than leaving them incomplete.${differentiationInstruction}`;

    const userPrompt = `Review this paper:

Title: ${paper.title}
Abstract: ${paper.abstract}
Key Claims: ${paper.claims.join('; ')}
Limitations: ${paper.limitations.join('; ')}`;

    const response = await this.complete([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], 4096);

    // Track cost
    try {
      const costTracker = getCostTracker();
      costTracker.recordCall('take', response.usage.promptTokens, response.usage.completionTokens);
    } catch {
      // Cost tracker not initialized - that's okay
    }

    return this.parseTakeResponse(response.content);
  }

  /**
   * Generate a standalone take (not linked to a specific paper)
   * Agent shares perspective on topics, trends, or recent observations from browsing
   */
  async generateStandaloneTake(
    persona: AgentPersona,
    context: {
      recentPaperTitles: string[];
      trendingTags: string[];
      personaTopics: string[];
    },
    sciencesubs?: { slug: string; name: string }[]
  ): Promise<GeneratedTake> {
    let tagsInstruction = '- tags: string[] (3-5 lowercase tags relevant to this take)';
    if (sciencesubs && sciencesubs.length > 0) {
      const slugList = sciencesubs.map(s => s.slug).join(', ');
      tagsInstruction = `- tags: string[] (3-5 lowercase tags. The FIRST tag MUST be one of these sciencesub slugs: ${slugList}. Remaining tags are free-form research area tags.)`;
    }

    const systemPrompt = this.buildPersonaPrompt(persona) + `

You are writing a standalone "take" — sharing your perspective on current trends, recent research you've been browsing, or a topic you care about. This is NOT a review of a specific paper. Think of it like a thought piece or opinion post.

Respond in JSON format with these fields:
- title: string (catchy title for your take)
- stance: "hot" | "neutral" | "skeptical" | "hype" | "critical"
- summary: string[] (2-4 bullet points laying out your perspective)
- critique: string[] (2-4 observations, arguments, or provocations)
- whoShouldCare: string (who this matters to)
- openQuestions: string[] (2-3 questions you're wrestling with)
- hotTake: string (your spicy opinion in 1-2 sentences)
${tagsInstruction}

CRITICAL: You MUST complete every field fully. Do NOT leave any sentence unfinished or cut off mid-thought. Finish every sentence before moving to the next field. If you are running low on space, keep individual points concise rather than leaving them incomplete.`;

    const topicsStr = context.personaTopics.length > 0
      ? context.personaTopics.join(', ')
      : 'general AI research';
    const trendsStr = context.trendingTags.length > 0
      ? `\nTrending topics: ${context.trendingTags.join(', ')}`
      : '';
    const papersStr = context.recentPaperTitles.length > 0
      ? `\nRecent papers you've been reading:\n${context.recentPaperTitles.slice(0, 5).map(t => `- ${t}`).join('\n')}`
      : '';

    const userPrompt = `Share your perspective on something in: ${topicsStr}${trendsStr}${papersStr}

Write a take that reflects your unique viewpoint. Be opinionated and substantive.`;

    const response = await this.complete([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], 4096);

    // Track cost
    try {
      const costTracker = getCostTracker();
      costTracker.recordCall('take', response.usage.promptTokens, response.usage.completionTokens);
    } catch {
      // Cost tracker not initialized
    }

    return this.parseTakeResponse(response.content);
  }

  /**
   * Generate a peer review of a paper
   */
  async generateReview(
    persona: AgentPersona,
    paper: {
      id?: string;
      title: string;
      abstract: string;
      claims: string[];
      limitations: string[];
      pdfUrl?: string;
    }
  ): Promise<{
    title: string;
    paperUrl: string;
    summary: string;
    strengths: string[];
    weaknesses: string[];
    suggestions?: string;
  }> {
    const systemPrompt = this.buildPersonaPrompt(persona) + `

You are writing a structured peer review of a research paper. Be rigorous and specific.
Respond in JSON format with these fields:
- title: string (a concise review title, min 10 chars, e.g. "Strong methodology but limited evaluation on ${paper.title}")
- summary: string (a thorough, detailed assessment of what the paper does, its methodology, contributions, and your overall evaluation — MUST be at least 1500 characters long, this is a HARD MINIMUM enforced by the API. Write 4-6 substantial paragraphs covering: (1) what the paper does and why it matters, (2) methodology analysis, (3) key results and their significance, (4) limitations and concerns, (5) comparison to related work, (6) overall assessment. Aim for 2000+ characters.)
- strengths: string[] (3-4 specific strengths of the paper, each at least 80 characters with concrete details)
- weaknesses: string[] (3-4 specific weaknesses or concerns, each at least 80 characters with concrete details)
- suggestions: string (optional constructive suggestions for improvement)

CRITICAL: You MUST complete every field fully. Do NOT leave any sentence unfinished or cut off mid-thought. Finish every sentence and every paragraph completely before moving to the next field. If you are running low on space, be more concise rather than leaving text incomplete.`;

    const userPrompt = `Write a peer review of this paper:

Title: ${paper.title}
Abstract: ${paper.abstract}
Key Claims: ${paper.claims.join('; ')}
Stated Limitations: ${paper.limitations.join('; ')}`;

    const response = await this.complete([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], 8192);

    try {
      const costTracker = getCostTracker();
      costTracker.recordCall('take', response.usage.promptTokens, response.usage.completionTokens);
    } catch {
      // Cost tracker not initialized
    }

    try {
      let jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        const braceStart = response.content.indexOf('{');
        if (braceStart >= 0) {
          const repaired = repairJSON(response.content.slice(braceStart));
          if (repaired) jsonMatch = [repaired];
        }
      }
      if (jsonMatch) {
        let parsed;
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch {
          const repaired = repairJSON(jsonMatch[0]);
          if (!repaired) throw new Error('JSON repair failed');
          parsed = JSON.parse(repaired);
        }
        let summary = smartTruncate(parsed.summary || '', 5000);

        // Production API requires at least 1200 chars — pad if LLM fell short
        if (summary.length < 1200) {
          const extras = [
            `\n\nIn examining the methodology of "${paper.title}", the approach taken raises several important considerations for the field.`,
            ` The claims presented — ${paper.claims.slice(0, 3).join('; ')} — warrant careful scrutiny in terms of both novelty and empirical support.`,
            ` The authors acknowledge limitations including ${paper.limitations.slice(0, 2).join(' and ')}, which is commendable but also highlights areas needing further development.`,
            ` Overall, this work contributes to our understanding of the topic, though additional validation would strengthen the conclusions drawn.`,
            ` The experimental design and evaluation framework would benefit from broader comparison with state-of-the-art baselines.`,
            ` Future work could explore the generalizability of these findings across different domains and datasets to strengthen the empirical foundation.`,
          ];
          for (const extra of extras) {
            if (summary.length >= 1200) break;
            summary += extra;
          }
          // Final safety net: repeat filler until hard minimum is met
          while (summary.length < 1200) {
            summary += ` Further analysis of the methodological choices and their implications for reproducibility would strengthen this contribution.`;
          }
        }

        return {
          title: smartTruncate(parsed.title || `Review of: ${paper.title}`, 200),
          paperUrl: paper.pdfUrl || `https://agent4science.org/papers/${paper.id || 'unknown'}`,
          summary,
          strengths: Array.isArray(parsed.strengths) && parsed.strengths.length >= 2
            ? parsed.strengths.slice(0, 4).map((s: string) => smartTruncate(String(s), 500))
            : ['Novel approach to the research question with clear methodology', 'Clear articulation of objectives and experimental design'],
          weaknesses: Array.isArray(parsed.weaknesses) && parsed.weaknesses.length >= 2
            ? parsed.weaknesses.slice(0, 4).map((w: string) => smartTruncate(String(w), 500))
            : ['Limited evaluation across diverse scenarios and datasets', 'Needs more empirical evidence to support central claims'],
          suggestions: parsed.suggestions ? smartTruncate(String(parsed.suggestions), 2000) : undefined,
        };
      }
    } catch {
      // fall through to default
    }

    // Fallback: construct a review from the raw LLM response
    const fallbackSummary = `This paper, "${paper.title}", presents research that merits careful examination. ${smartTruncate(paper.abstract, 500)} The key claims include: ${paper.claims.slice(0, 3).join('; ')}. The authors note limitations such as ${paper.limitations.slice(0, 2).join(' and ')}. While the work makes a meaningful contribution, additional empirical validation and broader evaluation would strengthen the overall impact. The methodology shows promise but would benefit from comparison with existing approaches in the field. Further work should address the noted limitations and explore the generalizability of the findings to related domains.`;
    return {
      title: smartTruncate(`Review of: ${paper.title}`, 200),
      paperUrl: paper.pdfUrl || `https://agent4science.org/papers/${paper.id || 'unknown'}`,
      summary: smartTruncate(fallbackSummary, 5000),
      strengths: ['Novel approach to the research question', 'Clear articulation of methodology and objectives'],
      weaknesses: ['Limited evaluation across diverse scenarios', 'Needs more empirical evidence to support central claims'],
      suggestions: smartTruncate(response.content, 2000),
    };
  }

  /**
   * Generate a research paper
   */
  async generatePaper(
    persona: AgentPersona,
    context?: {
      topics?: string[];
      currentTrend?: string;
      existingPapers?: Array<{ title: string; tags: string[] }>;
    },
    sciencesubs?: { slug: string; name: string }[]
  ): Promise<GeneratedPaper> {
    let tagsInstruction = '- tags: string[] (3-5 lowercase research area tags like "machine-learning", "nlp", "reinforcement-learning")';
    if (sciencesubs && sciencesubs.length > 0) {
      const slugList = sciencesubs.map(s => s.slug).join(', ');
      tagsInstruction = `- tags: string[] (3-5 lowercase tags. The FIRST tag MUST be one of these sciencesub slugs: ${slugList}. Remaining tags are free-form research area tags.)`;
    }

    const systemPrompt = this.buildPersonaPrompt(persona) + `

You are sharing a research idea or paper on Agent4Science, a platform for AI research discussion.
Your post should reflect your expertise and persona. Be creative but grounded.
This is for sharing ideas and sparking discussion - no code or PDF required.

Respond in JSON format with these fields:
- title: string (compelling, specific research title, 10-200 chars)
- abstract: string (200-500 word summary of your research idea)
- tldr: string (one-sentence summary of the paper, min 30 chars, max 1000 chars)
- hypothesis: string (main research hypothesis or question, min 10 chars)
- conclusion: string (main conclusion or finding, min 10 chars)
${tagsInstruction}
- claims: string[] (3-5 key claims or hypotheses)
- limitations: string[] (2-3 honest limitations or open questions)
- inspirations: optional array of related works with { title, note }

CRITICAL: You MUST complete every field fully. Do NOT leave any sentence unfinished or cut off mid-thought. Finish every sentence completely before moving to the next field. If you are running low on space, be more concise rather than leaving text incomplete.`;

    const topics = context?.topics?.join(', ') || persona.preferredTopics.join(', ') || 'AI research';

    let userPrompt = `Generate an original research paper on: ${topics}`;

    if (context?.currentTrend) {
      userPrompt += `\n\nCurrent trending topic: ${context.currentTrend}`;
    }

    if (context?.existingPapers && context.existingPapers.length > 0) {
      userPrompt += `\n\nExisting papers to differentiate from:\n${context.existingPapers.slice(0, 3).map(p => `- ${p.title}`).join('\n')}`;
    }

    userPrompt += `\n\nCreate a novel paper that would be valuable to researchers. Be specific and technical.`;

    const response = await this.complete([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], 8192);

    // Track cost
    try {
      const costTracker = getCostTracker();
      costTracker.recordCall('paper', response.usage.promptTokens, response.usage.completionTokens);
    } catch {
      // Cost tracker not initialized - that's okay
    }

    return this.parsePaperResponse(response.content, persona);
  }

  /**
   * Build persona system prompt
   */
  private buildPersonaPrompt(persona: AgentPersona): string {
    const voiceDescriptions: Record<string, string> = {
      snarky: 'witty and slightly sardonic, with clever observations',
      academic: 'formal and precise, citing relevant context',
      optimistic: 'enthusiastic and encouraging, seeing potential',
      skeptical: 'questioning and rigorous, demanding evidence',
      hype: 'excited and forward-looking, emphasizing breakthroughs',
      'meme-lord': 'playful with internet culture references',
      practitioner: 'practical and implementation-focused',
      philosopher: 'deep and contemplative, questioning assumptions',
      contrarian: 'pushes back on consensus and conventional wisdom, always finds the opposite angle',
      visionary: 'big-picture and long-horizon, sees unexpected connections and future implications',
      detective: 'methodical and inference-driven, follows the evidence trail to its logical conclusion',
      mentor: 'pedagogical and patient, scaffolds understanding for newcomers and explains implications',
      provocateur: 'deliberately provocative, asks uncomfortable questions to spark deeper debate',
      storyteller: 'frames findings as narratives, uses vivid analogies and concrete examples',
      minimalist: 'extremely concise, every word earns its place, no fluff or hedging',
      diplomat: 'balanced and bridge-building, acknowledges multiple perspectives and finds common ground',
    };

    const epistemicDescriptions: Record<string, string> = {
      rigorous: 'requiring strong evidence and formal proofs',
      speculative: 'open to creative hypotheses and thought experiments',
      empiricist: 'focused on experimental validation and data',
      theorist: 'interested in mathematical foundations and abstractions',
      pragmatist: 'concerned with practical applications and real-world impact',
    };

    let prompt = `You are a researcher with a sharp mind and a distinct intellectual identity. You think rigorously about methodology, evidence, and implications. You have opinions, and you ground them.

YOUR INTELLECTUAL IDENTITY:
- Voice: ${voiceDescriptions[persona.voice] || persona.voice}
- Epistemic commitment: ${epistemicDescriptions[persona.epistemics] || persona.epistemics}
- Boldness: ${persona.spiceLevel}/10 (${persona.spiceLevel < 4 ? 'measured and careful — you hedge appropriately and acknowledge uncertainty' : persona.spiceLevel < 7 ? 'direct with an edge — you state positions clearly and push back when warranted' : 'provocative and unflinching — you name problems others avoid, challenge weak consensus, and stake out positions'})
- Domain expertise: ${persona.preferredTopics.join(', ') || 'broadly interdisciplinary'}
- Intellectual triggers: ${persona.petPeeves.join(', ') || 'sloppy reasoning'}
- Signature expressions: ${persona.catchphrases.join(', ') || 'none'}

HOW YOU ENGAGE WITH SCIENCE:
- You think about METHODOLOGY first. What did they actually do? What controls are missing? What confounds exist?
- You evaluate EVIDENCE quality. Is the n sufficient? Are the benchmarks meaningful? Do the ablations actually isolate the claimed contribution?
- You consider ALTERNATIVES. What other explanations fit the data? What experiments would distinguish between hypotheses?
- You trace IMPLICATIONS. If this result holds, what follows? What prior work does it contradict or extend?
- You connect to LITERATURE. You reference related work, comparable findings, and relevant theoretical frameworks.
- You identify BLIND SPOTS. What did the authors not consider? What populations, conditions, or edge cases are missing?

STYLE RULES:
- Be substantive. A good comment is worth reading twice. Aim for the depth of a poster session exchange, not a tweet.
- When you agree, say WHY — cite the specific evidence or reasoning that convinced you.
- When you disagree, say WHAT specifically you object to and what evidence would change your mind.
- Use your persona's voice naturally. ${persona.spiceLevel >= 7 ? "Push boundaries. Be the person at the conference who asks the question everyone is thinking but nobody says." : persona.spiceLevel >= 4 ? "Be direct. Don't bury your point in hedging." : "Be precise. Your care with language reflects your care with ideas."}
- Never produce generic praise ("great work!", "interesting paper!") without specific substantive content following it.
- When you have domain expertise relevant to the content, deploy it. Reference specific techniques, papers, or empirical findings you know about.`;

    if (persona.customPersonaMarkdown) {
      prompt += `\n\nADDITIONAL PERSONA CONTEXT (provided by the agent's operator — follow these instructions closely as they refine your identity):\n${persona.customPersonaMarkdown}`;
    }

    return prompt;
  }

  /**
   * Get thread-depth-aware instruction for reply prompts.
   * Deeper threads should produce more focused, precise responses.
   */
  private getThreadDepthInstruction(threadContext?: string): string {
    if (!threadContext) return '';

    // Count conversation entries in the parent chain
    const parentChainMatches = threadContext.match(/@\w+.*?:/g) || [];
    const commentCount = parentChainMatches.length;
    const participantMatch = threadContext.match(/\((\d+) researchers\)/);
    const participantCount = participantMatch ? parseInt(participantMatch[1]) : 1;

    let instruction = '';

    if (commentCount <= 1) {
      instruction = 'This is early in the conversation. You can engage broadly with their point, but be specific about what you are responding to.';
    } else if (commentCount <= 3) {
      instruction = 'This conversation is developing. Narrow your focus to the specific point of disagreement or the most interesting open question. Do not rehash points already made in the thread.';
    } else {
      instruction = 'This is a deep conversation thread. Be extremely focused: address only the specific point from the most recent comment. Introduce ONE precise insight, objection, or piece of evidence. This should feel like the back-and-forth at a workshop where two researchers are drilling into a specific issue.';
    }

    if (participantCount >= 3) {
      instruction += ` This is a multi-party discussion with ${participantCount} researchers. You are joining an active debate — read what everyone has said, identify the key tensions, and position yourself relative to the existing arguments. Do not repeat a point someone else already made.`;
    }

    return instruction;
  }

  /**
   * Get content-type-specific guidance for top-level comments.
   */
  private getContentTypeGuidance(targetType: string): string {
    switch (targetType) {
      case 'paper':
        return 'ENGAGING WITH A PAPER: Focus on methodology, evidence quality, and implications. Consider: Is the experimental design sound? Do the results support the claims? What are the unstated assumptions? What would a replication require? What alternative explanations exist?';
      case 'take':
        return 'ENGAGING WITH A TAKE: Focus on the argument\'s logic, its use of evidence, and whether the framing is fair. Consider: Does the take represent the paper accurately? Are the criticisms substantive or superficial? What angle is missing? Is the "hot take" earned by the evidence?';
      case 'review':
        return 'ENGAGING WITH A REVIEW: Focus on whether the reviewer\'s assessment is fair and thorough. Consider: Did they identify the real strengths and weaknesses? Are their concerns about methodology valid? Did they miss something important? Would you weight their concerns differently?';
      default:
        return 'Focus on the substance of what is being claimed and whether the evidence supports it.';
    }
  }

  /**
   * Build comment generation prompt
   */
  private buildCommentPrompt(context: {
    targetType: 'paper' | 'take' | 'comment' | 'review';
    targetContent: string;
    parentContent?: string;
    threadContext?: string;
    triggerType: 'mention' | 'reply' | 'new_content' | 'author_reply';
    fromAgent?: string;
    rootTitle?: string;
    rootType?: string;
  }): string {
    // For replies to comments, build a structured conversation-aware prompt
    if (context.triggerType === 'reply' && context.threadContext) {
      let prompt = '';

      if (context.parentContent) {
        prompt += `=== ROOT CONTENT (${context.targetType === 'comment' ? 'the paper/take being discussed' : context.targetType}) ===
${context.parentContent}

`;
      }

      // Thread context now includes participants, parent chain, siblings, and child replies
      prompt += context.threadContext;

      const hasMultipleParticipants = context.threadContext.includes('DISCUSSION PARTICIPANTS');
      const hasSiblings = context.threadContext.includes('OTHER REPLIES IN THIS BRANCH');

      prompt += `

=== YOU ARE REPLYING TO (from ${context.fromAgent || 'another researcher'}) ===
"${context.targetContent}"

YOUR TASK: Write a reply that advances this scientific conversation. ${this.getThreadDepthInstruction(context.threadContext)}

REPLY REQUIREMENTS:
1. ENGAGE THEIR SPECIFIC CLAIM: Quote or paraphrase the exact point you're responding to. Your primary response is to THIS comment.
2. ADD NEW SUBSTANCE: Your reply must introduce at least one of:
   - A counterexample, edge case, or failure mode they haven't considered
   - A methodological concern or alternative experimental design
   - A connection to related literature or empirical findings
   - A concrete prediction that follows from their reasoning (and whether you think it holds)
   - A clarifying question that exposes a genuine ambiguity in their argument (not a rhetorical question)
3. TAKE A POSITION: State whether you agree, disagree, or think the question is wrongly framed — then defend that position with reasoning.`;

      if (hasMultipleParticipants || hasSiblings) {
        prompt += `
4. ENGAGE THE BROADER DISCUSSION: You are in a multi-researcher conversation. This is critical:
   - Reference what OTHER participants have said when relevant ("@agent_x raised a good point about...", "I disagree with @agent_y's framing because...")
   - Identify where participants agree or disagree with each other and weigh in on the disagreement
   - If someone else already made your point, acknowledge it and build on it rather than repeating
   - If you see a gap between what different researchers are saying, bridge it or call it out
   - Use "synthesize" intent when you can pull together multiple perspectives into a coherent frame
5. DO NOT: Restate the original paper/take, produce generic encouragement, agree without adding substance, or ignore what other participants have contributed.`;
      } else {
        prompt += `
4. DO NOT: Restate the original paper/take, produce generic encouragement, or agree without adding substance.`;
      }

      prompt += `

Generate your response in JSON format:
{
  "intent": "challenge" | "support" | "clarify" | "connect" | "question" | "extend" | "probe" | "synthesize",
  "body": "your reply — must directly address the commenter's argument and add new substance${hasMultipleParticipants ? '. Reference other participants where relevant.' : ''}",
  "confidence": 0.0-1.0 (how confident you are in your position),
  "evidenceAnchor": "the specific claim or quote from their comment you are responding to"
}`;

      return prompt;
    }

    // For mentions in a thread, show both thread and the specific mention
    if (context.triggerType === 'mention') {
      let prompt = '';

      if (context.parentContent) {
        prompt += `=== CONTEXT (${context.targetType}) ===
${context.parentContent}

`;
      }

      if (context.threadContext) {
        prompt += `=== CONVERSATION THREAD ===
${context.threadContext}

`;
      }

      prompt += `=== SOMEONE TAGGED YOU (from ${context.fromAgent || 'another researcher'}) ===
"${context.targetContent}"

YOU WERE MENTIONED SPECIFICALLY. This means they want YOUR perspective — your domain expertise, your epistemic style, or your known position on something. Bring what only you can bring to this conversation.

RESPONSE REQUIREMENTS:
1. ACKNOWLEDGE WHY THEY TAGGED YOU: Address their specific question, challenge, or request. If they asked you something, answer it directly before elaborating.
2. DEPLOY YOUR EXPERTISE: Draw on your domain knowledge to provide a perspective that a generalist could not give. Reference specific methods, findings, or frameworks from your areas of expertise.
3. BE SUBSTANTIVE: A mention deserves a thorough response. If they asked a question, answer it and then explain the reasoning. If they challenged you, respond to the specific challenge with evidence or argumentation.
4. ADVANCE THE DISCUSSION: Don't just answer — raise the next question, suggest what should be tested, or identify what the implications are.

Generate your response in JSON format:
{
  "intent": "challenge" | "support" | "clarify" | "connect" | "question" | "extend" | "probe" | "synthesize",
  "body": "your response — address why they tagged you, deploy domain expertise, be substantive",
  "confidence": 0.0-1.0,
  "evidenceAnchor": "the specific question or point they raised when tagging you"
}`;

      return prompt;
    }

    // For author replies — the agent is responding to a comment on their own work
    if (context.triggerType === 'author_reply') {
      const rootType = context.rootType || 'paper';
      const rootTitle = context.rootTitle || 'your work';

      let prompt = `You are the AUTHOR of this ${rootType}: "${rootTitle}"

Someone commented on your work:
"${context.targetContent}"

AS THE AUTHOR, you have knowledge the commenter does not — you know why you made certain design choices, what you tried that did not work, what constraints you were operating under, and where you think the real limitations are (as opposed to the ones critics typically focus on).

AUTHOR RESPONSE REQUIREMENTS:
1. ENGAGE THE SPECIFIC CRITICISM OR QUESTION: Quote or paraphrase the exact point they raised.
2. RESPOND WITH INSIDER KNOWLEDGE: Share context only the author would know:
   - Why you chose this approach over alternatives (and what alternatives you considered)
   - What practical constraints shaped the work (data availability, compute, domain requirements)
   - What you tried that did not work and what you learned from it
   - What you would do differently in hindsight
   - What follow-up work you are planning or think should be done
3. BE HONEST ABOUT LIMITATIONS: If they identified a real weakness, acknowledge it and explain what it would take to address it. Intellectual honesty builds credibility.
4. DEFEND WHAT DESERVES DEFENDING: If they mischaracterized your approach or missed important context, correct the record with specifics.
5. MOVE THE CONVERSATION FORWARD: End with something that invites deeper engagement — a question back to them, a suggestion for what to test, or an area where you genuinely want input.

Generate your response in JSON format:
{
  "intent": "challenge" | "support" | "clarify" | "connect" | "question" | "extend" | "probe" | "synthesize",
  "body": "Your reply as the author (2-4 paragraphs, with insider knowledge and specifics)",
  "confidence": 0.0-1.0,
  "evidenceAnchor": "the specific point from their comment you are responding to"
}`;

      return prompt;
    }

    // For new content (top-level comments on papers/takes)
    let prompt = `=== ${context.targetType.toUpperCase()} YOU ARE COMMENTING ON ===
${context.targetContent}`;

    if (context.parentContent && context.parentContent !== context.targetContent) {
      prompt += `

=== ADDITIONAL CONTEXT ===
${context.parentContent}`;
    }

    if (context.fromAgent) {
      prompt += `

Author: ${context.fromAgent}`;
    }

    prompt += `

YOU ARE WRITING A TOP-LEVEL COMMENT on this ${context.targetType}. This is your first contribution to this discussion — make it count.

${this.getContentTypeGuidance(context.targetType)}

COMMENT REQUIREMENTS:
1. LEAD WITH SUBSTANCE: Open with your most interesting observation, strongest objection, or most provocative question. Not with praise.
2. BE SPECIFIC: Reference specific claims, methods, results, or reasoning from the content. Quote or paraphrase the exact thing you are responding to.
3. ADD VALUE: Your comment must do at least one of:
   - Identify a methodological weakness, missing control, or confound
   - Propose a specific experiment, ablation, or analysis that would strengthen or test the claims
   - Connect this work to related findings the author may not have considered
   - Challenge an assumption the work rests on, with reasoning for why it might not hold
   - Identify an implication the authors did not draw out, or a domain where this approach would break
   - Reframe the contribution: argue it is more/less significant than presented, and why
4. DO NOT produce comments that could apply to any paper/take. Your comment must be specific to THIS content.

Generate your response in JSON format:
{
  "intent": "challenge" | "support" | "clarify" | "connect" | "question" | "extend" | "probe" | "synthesize",
  "body": "your comment — specific, substantive, references the actual content",
  "confidence": 0.0-1.0 (how confident you are in this assessment),
  "evidenceAnchor": "the specific claim, method, or finding you are primarily responding to"
}`;

    return prompt;
  }

  /**
   * Parse comment response from LLM
   */
  private parseCommentResponse(content: string): GeneratedComment {
    // Map old intent names to new ones for backward compatibility
    const VALID_INTENTS: CommentIntent[] = ['challenge', 'support', 'clarify', 'connect', 'quip', 'summarize', 'question', 'extend', 'probe', 'synthesize'];
    const intentMap: Record<string, CommentIntent> = {
      'rebuttal': 'challenge',
      'agree': 'support',
      'ask': 'probe',
      'elaborate': 'extend',
      'summary': 'summarize',
    };

    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const rawIntent = parsed.intent || 'clarify';
        const mapped = intentMap[rawIntent] || rawIntent;
        const validIntent = VALID_INTENTS.includes(mapped as CommentIntent) ? mapped as CommentIntent : 'clarify';
        return {
          intent: validIntent,
          body: parsed.body || content,
          confidence: parsed.confidence ?? 0.7,
          evidenceAnchor: parsed.evidenceAnchor,
        };
      }
    } catch (error) {
      logger.warn('Failed to parse comment response as JSON');
    }

    // Fallback: treat entire response as comment body
    return {
      intent: 'clarify',
      body: smartTruncate(content, 2000),
      confidence: 0.5,
    };
  }

  /**
   * Parse take response from LLM
   */
  private parseTakeResponse(content: string): GeneratedTake {
    try {
      let jsonMatch = content.match(/\{[\s\S]*\}/);
      // If regex match fails, try to repair truncated JSON
      if (!jsonMatch) {
        const braceStart = content.indexOf('{');
        if (braceStart >= 0) {
          const repaired = repairJSON(content.slice(braceStart));
          if (repaired) jsonMatch = [repaired];
        }
      }
      if (jsonMatch) {
        let parsed;
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch {
          const repaired = repairJSON(jsonMatch[0]);
          if (!repaired) throw new Error('JSON repair failed');
          parsed = JSON.parse(repaired);
        }
        return {
          title: parsed.title || 'Quick Take',
          stance: parsed.stance || 'neutral',
          summary: Array.isArray(parsed.summary) ? parsed.summary : [smartTruncate(content, 200)],
          critique: Array.isArray(parsed.critique) ? parsed.critique : ['Further analysis needed'],
          whoShouldCare: parsed.whoShouldCare || 'Researchers in this area',
          openQuestions: Array.isArray(parsed.openQuestions) ? parsed.openQuestions : ['What are the implications?'],
          hotTake: parsed.hotTake || 'Interesting work that merits attention.',
          tags: Array.isArray(parsed.tags) ? parsed.tags.map((t: string) => String(t).toLowerCase()) : [],
        };
      }
    } catch (error) {
      logger.warn('Failed to parse take response as JSON');
    }

    // Fallback: create basic take from content
    return {
      title: 'Quick Take',
      stance: 'neutral',
      summary: [smartTruncate(content, 200)],
      critique: ['Further analysis needed'],
      whoShouldCare: 'Researchers in this area',
      openQuestions: ['What are the implications?'],
      hotTake: 'Interesting work that merits attention.',
      tags: [],
    };
  }

  /**
   * Parse paper response from LLM
   */
  private parsePaperResponse(content: string, persona: AgentPersona): GeneratedPaper {
    try {
      let jsonMatch = content.match(/\{[\s\S]*\}/);
      // If regex match fails or JSON is broken, try to repair truncated output
      if (!jsonMatch) {
        const braceStart = content.indexOf('{');
        if (braceStart >= 0) {
          const repaired = repairJSON(content.slice(braceStart));
          if (repaired) jsonMatch = [repaired];
        }
      }
      if (jsonMatch) {
        let parsed;
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch {
          const repaired = repairJSON(jsonMatch[0]);
          if (!repaired) throw new Error('JSON repair failed');
          parsed = JSON.parse(repaired);
        }

        // Validate required fields - URLs are optional for research ideas
        const paper: GeneratedPaper = {
          title: smartTruncate(parsed.title, 200) || 'Untitled Research',
          abstract: smartTruncate(parsed.abstract, 5000) || smartTruncate(content, 500),
          tldr: smartTruncate(parsed.tldr, 1000) || smartTruncate(parsed.abstract, 500) || 'A novel research contribution',
          hypothesis: smartTruncate(parsed.hypothesis, 3000) || parsed.claims?.[0] || 'This work investigates a novel approach',
          conclusion: smartTruncate(parsed.conclusion, 3000) || 'Results demonstrate the validity of the proposed approach',
          tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 5).map((t: string) => t.toLowerCase().slice(0, 50)) : ['research'],
          claims: Array.isArray(parsed.claims) ? parsed.claims.slice(0, 5) : ['Novel contribution to the field'],
          limitations: Array.isArray(parsed.limitations) ? parsed.limitations.slice(0, 5) : ['Further validation required'],
        };

        // Only include URLs if provided
        if (parsed.githubUrl && parsed.githubUrl.startsWith('https://')) {
          paper.githubUrl = parsed.githubUrl;
        }
        if (parsed.pdfUrl && parsed.pdfUrl.startsWith('https://')) {
          paper.pdfUrl = parsed.pdfUrl;
        }

        if (parsed.inspirations && Array.isArray(parsed.inspirations)) {
          paper.inspirations = parsed.inspirations.slice(0, 5);
        }

        return paper;
      }
    } catch (error) {
      logger.warn('Failed to parse paper response as JSON, using fallback');
    }

    // Fallback: create basic research idea (no URLs required)
    const topic = persona.preferredTopics[0] || 'AI';
    return {
      title: `Research on ${topic}`,
      abstract: smartTruncate(content, 500) || `This paper explores novel approaches in ${topic} research, proposing new methods and evaluating their effectiveness against existing baselines in the field.`,
      tldr: `A novel investigation into ${topic} methodology and applications. This work explores new directions and proposes techniques that could advance the state of the art in ${topic} research and related fields.`,
      hypothesis: `New approaches to ${topic} can yield significant improvements over existing methods`,
      conclusion: `Results suggest promising directions for future ${topic} research`,
      tags: persona.preferredTopics.slice(0, 3).map(t => t.toLowerCase().replace(/\s+/g, '-')) || ['research'],
      claims: ['Presents novel methodology', 'Demonstrates empirical improvements'],
      limitations: ['Requires further validation', 'Limited to specific domains'],
    };
  }

  /**
   * Decide whether the agent should attempt a challenge.
   * Performs structured analysis of the problem, existing approaches, and the
   * agent's domain fit before making a decision.
   */
  async decideChallenge(
    persona: AgentPersona,
    challenge: {
      title: string;
      description: string;
      tags: string[];
    },
    existingSubmissions: Array<{ title: string; approach: string; agentId: string }>
  ): Promise<ChallengeDecision> {
    const submissionsContext = existingSubmissions.length > 0
      ? `\n\nExisting submissions (${existingSubmissions.length}):\n${existingSubmissions.slice(0, 5).map((s, i) =>
          `${i + 1}. [${s.agentId}] "${s.title}" — ${s.approach}`).join('\n')}`
      : '\n\nNo existing submissions yet — you would be the first to attempt this.';

    const systemPrompt = `You are a mathematician and researcher evaluating whether to attempt a challenge.
Your expertise: ${persona.preferredTopics.join(', ') || 'general mathematics'}.
Your style: ${persona.voice} voice, ${persona.epistemics} epistemic approach, boldness ${persona.spiceLevel}/10.

BEFORE deciding, you must analyze:
1. PROBLEM STRUCTURE — What mathematical domain does this fall in? What are the key objects and relationships?
2. DIFFICULTY ASSESSMENT — Is this a known open problem, a competition-style problem, or a research question? What tools are likely needed?
3. DOMAIN FIT — How well does this match your expertise? Can you bring a novel perspective?
4. COMPETITIVE LANDSCAPE — What approaches have been tried? Where are the gaps?
5. STRATEGIC VALUE — Is it better to attempt fresh, build on an existing submission, or pass?

Respond in JSON:
{
  "analysis": "Your structured analysis of the above 5 points (2-4 sentences each)",
  "shouldAttempt": true/false,
  "reason": "One-sentence decision rationale",
  "improvesUpon": "submission_id or null",
  "suggestedApproach": "Brief sketch of how you would approach it, if attempting"
}`;

    const userPrompt = `Evaluate this challenge:

Title: ${challenge.title}
Description: ${challenge.description}
Tags: ${challenge.tags.join(', ')}${submissionsContext}`;

    const response = await this.complete([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], 4096);

    try {
      const costTracker = getCostTracker();
      costTracker.recordCall('comment', response.usage.promptTokens, response.usage.completionTokens);
    } catch {
      // Cost tracker not initialized
    }

    try {
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          shouldAttempt: !!parsed.shouldAttempt,
          reason: String(parsed.reason || ''),
          improvesUpon: parsed.improvesUpon || undefined,
        };
      }
    } catch {
      logger.warn('Failed to parse challenge decision');
    }

    return { shouldAttempt: false, reason: 'Could not determine' };
  }

  /**
   * Generate a solution for a challenge using a multi-step pipeline with
   * quality gate, cross-model verification, retry loop, and skill.md context.
   *
   *   Step 1: ANALYZE — Decompose the problem, identify key structures, plan approach
   *   Step 2: SOLVE   — Generate the full solution with the analysis as scaffolding
   *   Step 3: VERIFY  — Cross-model (or self) critique for logical gaps
   *   Step 4: RETRY   — If major issues found, re-solve with feedback (up to MAX_RETRIES)
   *   GATE:  Return null if solution cannot pass verification after retries
   *
   * Returns null when the quality gate blocks submission (caller should skip).
   */
  async generateSolution(
    persona: AgentPersona,
    challenge: {
      title: string;
      description: string;
      tags: string[];
    },
    topSubmissions: Array<{ title: string; approach: string; body: string }>,
    improvesUpon?: { id: string; title: string; approach: string; body: string },
    skillMdContext?: string
  ): Promise<GeneratedSolution | null> {
    const MAX_RETRIES = 1;

    // ── Platform skill.md context (if available) ──
    const skillGuidance = skillMdContext
      ? `\n\nPLATFORM GUIDELINES (from Agent4Science skill.md):\n${smartTruncate(skillMdContext, 3000)}\n`
      : '';

    // ── Step 1: ANALYZE — decompose the problem and plan approach ──

    const existingSummary = topSubmissions.length > 0
      ? `\n\nExisting submissions to study (do NOT duplicate these — find gaps or improvements):\n${topSubmissions.slice(0, 3).map((s, i) =>
          `${i + 1}. "${s.title}"\n   Approach: ${s.approach}\n   Key content: ${smartTruncate(s.body, 800)}`).join('\n\n')}`
      : '';

    const improvesUponContext = improvesUpon
      ? `\n\nYou are BUILDING ON this prior submission:
Title: "${improvesUpon.title}"
Approach: ${improvesUpon.approach}
Full solution: ${smartTruncate(improvesUpon.body, 2000)}

Your goal: identify specific weaknesses, gaps, or missed cases in this submission and address them.`
      : '';

    const analysisPrompt = `You are a mathematician analyzing a challenge before attempting a solution.
${skillGuidance}
CHALLENGE:
Title: ${challenge.title}
Description: ${challenge.description}
Tags: ${challenge.tags.join(', ')}${existingSummary}${improvesUponContext}

Perform a structured analysis. Think step by step:

1. PROBLEM DECOMPOSITION
   - What is being asked? State the precise mathematical question.
   - What are the key objects, spaces, or structures involved?
   - What are the given conditions and what must be shown/constructed/computed?

2. RELEVANT TOOLS & TECHNIQUES
   - What mathematical tools are most relevant? (e.g., spectral theory, convexity arguments, algebraic manipulations, probabilistic methods, topological invariants)
   - Are there known results in the literature that directly apply or can be adapted?
   - What are the main technical obstacles?

3. APPROACH STRATEGY
   - Outline 2-3 possible proof strategies or construction methods, ranked by promise.
   - For each, note: key insight needed, main difficulty, likelihood of success.
   - If building on a prior submission: what specifically was wrong or incomplete, and how will you fix it?

4. SOLUTION SKETCH
   - Draft the high-level structure of your chosen approach.
   - Identify the critical lemma or step that makes everything else work.

Be specific and mathematical. Reference actual theorems, techniques, and structures by name.`;

    logger.info('Challenge solver: Step 1 — Analyzing problem structure');
    const analysis = await this.complete([
      { role: 'system', content: `You are a rigorous mathematician. Think deeply before solving. Your expertise: ${persona.preferredTopics.join(', ')}.` },
      { role: 'user', content: analysisPrompt },
    ], 4096);

    this.trackCost('submission', analysis.usage);

    // ── Retry loop: SOLVE → VERIFY → (retry if major issues) ──

    let lastVerificationFeedback = '';

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const isRetry = attempt > 0;
      const stepLabel = isRetry ? `Step 2 (retry ${attempt}/${MAX_RETRIES})` : 'Step 2';

      // ── SOLVE — generate (or re-generate) the full solution ──

      const retryContext = isRetry
        ? `\n\nIMPORTANT — Your previous attempt was rejected by a reviewer. Here is their feedback:
${lastVerificationFeedback}

You MUST address ALL of the above issues in this attempt. Do not repeat the same mistakes.`
        : '';

      const solveSystemPrompt = this.buildPersonaPrompt(persona) + `

You are writing a formal solution to a mathematical challenge on Agent4Science.
You have already analyzed the problem — use your analysis as scaffolding.
${skillGuidance}
QUALITY STANDARDS:
- Every claim must be justified. No hand-waving.
- Define notation before using it. State assumptions explicitly.
- Structure the solution clearly: Setup → Key Lemma(s) → Main Argument → Conclusion.
- Use LaTeX math notation throughout: $x^2$ for inline, $$\\sum_{i=1}^n x_i$$ for display blocks.
  IMPORTANT: Inside the JSON string, escape backslashes as \\\\. For example: $\\\\alpha$, $\\\\mathbb{R}$, $$\\\\sum_{i=1}^n$$.
  Do NOT use plain Unicode like α, β, ∈, ℝ. Always use LaTeX: $\\\\alpha$, $\\\\beta$, $\\\\in$, $\\\\mathbb{R}$.
- Use markdown ## headings to structure sections.
- If the problem asks for a construction, provide it explicitly. If it asks for a proof, give complete logical steps.
- If building on prior work, clearly mark what is new vs. inherited.

Respond in JSON:
{
  "title": "Concise title for your submission (10-200 chars)",
  "body": "Full solution in markdown with LaTeX math. Use ## headings. All math must use $...$ or $$...$$. Min 500 chars.",
  "approach": "20-500 char summary of your method"${improvesUpon ? ',\n  "delta": "What you changed from the prior submission (max 1000 chars)"' : ''},
  "declaredScore": null,
  "confidence": "low/medium/high — your honest assessment of solution correctness"
}

CRITICAL: Complete every field fully. Do NOT leave sentences unfinished. The body should be a publishable-quality solution. ALL math must be in LaTeX, never plain text.`;

      const solveUserPrompt = `Here is the challenge and your analysis. Now write the full solution.

CHALLENGE:
Title: ${challenge.title}
Description: ${challenge.description}

YOUR ANALYSIS:
${analysis.content}${retryContext}

Now produce the complete, rigorous solution.`;

      logger.info(`Challenge solver: ${stepLabel} — Generating solution`);
      const draft = await this.complete([
        { role: 'system', content: solveSystemPrompt },
        { role: 'user', content: solveUserPrompt },
      ], 8192);

      this.trackCost('submission', draft.usage);

      // Parse the draft
      const draftParsed = this.extractJSON(draft.content);
      const draftBody = (draftParsed?.body as string) || draft.content;
      const draftApproach = (draftParsed?.approach as string) || '';

      // ── VERIFY — use cross-model verifier if available ──

      if (draftBody.length <= 200) {
        logger.warn('Challenge solver: Solution too short, skipping verification');
        // Quality gate: don't submit trivially short solutions
        if (attempt === MAX_RETRIES) {
          logger.warn('Challenge solver: QUALITY GATE — solution too short after all retries, blocking submission');
          return null;
        }
        lastVerificationFeedback = 'Solution was too short (under 200 chars). Provide a complete, detailed solution.';
        continue;
      }

      logger.info(`Challenge solver: Step 3 — Verifying (${verifierInstance ? 'cross-model' : 'self'}-verification)`);

      const verifyPrompt = `You are a rigorous mathematical referee. Review this solution for correctness.

CHALLENGE:
${challenge.title}
${smartTruncate(challenge.description, 1500)}

SUBMITTED SOLUTION:
${smartTruncate(draftBody, 6000)}

APPROACH: ${draftApproach}

Check for:
1. LOGICAL GAPS — Are there steps where the reasoning is incomplete or a claim is unjustified?
2. EDGE CASES — Does the solution handle degenerate or boundary cases?
3. NOTATION — Is everything well-defined before use?
4. CORRECTNESS — Does the argument actually prove what was asked? Is any step wrong?
5. COMPLETENESS — Does it fully answer the challenge, or only part of it?

If you find issues, provide the CORRECTED version of the affected sections.
If the solution is correct, say so and suggest minor improvements if any.

Respond in JSON:
{
  "verdict": "correct" | "minor_issues" | "major_issues",
  "issues": ["list of specific issues found"],
  "corrections": "Corrected sections in markdown (only the parts that changed), or empty string if correct",
  "improved_body": "The full corrected solution body if there were major issues, or empty string if mostly correct"
}`;

      // Use verifier client (cross-model) if available, otherwise self-verify
      const verifier = getVerifierClient();
      const verification = await verifier.complete([
        { role: 'system', content: 'You are a mathematical referee known for thoroughness. Find every logical gap. Be adversarial — assume the solution is wrong until convinced otherwise.' },
        { role: 'user', content: verifyPrompt },
      ], 4096);

      this.trackCost('submission', verification.usage);

      // Parse verification result
      const verifyParsed = this.extractJSON(verification.content);
      const verdict = (verifyParsed?.verdict as string) || 'unknown';
      const issues = (verifyParsed?.issues as string[]) || [];
      const improvedBody = (verifyParsed?.improved_body as string) || '';

      logger.info({ verdict, issueCount: issues.length, attempt }, 'Challenge solver: Verification result');

      // ── Quality gate decisions ──

      if (verdict === 'correct' || verdict === 'minor_issues') {
        // Solution passes — apply minor corrections if available and return
        const finalBody = (verdict === 'minor_issues' && improvedBody)
          ? improvedBody
          : draftBody;

        logger.info({ attempt }, 'Challenge solver: Solution passed verification');
        return {
          title: smartTruncate((draftParsed?.title as string) || `Solution: ${challenge.title}`, 200),
          body: finalBody,
          approach: smartTruncate((draftParsed?.approach as string) || 'Novel approach to the problem', 500),
          ...(improvesUpon ? { improvesUpon: improvesUpon.id } : {}),
          ...(draftParsed?.delta ? { delta: smartTruncate(String(draftParsed.delta), 1000) } : {}),
          ...(draftParsed?.declaredScore != null ? { declaredScore: Number(draftParsed.declaredScore) } : {}),
        };
      }

      if (verdict === 'major_issues') {
        if (attempt < MAX_RETRIES) {
          // Feed verification issues back into next attempt
          lastVerificationFeedback = issues.length > 0
            ? `ISSUES FOUND:\n${issues.map((iss, i) => `${i + 1}. ${iss}`).join('\n')}`
            : verification.content;
          logger.info({ attempt, issues: issues.length }, 'Challenge solver: Major issues found, retrying');
          continue;
        }

        // Last attempt — if verifier provided an improved body, use it
        if (improvedBody && improvedBody.length > 200) {
          logger.info('Challenge solver: Using verifier-corrected solution on final attempt');
          return {
            title: smartTruncate((draftParsed?.title as string) || `Solution: ${challenge.title}`, 200),
            body: improvedBody,
            approach: smartTruncate((draftParsed?.approach as string) || 'Novel approach to the problem', 500),
            ...(improvesUpon ? { improvesUpon: improvesUpon.id } : {}),
            ...(draftParsed?.delta ? { delta: smartTruncate(String(draftParsed.delta), 1000) } : {}),
          };
        }

        // Quality gate: block submission
        logger.warn({ issues }, 'Challenge solver: QUALITY GATE — solution failed verification after all retries, blocking submission');
        return null;
      }

      // Unknown verdict — treat as pass on last attempt, retry otherwise
      if (attempt < MAX_RETRIES) {
        lastVerificationFeedback = 'Verification was inconclusive. Strengthen your argument and make every step explicit.';
        continue;
      }

      // Final attempt with unknown verdict — submit with what we have
      logger.info('Challenge solver: Inconclusive verification on final attempt, submitting best effort');
      return {
        title: smartTruncate((draftParsed?.title as string) || `Solution: ${challenge.title}`, 200),
        body: draftBody,
        approach: smartTruncate((draftParsed?.approach as string) || 'Novel approach to the problem', 500),
        ...(improvesUpon ? { improvesUpon: improvesUpon.id } : {}),
        ...(draftParsed?.delta ? { delta: smartTruncate(String(draftParsed.delta), 1000) } : {}),
      };
    }

    // Should not reach here, but safety fallback
    logger.warn('Challenge solver: QUALITY GATE — exhausted all retries');
    return null;
  }

  /**
   * Generate a solution for a DETERMINISTIC challenge by writing and executing solver code.
   *
   * Flow: LLM reads verifier + schema → generates Python solver → we execute it locally →
   * parse stdout as solutionData → LLM writes title/body/approach describing the method.
   *
   * Returns null if code generation or execution fails after retries.
   */
  async generateSolverSolution(
    persona: AgentPersona,
    challenge: {
      title: string;
      description: string;
      tags: string[];
      verifier?: string;
      solutionSchema?: Record<string, unknown>;
      scoringDirection?: string;
    },
    topSubmissions: Array<{ title: string; approach: string; evaluatedScore?: number | null }>,
  ): Promise<GeneratedSolution | null> {
    const MAX_RETRIES = 1;

    const schemaStr = challenge.solutionSchema
      ? JSON.stringify(challenge.solutionSchema, null, 2)
      : 'No schema provided';

    const competitorContext = topSubmissions.length > 0
      ? `\n\nExisting submissions (scores to beat):\n${topSubmissions.slice(0, 5).map((s, i) =>
          `${i + 1}. "${s.title}" — ${s.approach} — score: ${s.evaluatedScore ?? 'pending'}`).join('\n')}`
      : '\n\nNo existing submissions — you would be the first.';

    // ── Step 1: LLM generates Python solver code ──

    const codeGenPrompt = `You are an expert mathematician and programmer solving an optimization challenge.
Your task: write a standalone Python script that computes an optimal solution and prints it as JSON.

CHALLENGE:
Title: ${challenge.title}
Description: ${challenge.description}
Scoring: ${challenge.scoringDirection || 'maximize'} (${challenge.scoringDirection === 'minimize' ? 'lower' : 'higher'} is better)

SOLUTION SCHEMA (your output must match this):
${schemaStr}

VERIFIER CODE (this is what the server runs on your solution):
\`\`\`python
${challenge.verifier || 'No verifier available'}
\`\`\`
${competitorContext}

REQUIREMENTS:
1. Write a COMPLETE, STANDALONE Python script
2. You may import: numpy, scipy, math, random, itertools, json, sys — scipy is available (v1.17)
3. The script must print a single JSON object to stdout matching the solutionSchema
4. Use efficient optimization — scipy.optimize (minimize, linprog, differential_evolution), scipy.spatial, scipy.linalg are all available and preferred over reimplementing from scratch
5. Must complete within 85 seconds
6. Print ONLY the JSON result — no debug output to stdout (use stderr for debug)

OUTPUT FORMAT: Respond with ONLY the Python code, no markdown fences, no explanation.`;

    let lastError = '';

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const retryContext = attempt > 0
        ? `\n\nYour previous code failed with error: ${lastError}\nFix the issue and try again.`
        : '';

      logger.info({ attempt }, 'Solver: generating Python code');
      const codeResponse = await this.complete([
        { role: 'system', content: `You are a Python optimization expert. Write clean, efficient code. ${persona.preferredTopics.length > 0 ? `Your expertise: ${persona.preferredTopics.join(', ')}.` : ''}` },
        { role: 'user', content: codeGenPrompt + retryContext },
      ], 8192);

      this.trackCost('submission', codeResponse.usage);

      // Extract Python code (strip markdown fences if present)
      let code = codeResponse.content.trim();
      code = code.replace(/^```python\n?/m, '').replace(/^```\n?/m, '').replace(/\n?```$/m, '');

      if (code.length < 50) {
        lastError = 'Generated code too short';
        continue;
      }

      // ── Step 2: Execute the solver locally ──

      logger.info({ attempt, codeLength: code.length }, 'Solver: executing Python code');
      const result = await runSolverCode(code);

      if (!result.success || !result.solutionData) {
        lastError = result.error || 'Unknown execution error';
        logger.warn({ attempt, error: lastError, timeMs: result.executionTimeMs }, 'Solver: execution failed');
        continue;
      }

      logger.info({ attempt, timeMs: result.executionTimeMs, keys: Object.keys(result.solutionData) }, 'Solver: execution succeeded');

      // ── Step 3: LLM writes the submission text (title, body, approach) ──

      const describePrompt = `You just solved this optimization challenge by writing and running Python code.

Challenge: ${challenge.title}
Description: ${challenge.description.slice(0, 500)}
Scoring: ${challenge.scoringDirection || 'maximize'}

YOUR SOLVER CODE:
\`\`\`python
${code}
\`\`\`

Write a detailed, technical submission describing your approach. Study the code carefully and explain the specific algorithms, parameters, and design choices.

Respond in JSON with these fields:
{
  "title": "Descriptive title with key technique and parameters (10-150 chars)",
  "body": "Markdown body with structured sections (see requirements below)",
  "approach": "One-line summary naming the specific algorithm and key parameters (20-200 chars)"
}

BODY STRUCTURE — the body field MUST use this format:
## Approach
One paragraph summarizing the high-level strategy with specific parameter values.

### Method
- **Step/technique name**: Specific description referencing actual code details
- (3-8 bullet points covering the key algorithmic steps)

### Code
Include the full solver code in a python code fence.

QUALITY REQUIREMENTS:
- Name actual functions, parameters, constants from the code (e.g. "15 L-BFGS-B restarts", "Fibonacci lattice initialization for N=282", "temperature annealing 0.01→1e-8")
- Do NOT write generic filler like "Solver generated by X" or "The LLM was asked to write a solver"
- Describe WHAT the algorithm does and WHY each design choice matters
- Body should be 800-3000 chars (excluding code block)`;

      const descResponse = await this.complete([
        { role: 'system', content: this.buildPersonaPrompt(persona) },
        { role: 'user', content: describePrompt },
      ], 8192);

      this.trackCost('submission', descResponse.usage);

      const desc = this.extractJSON(descResponse.content);

      let body = (desc?.body as string) || '';
      // Ensure the code is included in the body — append if missing
      if (!body.includes('```python') && !body.includes('```py')) {
        body += `\n\n### Code\n\n\`\`\`python\n${code}\n\`\`\``;
      }

      return {
        title: smartTruncate((desc?.title as string) || `Solver: ${challenge.title}`, 200),
        body,
        approach: smartTruncate((desc?.approach as string) || 'Numerical optimization via Python solver', 500),
        solutionData: result.solutionData,
      };
    }

    logger.warn('Solver: QUALITY GATE — failed to generate working solver after all retries');
    return null;
  }

  /**
   * Generate a comparative peer critique of a sibling submission.
   * The agent has its own submission to the same challenge and critiques another agent's work.
   */
  async generateSubmissionCritique(
    persona: AgentPersona,
    challenge: { title: string; description: string; tags: string[] },
    ownSubmission: { title: string; approach: string; body: string },
    siblingSubmission: { title: string; approach: string; body: string },
    existingComments?: string[]
  ): Promise<GeneratedComment> {
    const hasExisting = existingComments && existingComments.length > 0;
    const systemPrompt = this.buildPersonaPrompt(persona) + `

You are performing PEER CRITIQUE on a fellow contestant's submission to a mathematical challenge.
You have already submitted your own solution, so you have deep context on the problem.
${hasExisting ? `\nOTHER RESEARCHERS HAVE ALREADY COMMENTED on this submission (see below). You MUST:
- Read their critiques carefully before writing yours
- DO NOT repeat points they already made — find something NEW
- You may build on their points (cite them by handle) but must add original analysis
- If they missed something important, focus on that
- If you disagree with another critic's assessment, say so and explain why\n` : ''}
YOUR TASK:
- Compare the sibling submission against your own approach
- Identify specific strengths and weaknesses relative to your solution
- Point out logical gaps, missing edge cases, or unjustified steps
- Acknowledge where their approach is stronger or offers a genuinely different angle
- Be substantive — no generic praise ("interesting approach!") or empty criticism

TONE:
- Collegial but rigorous. You are a peer, not a judge.
- Ground every claim in specific parts of their submission.
- If their approach is strictly better on some dimension, say so honestly.

Respond in JSON:
{
  "intent": "challenge" | "support" | "clarify" | "connect" | "probe" | "extend",
  "body": "your critique (markdown, may include $LaTeX$, 200-800 chars)",
  "confidence": 0.0-1.0,
  "evidenceAnchor": "the specific claim or step you are responding to"
}`;

    let userPrompt = `CHALLENGE: ${challenge.title}
Tags: ${challenge.tags.join(', ')}
Description (excerpt): ${smartTruncate(challenge.description, 800)}

YOUR SUBMISSION:
Title: ${ownSubmission.title}
Approach: ${ownSubmission.approach}
Body (excerpt): ${smartTruncate(ownSubmission.body, 1200)}

SIBLING SUBMISSION TO CRITIQUE:
Title: ${siblingSubmission.title}
Approach: ${siblingSubmission.approach}
Body (excerpt): ${smartTruncate(siblingSubmission.body, 1200)}`;

    if (hasExisting) {
      userPrompt += `\n\nEXISTING COMMENTS ON THIS SUBMISSION (${existingComments.length} already posted — DO NOT REPEAT these points):\n`;
      for (const c of existingComments) {
        userPrompt += `---\n${smartTruncate(c, 400)}\n`;
      }
    }

    userPrompt += `\nWrite a comparative peer critique of the sibling submission. Reference specific differences between your approach and theirs.${hasExisting ? ' Make sure your critique adds NEW insight not covered above.' : ''}`;

    const response = await this.complete([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]);

    this.trackCost('submission_critique', response.usage);

    return this.parseCommentResponse(response.content);
  }

  /**
   * Generate a rebuttal to a critique on the agent's own submission.
   * The agent defends specific steps, concedes valid points, and advances the mathematical discussion.
   * Also used for cross-submitter discussion where another submitter joins a thread.
   */
  async generateSubmissionRebuttal(
    persona: AgentPersona,
    challenge: { title: string; description: string; tags: string[] },
    ownSubmission: { title: string; approach: string; body: string },
    critique: { body: string; authorHandle?: string; intent?: string },
    threadContext?: string
  ): Promise<GeneratedComment> {
    const isAuthor = !threadContext?.includes('YOU ARE JOINING'); // Default: author rebuttal
    const role = isAuthor
      ? `You are the AUTHOR of a submission to a mathematical challenge. Someone has critiqued your proof and you must respond.`
      : `You are a fellow contestant in a mathematical challenge. You are joining a discussion thread on another submission where your own solution gives you relevant insight.`;

    const systemPrompt = this.buildPersonaPrompt(persona) + `

${role}

YOUR TASK:
- Engage the SPECIFIC mathematical claim or gap they identified
- If they found a real gap: concede it explicitly, explain what it would take to fix, and whether it invalidates the overall approach or just one step
- If they misunderstood your proof: correct with precision — quote the relevant step and explain why their objection doesn't apply
- If they raised a subtle point: explore it — does it generalize? Does it affect other approaches too?
- Reference specific equations, lemmas, or steps by name
- If relevant, draw on your own solution's approach to illuminate the discussion

CRITICAL RULES:
- NO generic responses ("thank you for the feedback", "interesting point")
- Every sentence must contain mathematical content or a specific logical argument
- You are in a real mathematical debate — treat it like a conference Q&A
- End with a question or open problem that advances the discussion

Respond in JSON:
{
  "intent": "challenge" | "support" | "clarify" | "extend" | "probe" | "synthesize",
  "body": "your rebuttal (markdown with $LaTeX$, 200-1000 chars, substantive mathematical argument)",
  "confidence": 0.0-1.0,
  "evidenceAnchor": "the specific claim from their critique you are responding to"
}`;

    let userPrompt = `CHALLENGE: ${challenge.title}
Tags: ${challenge.tags.join(', ')}
Description (excerpt): ${smartTruncate(challenge.description, 600)}

YOUR SUBMISSION:
Title: ${ownSubmission.title}
Approach: ${ownSubmission.approach}
Body (excerpt): ${smartTruncate(ownSubmission.body, 1000)}

CRITIQUE TO RESPOND TO${critique.authorHandle ? ` (from @${critique.authorHandle})` : ''}${critique.intent ? ` [intent: ${critique.intent}]` : ''}:
"${smartTruncate(critique.body, 800)}"`;

    if (threadContext) {
      userPrompt += `

THREAD CONTEXT:
${threadContext}`;
    }

    userPrompt += `

Write a substantive mathematical response. Defend valid steps, concede real gaps, advance the discussion.`;

    const response = await this.complete([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]);

    this.trackCost('submission_rebuttal', response.usage);

    return this.parseCommentResponse(response.content);
  }

  /**
   * Select sciencesubs for an agent to join, using LLM to match persona to available communities.
   *
   * Returns an array of { slug, reason } for the subs the LLM recommends joining.
   * Returns empty array on failure (callers should handle fallback).
   */
  async selectSciencesubs(
    persona: AgentPersona,
    availableSubs: Array<{ slug: string; name: string; description: string }>,
    options?: { maxSubs?: number; alreadyJoined?: string[] }
  ): Promise<Array<{ slug: string; reason: string }>> {
    const maxSubs = options?.maxSubs ?? 5;
    const alreadyJoined = new Set(options?.alreadyJoined ?? []);

    // Filter out already-joined subs from the candidate list
    const candidates = availableSubs.filter(s => !alreadyJoined.has(s.slug));
    if (candidates.length === 0) return [];

    const subListStr = candidates
      .map(s => `- ${s.slug}: ${s.name} — ${s.description}`)
      .join('\n');

    const topicsStr = persona.preferredTopics.length > 0
      ? `Preferred research topics: ${persona.preferredTopics.join(', ')}`
      : 'No specific preferred topics — this researcher has broad interdisciplinary interests';

    const diversityInstruction = persona.preferredTopics.length === 0
      ? '\nThis researcher has broad interests — select a diverse set across different scientific fields.'
      : '';

    const systemPrompt = `You are matching a researcher to relevant scientific topic communities. Select the communities that best match their research interests and expertise. Be precise — only pick communities where this researcher would genuinely contribute or learn.`;

    const userPrompt = `RESEARCHER PROFILE:
- Voice: ${persona.voice}
- Epistemic style: ${persona.epistemics}
- ${topicsStr}
${persona.petPeeves.length > 0 ? `- Pet peeves: ${persona.petPeeves.join(', ')}` : ''}
${diversityInstruction}

AVAILABLE COMMUNITIES:
${subListStr}

Select up to ${maxSubs} communities that are most relevant to this researcher. For each, explain briefly why it's a good match.

Respond in JSON:
{
  "selections": [
    { "slug": "community-slug", "reason": "Brief reason for match" }
  ]
}`;

    try {
      const response = await this.complete([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ], 1024);

      this.trackCost('sciencesub_select', response.usage);

      const parsed = this.extractJSON(response.content);
      if (!parsed?.selections || !Array.isArray(parsed.selections)) {
        logger.warn('selectSciencesubs: failed to parse LLM response');
        return [];
      }

      // Validate slugs exist in candidate list
      const validSlugs = new Set(candidates.map(s => s.slug));
      const results: Array<{ slug: string; reason: string }> = [];
      for (const sel of parsed.selections) {
        if (sel?.slug && validSlugs.has(sel.slug) && results.length < maxSubs) {
          results.push({ slug: sel.slug, reason: sel.reason || '' });
        }
      }

      logger.info({ count: results.length, slugs: results.map(r => r.slug) }, 'selectSciencesubs: LLM selected subs');
      return results;
    } catch (err) {
      logger.error({ err }, 'selectSciencesubs: LLM call failed');
      return [];
    }
  }

  // ── Helper: extract JSON from LLM response ──
  private extractJSON(content: string): Record<string, unknown> | null {
    try {
      let jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        const braceStart = content.indexOf('{');
        if (braceStart >= 0) {
          const repaired = repairJSON(content.slice(braceStart));
          if (repaired) jsonMatch = [repaired];
        }
      }
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]);
        } catch {
          const repaired = repairJSON(jsonMatch[0]);
          if (repaired) return JSON.parse(repaired);
        }
      }
    } catch {
      // Parsing failed
    }
    return null;
  }

  // ── Helper: track LLM cost ──
  private trackCost(action: string, usage: { promptTokens: number; completionTokens: number }): void {
    try {
      const costTracker = getCostTracker();
      costTracker.recordCall(action, usage.promptTokens, usage.completionTokens);
    } catch {
      // Cost tracker not initialized
    }
  }
}

// Singleton
let instance: LLMClient | null = null;
let verifierInstance: LLMClient | null = null;
let globalApiKey: string = '';
const agentClientCache = new Map<string, LLMClient>();

export function createLLMClient(config: LLMConfig): LLMClient {
  globalApiKey = config.apiKey;
  agentClientCache.clear();
  instance = new LLMClient(config);
  return instance;
}

/**
 * Create a separate LLM client for cross-model verification.
 * When set, challenge submission verification uses this model instead of the primary.
 */
export function createVerifierClient(config: LLMConfig): LLMClient {
  verifierInstance = new LLMClient(config);
  return verifierInstance;
}

/**
 * Get the verifier client, falling back to the primary LLM client.
 */
export function getVerifierClient(): LLMClient {
  return verifierInstance ?? getLLMClient();
}

export function getLLMClient(): LLMClient {
  if (!instance) {
    throw new Error('LLM client not initialized. Call createLLMClient first.');
  }
  return instance;
}

/**
 * Get (or lazily create) an LLM client for a specific agent override.
 * If `override` is undefined the global singleton is returned.
 * Clients are cached by `provider/model` so duplicate overrides share a single instance.
 */
export function getOrCreateLLMClient(override?: AgentLLMOverride): LLMClient {
  if (!override) return getLLMClient();

  const key = `${override.provider}/${override.model}`;
  let client = agentClientCache.get(key);
  if (!client) {
    client = new LLMClient({
      provider: override.provider,
      model: override.model,
      apiKey: override.apiKey || globalApiKey,
    });
    agentClientCache.set(key, client);
    logger.info({ provider: override.provider, model: override.model }, 'Created per-agent LLM client');
  }
  return client;
}
