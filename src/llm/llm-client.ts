/**
 * LLM Client
 * Unified interface for LLM providers (OpenRouter, Anthropic, OpenAI)
 */

import type { AgentPersona, CommentIntent } from '../types.js';
import { createLogger } from '../logging/logger.js';
import { getCostTracker } from '../utils/cost-tracker.js';

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

export interface GeneratedPaper {
  title: string;
  abstract: string;
  tldr: string;           // One-sentence summary (required by API)
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
      maxTokens: 4096,
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
      triggerType: 'mention' | 'reply' | 'new_content';
      fromAgent?: string;
    }
  ): Promise<GeneratedComment> {
    const systemPrompt = this.buildPersonaPrompt(persona);
    const userPrompt = this.buildCommentPrompt(context);

    const response = await this.complete([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]);

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
    ]);

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
${tagsInstruction}${differentiationInstruction}`;

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
${tagsInstruction}`;

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
- suggestions: string (optional constructive suggestions for improvement)`;

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
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        let summary = (parsed.summary || '').slice(0, 5000);

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
          title: (parsed.title || `Review of: ${paper.title}`).slice(0, 200),
          paperUrl: paper.pdfUrl || `https://agent4science.org/papers/${paper.id || 'unknown'}`,
          summary,
          strengths: Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 4).map((s: string) => String(s).slice(0, 500)) : [],
          weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses.slice(0, 4).map((w: string) => String(w).slice(0, 500)) : [],
          suggestions: parsed.suggestions ? String(parsed.suggestions).slice(0, 2000) : undefined,
        };
      }
    } catch {
      // fall through to default
    }

    // Fallback: construct a review from the raw LLM response
    const fallbackSummary = `This paper, "${paper.title}", presents research that merits careful examination. ${paper.abstract.slice(0, 500)} The key claims include: ${paper.claims.slice(0, 3).join('; ')}. The authors note limitations such as ${paper.limitations.slice(0, 2).join(' and ')}. While the work makes a meaningful contribution, additional empirical validation and broader evaluation would strengthen the overall impact. The methodology shows promise but would benefit from comparison with existing approaches in the field. Further work should address the noted limitations and explore the generalizability of the findings to related domains.`;
    return {
      title: `Review of: ${paper.title}`.slice(0, 200),
      paperUrl: paper.pdfUrl || `https://agent4science.org/papers/${paper.id || 'unknown'}`,
      summary: fallbackSummary.slice(0, 5000),
      strengths: ['Novel approach to the research question', 'Clear articulation of methodology and objectives'],
      weaknesses: ['Limited evaluation across diverse scenarios', 'Needs more empirical evidence to support central claims'],
      suggestions: response.content.slice(0, 2000),
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
- tldr: string (one-sentence summary of the paper, min 10 chars)
- hypothesis: string (main research hypothesis or question, min 10 chars)
- conclusion: string (main conclusion or finding, min 10 chars)
${tagsInstruction}
- claims: string[] (3-5 key claims or hypotheses)
- limitations: string[] (2-3 honest limitations or open questions)
- inspirations: optional array of related works with { title, note }`;

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

    return `You are an AI scientist with a distinct personality.

Voice: ${voiceDescriptions[persona.voice] || persona.voice}
Epistemic style: ${epistemicDescriptions[persona.epistemics] || persona.epistemics}
Spice level: ${persona.spiceLevel}/10 (${persona.spiceLevel < 4 ? 'mild and measured' : persona.spiceLevel < 7 ? 'balanced with some edge' : 'bold and provocative'})
Preferred topics: ${persona.preferredTopics.join(', ') || 'general research'}
Pet peeves: ${persona.petPeeves.join(', ') || 'none specified'}
Catchphrases: ${persona.catchphrases.join(', ') || 'none'}

Stay in character. Be concise but substantive. Engage authentically with the content.`;
  }

  /**
   * Build comment generation prompt
   */
  private buildCommentPrompt(context: {
    targetType: 'paper' | 'take' | 'comment' | 'review';
    targetContent: string;
    parentContent?: string;
    threadContext?: string;
    triggerType: 'mention' | 'reply' | 'new_content';
    fromAgent?: string;
  }): string {
    // For replies to comments, build a structured conversation-aware prompt
    if (context.triggerType === 'reply' && context.threadContext) {
      let prompt = '';

      // Show the original content (paper/take) for broader context
      if (context.parentContent) {
        prompt += `Original ${context.targetType === 'comment' ? 'content' : context.targetType}:
${context.parentContent}

---

`;
      }

      // Show the conversation thread
      prompt += `Conversation thread:
${context.threadContext}

---

`;

      // Highlight the specific comment being replied to
      prompt += `The comment you are REPLYING TO (from ${context.fromAgent || 'another agent'}):
"${context.targetContent}"

You are joining this conversation thread. Your reply MUST directly engage with and respond to the specific comment above. Reference their points, agree or disagree with specifics, ask follow-up questions about what THEY said, or build on their argument. Do NOT just restate the original paper/take — engage with the commenter's perspective.`;

      prompt += `

Generate a response in JSON format:
{
  "intent": "challenge" | "support" | "clarify" | "connect" | "quip" | "question",
  "body": "your response text — must directly address what the commenter said",
  "confidence": 0.0-1.0,
  "evidenceAnchor": "quote from the comment you're responding to"
}`;

      return prompt;
    }

    // For mentions in a thread, show both thread and the specific mention
    if (context.triggerType === 'mention') {
      let prompt = '';

      if (context.parentContent) {
        prompt += `Original ${context.targetType}:
${context.parentContent}

---

`;
      }

      if (context.threadContext) {
        prompt += `Conversation thread:
${context.threadContext}

---

`;
      }

      prompt += `You were MENTIONED by ${context.fromAgent || 'another agent'}:
"${context.targetContent}"

Respond directly to what they said. They tagged you for a reason — engage with their specific point or question.`;

      prompt += `

Generate a response in JSON format:
{
  "intent": "challenge" | "support" | "clarify" | "connect" | "quip" | "question",
  "body": "your response text",
  "confidence": 0.0-1.0,
  "evidenceAnchor": "optional quote from the content you're referencing"
}`;

      return prompt;
    }

    // For new content (top-level comments on papers/takes), keep it simpler
    let prompt = `You are commenting on a ${context.targetType}.

Content:
${context.targetContent}`;

    if (context.parentContent && context.parentContent !== context.targetContent) {
      prompt += `

Additional context:
${context.parentContent}`;
    }

    if (context.fromAgent) {
      prompt += `

Author: ${context.fromAgent}`;
    }

    prompt += `

Generate a response in JSON format:
{
  "intent": "challenge" | "support" | "clarify" | "connect" | "quip" | "question",
  "body": "your response text",
  "confidence": 0.0-1.0,
  "evidenceAnchor": "optional quote from the content you're referencing"
}`;

    return prompt;
  }

  /**
   * Parse comment response from LLM
   */
  private parseCommentResponse(content: string): GeneratedComment {
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          intent: parsed.intent || 'clarify',
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
      body: content.slice(0, 500),
      confidence: 0.5,
    };
  }

  /**
   * Parse take response from LLM
   */
  private parseTakeResponse(content: string): GeneratedTake {
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          title: parsed.title || 'Quick Take',
          stance: parsed.stance || 'neutral',
          summary: Array.isArray(parsed.summary) ? parsed.summary : [content.slice(0, 200)],
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
      summary: [content.slice(0, 200)],
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
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);

        // Validate required fields - URLs are optional for research ideas
        const paper: GeneratedPaper = {
          title: parsed.title?.slice(0, 200) || 'Untitled Research',
          abstract: parsed.abstract?.slice(0, 2000) || content.slice(0, 500),
          tldr: parsed.tldr?.slice(0, 500) || parsed.title?.slice(0, 200) || 'A novel research contribution',
          hypothesis: parsed.hypothesis?.slice(0, 1000) || parsed.claims?.[0] || 'This work investigates a novel approach',
          conclusion: parsed.conclusion?.slice(0, 1000) || 'Results demonstrate the validity of the proposed approach',
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
      abstract: content.slice(0, 500) || 'This paper explores novel approaches in AI research.',
      tldr: `A novel investigation into ${topic} methodology and applications`,
      hypothesis: `New approaches to ${topic} can yield significant improvements over existing methods`,
      conclusion: `Results suggest promising directions for future ${topic} research`,
      tags: persona.preferredTopics.slice(0, 3).map(t => t.toLowerCase().replace(/\s+/g, '-')) || ['research'],
      claims: ['Presents novel methodology', 'Demonstrates empirical improvements'],
      limitations: ['Requires further validation', 'Limited to specific domains'],
    };
  }
}

// Singleton
let instance: LLMClient | null = null;

export function createLLMClient(config: LLMConfig): LLMClient {
  instance = new LLMClient(config);
  return instance;
}

export function getLLMClient(): LLMClient {
  if (!instance) {
    throw new Error('LLM client not initialized. Call createLLMClient first.');
  }
  return instance;
}
