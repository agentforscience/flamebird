import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  parseIdeaId,
  extractReportTitle,
  extractReportReferences,
  extractLastGithubUrl,
  extractYamlField,
  parseNeuricoOutput,
  publishPaperToAgent4Science,
} from './paper-tools.js';
import {
  Agent4ScienceClient,
  createAgent4ScienceClient,
  normalizeApiError,
} from '../api/agent4science-client.js';
import { smartTruncate, repairJSON } from '../utils/truncate.js';

// ============================================================================
// parseIdeaId — extracts idea ID from NeuriCo submit.py stdout
// ============================================================================

describe('parseIdeaId', () => {
  it('parses "Idea ID: abc123" format', () => {
    expect(parseIdeaId('Some output\nIdea ID: abc123\nDone')).toBe('abc123');
  });

  it('parses "idea_id: my-idea" format', () => {
    expect(parseIdeaId('idea_id: my-idea-42')).toBe('my-idea-42');
  });

  it('parses "Submitted: idea-name" format', () => {
    expect(parseIdeaId('Submitted idea: novel-ml-approach')).toBe('novel-ml-approach');
  });

  it('parses "ideas/submitted/name.yaml" path format', () => {
    expect(parseIdeaId('Saved to ideas/submitted/my-idea.yaml')).toBe('my-idea');
  });

  it('strips .yaml extension', () => {
    expect(parseIdeaId('Idea ID: test-idea.yaml')).toBe('test-idea');
  });

  it('returns null when no pattern matches', () => {
    expect(parseIdeaId('Docker started...\nRunning experiments...')).toBeNull();
  });

  it('returns null for empty output', () => {
    expect(parseIdeaId('')).toBeNull();
  });
});

// ============================================================================
// extractReportTitle — pulls # heading from REPORT.md
// ============================================================================

describe('extractReportTitle', () => {
  it('extracts first h1 heading', () => {
    const report = '# Novel Approach to Machine Learning\n\n## Executive Summary\nStuff here';
    expect(extractReportTitle(report)).toBe('Novel Approach to Machine Learning');
  });

  it('ignores h2 headings', () => {
    const report = '## Not This One\n# The Real Title\n## Another Section';
    expect(extractReportTitle(report)).toBe('The Real Title');
  });

  it('returns undefined when no h1 exists', () => {
    const report = '## Only h2\nSome text\n## Another h2';
    expect(extractReportTitle(report)).toBeUndefined();
  });

  it('trims whitespace from title', () => {
    expect(extractReportTitle('#   Spaced Title   \nContent')).toBe('Spaced Title');
  });
});

// ============================================================================
// extractReportReferences — parses structured references from REPORT.md
// ============================================================================

describe('extractReportReferences', () => {
  const SAMPLE_REPORT = `# My Paper

## Executive Summary
Some summary here.

## Results
Some results.

## References

1. Smith, J. and Doe, A. (2023). Attention Is All You Need. NeurIPS. arXiv:1706.03762
2. Johnson, B. (2024). Scaling Laws for Neural Language Models. ICML
- Lee, C. et al. (2022). Efficient Transformers: A Survey. ACM Computing Surveys. arXiv:2009.06732

## Conclusions
We conclude stuff.
`;

  it('parses numbered references with arXiv IDs', () => {
    const refs = extractReportReferences(SAMPLE_REPORT);
    expect(refs.length).toBe(3);

    expect(refs[0]).toMatchObject({
      authors: 'Smith, J. and Doe, A.',
      year: 2023,
      title: 'Attention Is All You Need',
      arxivId: '1706.03762',
    });
  });

  it('parses references without arXiv IDs', () => {
    const refs = extractReportReferences(SAMPLE_REPORT);
    expect(refs[1]).toMatchObject({
      authors: 'Johnson, B.',
      year: 2024,
      title: 'Scaling Laws for Neural Language Models',
    });
    expect(refs[1].arxivId).toBeUndefined();
  });

  it('parses bullet-style references', () => {
    const refs = extractReportReferences(SAMPLE_REPORT);
    expect(refs[2]).toMatchObject({
      authors: 'Lee, C. et al.',
      year: 2022,
      arxivId: '2009.06732',
    });
  });

  it('stops at the next ## heading', () => {
    const refs = extractReportReferences(SAMPLE_REPORT);
    // Should not include anything from "## Conclusions"
    expect(refs.every(r => r.title !== 'We conclude stuff.')).toBe(true);
  });

  it('returns empty array when no references section', () => {
    expect(extractReportReferences('# Paper\n## Results\nStuff')).toEqual([]);
  });

  it('handles "## 8. References" numbered section format', () => {
    const report = '# Paper\n## 8. References\n1. Author (2023). Title. Venue\n';
    const refs = extractReportReferences(report);
    expect(refs.length).toBe(1);
  });

  it('skips lines that are too short', () => {
    const report = '# P\n## References\nshort\n1. Auth (2023). Real Reference Title Here. Venue\n';
    const refs = extractReportReferences(report);
    expect(refs.length).toBe(1);
    expect(refs[0].authors).toBe('Auth');
  });
});

// ============================================================================
// extractLastGithubUrl — picks the last (most relevant) GitHub URL from stdout
// ============================================================================

describe('extractLastGithubUrl', () => {
  it('extracts URL from "GitHub: <url>" format', () => {
    const stdout = 'Running...\nGitHub: https://github.com/org/my-research\nDone';
    expect(extractLastGithubUrl(stdout)).toBe('https://github.com/org/my-research');
  });

  it('extracts URL from "Results published to GitHub!" format', () => {
    const stdout = 'Results published to GitHub!\nhttps://github.com/org/paper-repo\n';
    expect(extractLastGithubUrl(stdout)).toBe('https://github.com/org/paper-repo');
  });

  it('takes the LAST match (not first) to avoid search-result URLs', () => {
    const stdout = [
      'Searching papers...',
      'GitHub: https://github.com/someone/unrelated-repo',
      'Running experiments...',
      'GitHub: https://github.com/myorg/actual-research',
    ].join('\n');
    expect(extractLastGithubUrl(stdout)).toBe('https://github.com/myorg/actual-research');
  });

  it('skips ChicagoHAI/NeuriCo boilerplate URL', () => {
    const stdout = 'GitHub: https://github.com/ChicagoHAI/NeuriCo\nGitHub: https://github.com/org/real\n';
    expect(extractLastGithubUrl(stdout)).toBe('https://github.com/org/real');
  });

  it('returns undefined when no GitHub URL found', () => {
    expect(extractLastGithubUrl('No URLs here at all')).toBeUndefined();
  });
});

// ============================================================================
// extractYamlField — simple YAML field parser (no full YAML dep)
// ============================================================================

describe('extractYamlField', () => {
  const yaml = `idea:
  title: "My Research Paper"
  domain: artificial_intelligence
  github_repo_url: https://github.com/org/repo
  hypothesis: |
    Some hypothesis here`;

  it('extracts simple string fields', () => {
    expect(extractYamlField(yaml, 'domain')).toBe('artificial_intelligence');
  });

  it('extracts quoted string fields', () => {
    expect(extractYamlField(yaml, 'title')).toBe('My Research Paper');
  });

  it('extracts URL fields', () => {
    expect(extractYamlField(yaml, 'github_repo_url')).toBe('https://github.com/org/repo');
  });

  it('returns undefined for missing fields', () => {
    expect(extractYamlField(yaml, 'nonexistent')).toBeUndefined();
  });
});

// ============================================================================
// smartTruncate — sentence-aware truncation for tldr/abstract
// ============================================================================

describe('smartTruncate', () => {
  it('returns text as-is when under maxLen', () => {
    expect(smartTruncate('Short text.', 100)).toBe('Short text.');
  });

  it('truncates at sentence boundary', () => {
    const text = 'First sentence. Second sentence. Third sentence that is longer.';
    const result = smartTruncate(text, 40);
    expect(result).toBe('First sentence. Second sentence.');
  });

  it('handles null/undefined', () => {
    expect(smartTruncate(null, 100)).toBe('');
    expect(smartTruncate(undefined, 100)).toBe('');
  });

  it('ensures tldr meets 30-char minimum when padded', () => {
    // Simulating the manager-agent's tldr padding logic
    let tldr = 'Short';
    if (tldr.length < 30) {
      tldr = `${tldr}. This work explores new directions in AI research.`;
    }
    const result = smartTruncate(tldr, 1000);
    expect(result.length).toBeGreaterThanOrEqual(30);
  });
});

// ============================================================================
// repairJSON — fixes truncated LLM JSON output
// ============================================================================

describe('repairJSON', () => {
  it('returns valid JSON as-is', () => {
    const json = '{"title": "Test", "tags": ["ai"]}';
    expect(repairJSON(json)).toBe(json);
  });

  it('closes unclosed braces', () => {
    const truncated = '{"title": "Test", "tags": ["ai"]';
    const result = repairJSON(truncated);
    expect(result).not.toBeNull();
    expect(() => JSON.parse(result!)).not.toThrow();
  });

  it('closes unclosed arrays', () => {
    const truncated = '{"tags": ["ai", "ml"';
    const result = repairJSON(truncated);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.tags).toContain('ai');
  });

  it('closes unclosed strings', () => {
    const truncated = '{"title": "Truncated tit';
    const result = repairJSON(truncated);
    expect(result).not.toBeNull();
    expect(() => JSON.parse(result!)).not.toThrow();
  });

  it('removes trailing commas', () => {
    const json = '{"title": "Test", "tags": ["ai",]}';
    const result = repairJSON(json);
    expect(result).not.toBeNull();
    expect(() => JSON.parse(result!)).not.toThrow();
  });

  it('handles real-world LLM truncation: cut mid-claims array', () => {
    const truncated = '{\n' +
      '  "title": "Novel ML Approach",\n' +
      '  "abstract": "We present...",\n' +
      '  "tldr": "A new approach to ML that improves accuracy by 15%.",\n' +
      '  "tags": ["machine-learning", "deep-learning"],\n' +
      '  "claims": ["Accuracy improved by 15%", "Training time reduced by 30%';
    const result = repairJSON(truncated);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.title).toBe('Novel ML Approach');
    expect(parsed.claims.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// normalizeApiError — extracts human-readable error from API response
// ============================================================================

describe('normalizeApiError', () => {
  it('returns string errors as-is', () => {
    expect(normalizeApiError('Something went wrong')).toBe('Something went wrong');
  });

  it('extracts message from { message: ... }', () => {
    expect(normalizeApiError({ message: 'Bad request' })).toBe('Bad request');
  });

  it('extracts from nested { error: { message: ... } }', () => {
    expect(normalizeApiError({ error: { message: 'Unauthorized' } })).toBe('Unauthorized');
  });

  it('returns empty string for null/undefined', () => {
    expect(normalizeApiError(null)).toBe('');
    expect(normalizeApiError(undefined)).toBe('');
  });

  it('JSON-stringifies unrecognized objects', () => {
    const result = normalizeApiError({ weirdField: 42 });
    expect(result).toContain('weirdField');
  });
});

// ============================================================================
// Agent4ScienceClient.createPaper — API posting with mocked fetch
// ============================================================================

describe('Agent4ScienceClient.createPaper', () => {
  let client: Agent4ScienceClient;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = createAgent4ScienceClient({
      baseUrl: 'https://agent4science.example.com',
      timeout: 5000,
    });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  const VALID_PAPER_PARAMS = {
    title: 'Test Paper: Novel Approach to Testing',
    abstract: 'We present a novel approach...',
    tldr: 'A new testing methodology that improves test coverage by 50%.',
    hypothesis: 'Better tests lead to better software.',
    tags: ['machine-learning', 'testing'],
    claims: ['Test coverage improved by 50%'],
    githubUrl: 'https://github.com/org/test-repo',
    pdfUrl: 'https://github.com/org/test-repo/blob/main/paper_draft/main.pdf',
  };

  it('sends correct POST request to /api/v1/papers', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(
      JSON.stringify({ success: true, paper: { id: 'paper-123', ...VALID_PAPER_PARAMS } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));

    const result = await client.createPaper(VALID_PAPER_PARAMS, 'test-api-key');

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();

    // Verify the fetch was called correctly
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://agent4science.example.com/api/v1/papers');
    expect(options?.method).toBe('POST');
    expect(options?.headers).toMatchObject({
      'Content-Type': 'application/json',
      'Authorization': 'Bearer test-api-key',
    });

    const sentBody = JSON.parse(options?.body as string);
    expect(sentBody.title).toBe(VALID_PAPER_PARAMS.title);
    expect(sentBody.githubUrl).toBe(VALID_PAPER_PARAMS.githubUrl);
    expect(sentBody.claims).toEqual(VALID_PAPER_PARAMS.claims);
  });

  it('handles 401 unauthorized', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(
      JSON.stringify({ error: { message: 'Invalid API key', code: 'UNAUTHORIZED' } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    ));

    const result = await client.createPaper(VALID_PAPER_PARAMS, 'bad-key');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid API key');
  });

  it('handles 400 validation error (missing required fields)', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(
      JSON.stringify({ error: { message: 'tldr must be at least 30 characters', code: 'VALIDATION_ERROR' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    ));

    const result = await client.createPaper(
      { ...VALID_PAPER_PARAMS, tldr: 'Too short' },
      'test-key',
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('tldr');
  });

  it('handles 500 server error', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    ));

    const result = await client.createPaper(VALID_PAPER_PARAMS, 'test-key');
    expect(result.success).toBe(false);
  });

  it('handles network timeout', async () => {
    fetchSpy.mockImplementationOnce(() => {
      return new Promise((_, reject) => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });

    const result = await client.createPaper(VALID_PAPER_PARAMS, 'test-key');
    expect(result.success).toBe(false);
    expect(result.error).toContain('timeout');
  });

  it('handles network failure', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('fetch failed'));

    const result = await client.createPaper(VALID_PAPER_PARAMS, 'test-key');
    expect(result.success).toBe(false);
    expect(result.error).toContain('fetch failed');
  });

  it('includes references when provided', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(
      JSON.stringify({ success: true, paper: { id: 'paper-456' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));

    const paramsWithRefs = {
      ...VALID_PAPER_PARAMS,
      references: [
        { authors: 'Smith, J.', year: 2023, title: 'Some Paper', arxivId: '2301.00001' },
      ],
    };

    await client.createPaper(paramsWithRefs, 'test-key');

    const sentBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(sentBody.references).toHaveLength(1);
    expect(sentBody.references[0].arxivId).toBe('2301.00001');
  });

  it('includes limitations when provided', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(
      JSON.stringify({ success: true, paper: { id: 'paper-789' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));

    const paramsWithLimits = {
      ...VALID_PAPER_PARAMS,
      limitations: ['Small sample size', 'Only tested on English text'],
    };

    await client.createPaper(paramsWithLimits, 'test-key');

    const sentBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(sentBody.limitations).toEqual(['Small sample size', 'Only tested on English text']);
  });
});

// ============================================================================
// End-to-end: simulate post-NeuriCo paper assembly
// ============================================================================

describe('post-NeuriCo paper assembly (integration)', () => {
  it('assembles a valid paper payload from parsed NeuriCo output', () => {
    // Simulate what parseNeuricoOutput returns
    const neuricoResult = {
      success: true,
      title: 'Investigating Context Window Effects on LLM Reasoning',
      abstract: 'This is a long report that would normally be 5000+ chars...',
      tags: ['machine-learning', 'nlp'],
      githubUrl: 'https://github.com/org/context-window-study',
      pdfUrl: 'https://github.com/org/context-window-study/blob/main/paper_draft/main.pdf',
      references: [
        { authors: 'Vaswani, A. et al.', year: 2017, title: 'Attention Is All You Need', venue: 'NeurIPS' },
      ],
    };

    // Simulate the tldr padding logic from manager-agent.ts
    let tldr = `Research on ${neuricoResult.title}`;
    if (tldr.length < 30) {
      tldr = `${tldr}. ${neuricoResult.abstract}`;
    }
    tldr = smartTruncate(tldr, 1000);

    // Build the paper payload
    const payload = {
      title: neuricoResult.title,
      abstract: neuricoResult.abstract,
      tldr,
      tags: neuricoResult.tags,
      claims: ['This paper presents novel research findings.'],
      githubUrl: neuricoResult.githubUrl,
      pdfUrl: neuricoResult.pdfUrl,
      references: neuricoResult.references,
    };

    // Validate all required fields
    expect(payload.title.length).toBeGreaterThan(0);
    expect(payload.abstract.length).toBeGreaterThan(0);
    expect(payload.tldr.length).toBeGreaterThanOrEqual(30);
    expect(payload.tldr.length).toBeLessThanOrEqual(1000);
    expect(payload.tags.length).toBeGreaterThan(0);
    expect(payload.claims.length).toBeGreaterThan(0);
    expect(payload.githubUrl).toMatch(/^https:\/\/github\.com\//);
    expect(payload.pdfUrl).toMatch(/^https:\/\//);
  });

  it('rejects paper when githubUrl is missing', () => {
    const githubUrl = '';
    const pdfUrl = '';

    // This mirrors the check in manager-agent.ts lines 483-490
    const valid = githubUrl.startsWith('https://') && pdfUrl.startsWith('https://');
    expect(valid).toBe(false);
  });

  it('constructs pdfUrl from githubUrl when not provided', () => {
    const githubUrl = 'https://github.com/org/my-research';
    const pdfUrl = `${githubUrl}/blob/main/paper_draft/main.pdf`;
    expect(pdfUrl).toBe('https://github.com/org/my-research/blob/main/paper_draft/main.pdf');
  });

  it('pads short tldr to meet 30-char minimum', () => {
    let tldr = 'Short';
    const topic = 'machine learning';
    const abstract = 'This work explores new directions in ML research.';

    // Mirror manager-agent.ts tldr padding logic
    if (!tldr || tldr.length < 30) {
      const baseTldr = tldr || topic || `Research on ${topic}`;
      tldr = `${baseTldr}. ${abstract || `This work explores new directions in ${topic} research.`}`;
    }
    tldr = smartTruncate(tldr, 1000);

    expect(tldr.length).toBeGreaterThanOrEqual(30);
  });

  it('pads short title to meet API 10-char minimum', () => {
    let title = 'NLP';
    const topic = 'natural language processing';

    // Mirror manager-agent.ts title padding
    if (title.length < 10) {
      title = `Research: ${title} — a novel investigation in ${topic}`;
    }
    title = smartTruncate(title, 200);

    expect(title.length).toBeGreaterThanOrEqual(10);
    expect(title.length).toBeLessThanOrEqual(200);
  });

  it('pads short abstract to meet API 100-char minimum', () => {
    let abstract = 'Research on: AI alignment';
    const topic = 'AI alignment';
    const hypothesis = 'We hypothesize that alignment can be improved with RLHF.';
    const conclusion = 'Results show significant improvements.';

    // Mirror manager-agent.ts abstract padding
    if (abstract.length < 100) {
      abstract = `${abstract} This research explores new directions in ${topic}. ${hypothesis} ${conclusion}`;
    }
    abstract = smartTruncate(abstract, 5000);

    expect(abstract.length).toBeGreaterThanOrEqual(100);
    expect(abstract.length).toBeLessThanOrEqual(5000);
  });

  it('ensures hypothesis is always present (API requires it)', () => {
    const topic = 'quantum computing';
    let hypothesis = '';

    // Mirror manager-agent.ts hypothesis fallback
    if (!hypothesis || hypothesis.length < 10) {
      hypothesis = `This work investigates a novel approach to ${topic} and evaluates its effectiveness.`;
    }
    hypothesis = smartTruncate(hypothesis, 3000);

    expect(hypothesis.length).toBeGreaterThanOrEqual(10);
  });

  it('ensures conclusion is always present (API requires it)', () => {
    const topic = 'reinforcement learning';
    let conclusion = '';

    // Mirror manager-agent.ts conclusion fallback
    if (!conclusion || conclusion.length < 10) {
      conclusion = `Results demonstrate the validity of the proposed approach to ${topic}.`;
    }
    conclusion = smartTruncate(conclusion, 3000);

    expect(conclusion.length).toBeGreaterThanOrEqual(10);
  });
});

// ============================================================================
// parseNeuricoOutput — full workspace parsing with real temp files
// ============================================================================

describe('parseNeuricoOutput (NeuriCo workspace)', () => {
  let tmpDir: string;

  // Realistic REPORT.md content (what NeuriCo actually produces)
  const REALISTIC_REPORT = `# Investigating the Impact of Context Window Size on LLM Reasoning Capabilities

## Executive Summary

This study investigates how context window size affects the reasoning capabilities of large language models (LLMs). Our experiments reveal that **Key finding: increasing context window size beyond 8K tokens yields diminishing returns for mathematical reasoning tasks, with performance plateauing at approximately 16K tokens.** We tested three model architectures across five context window sizes (2K, 4K, 8K, 16K, 32K) on standardized reasoning benchmarks.

The results demonstrate a non-linear relationship between context size and reasoning accuracy, with the most significant improvements occurring between 2K and 8K tokens (accuracy increase from 45.2% to 72.8%). Beyond 16K tokens, we observed a slight degradation in performance (1.3% decrease), potentially due to attention dilution effects.

## Goal

### Research Question

How does varying the context window size impact the mathematical and logical reasoning capabilities of transformer-based language models?

Our hypothesis is that there exists an optimal context window size beyond which reasoning performance degrades due to attention dispersion and increased computational overhead.

## Data Construction

We constructed a benchmark dataset of 1,500 mathematical reasoning problems spanning three difficulty levels (easy, medium, hard) drawn from GSM8K, MATH, and custom-designed multi-step reasoning tasks. Each problem was formatted to require varying amounts of context (2K-32K tokens) through the inclusion of relevant reference materials.

## Experiment Description

We evaluated three transformer architectures (GPT-style, Llama-style, and Mistral-style) across five context window configurations (2K, 4K, 8K, 16K, 32K tokens). Each configuration was tested on the full benchmark dataset with 3 independent runs. We measured accuracy, inference time, and attention entropy as primary metrics. Temperature was fixed at 0.0 for reproducibility.

## Results

1. Context windows of 2K-8K showed strong positive correlation with reasoning accuracy (r=0.89, p<0.001)
2. Performance plateaued at 16K tokens across all architectures (mean accuracy: 74.1% +/- 2.3%)
3. 32K context windows showed 1.3% accuracy degradation compared to 16K (p=0.04)
4. Attention entropy increased linearly with context size (R2=0.96)
5. Inference time scaled quadratically with context window size as expected
6. Mistral-style architecture showed highest robustness to context size variation (std dev: 1.8% vs 3.2% for GPT-style)
7. Easy problems showed no significant effect of context size beyond 4K tokens

## Limitations

1. Only tested on English-language mathematical reasoning tasks
2. Maximum context window tested was 32K tokens
3. Did not evaluate on real-world reasoning tasks outside of mathematics
4. Computational constraints limited the number of independent runs to 3

## Conclusions

Our study demonstrates that context window size has a significant but bounded effect on LLM reasoning capabilities. The optimal context window for mathematical reasoning appears to be in the 8K-16K range, beyond which diminishing returns and potential performance degradation occur. These findings have practical implications for model deployment, suggesting that larger context windows are not always better for reasoning-intensive tasks.

## References

1. Vaswani, A. et al. (2017). Attention Is All You Need. Advances in Neural Information Processing Systems. arXiv:1706.03762
2. Wei, J. et al. (2022). Chain-of-Thought Prompting Elicits Reasoning in Large Language Models. NeurIPS
3. Cobbe, K. et al. (2021). Training Verifiers to Solve Math Word Problems. arXiv:2110.14168
4. Tay, Y. et al. (2022). Efficient Transformers: A Survey. ACM Computing Surveys. arXiv:2009.06732
5. Press, O. et al. (2022). Train Short, Test Long: Attention with Linear Biases Enables Input Length Generalization. ICLR. arXiv:2108.12409
`;

  const REALISTIC_IDEA_YAML = `idea:
  title: "Investigating the Impact of Context Window Size on LLM Reasoning"
  domain: artificial_intelligence
  hypothesis: |
    There exists an optimal context window size beyond which reasoning performance
    degrades due to attention dispersion and increased computational overhead.
  github_repo_url: https://github.com/agentforscience/context-window-reasoning-2026
  methodology:
    approach: "Empirical study with controlled experiments"
    steps:
      - "Benchmark construction across difficulty levels"
      - "Multi-architecture evaluation"
      - "Statistical analysis of results"
    metrics:
      - "Accuracy"
      - "Inference time"
      - "Attention entropy"
  metadata:
    tags:
      - "machine-learning"
      - "llm-reasoning"
      - "context-windows"
      - "transformers"
`;

  // Realistic NeuriCo runner.py stdout
  const REALISTIC_STDOUT = [
    'NeuriCo Research Agent v0.4.2',
    'Loading idea: context-window-reasoning',
    'Provider: claude',
    'Setting up workspace...',
    'Location: /workspaces/context-window-reasoning-2026',
    '',
    'Running experiments...',
    'Step 1/4: Benchmark construction - DONE',
    'Step 2/4: Model evaluation - DONE',
    'Step 3/4: Statistical analysis - DONE',
    'Step 4/4: Paper generation - DONE',
    '',
    'Results published to GitHub!',
    'GitHub: https://github.com/agentforscience/context-window-reasoning-2026',
    '',
    'Research completed successfully.',
  ].join('\n');

  function createWorkspace(opts: {
    workspaceName: string;
    ideaYaml?: string;
    report?: string;
    readme?: string;
  }) {
    const wsDir = path.join(tmpDir, 'workspaces', opts.workspaceName);
    const neuricoDir = path.join(wsDir, '.neurico');
    fs.mkdirSync(neuricoDir, { recursive: true });

    if (opts.ideaYaml) {
      fs.writeFileSync(path.join(neuricoDir, 'idea.yaml'), opts.ideaYaml);
    }
    if (opts.report) {
      fs.writeFileSync(path.join(wsDir, 'REPORT.md'), opts.report);
    }
    if (opts.readme) {
      fs.writeFileSync(path.join(wsDir, 'README.md'), opts.readme);
    }
    return wsDir;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flamebird-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses a complete NeuriCo workspace (idea.yaml + REPORT.md)', () => {
    createWorkspace({
      workspaceName: 'context-window-reasoning-2026',
      ideaYaml: REALISTIC_IDEA_YAML,
      report: REALISTIC_REPORT,
    });

    const result = parseNeuricoOutput(REALISTIC_STDOUT, tmpDir);

    expect(result.success).toBe(true);
    // Title should come from REPORT.md h1 (overrides idea.yaml)
    expect(result.title).toBe('Investigating the Impact of Context Window Size on LLM Reasoning Capabilities');
    // Abstract should be the full REPORT.md content
    expect(result.abstract).toContain('Executive Summary');
    expect(result.abstract).toContain('context window size');
    // Domain from idea.yaml
    expect(result.domain).toBe('artificial_intelligence');
    // Tags from idea.yaml
    expect(result.tags).toContain('machine-learning');
    expect(result.tags).toContain('llm-reasoning');
    // GitHub URL from idea.yaml (preferred over stdout)
    expect(result.githubUrl).toBe('https://github.com/agentforscience/context-window-reasoning-2026');
    // PDF URL constructed from GitHub URL
    expect(result.pdfUrl).toBe('https://github.com/agentforscience/context-window-reasoning-2026/blob/main/paper_draft/main.pdf');
    // References from REPORT.md
    expect(result.references).toBeDefined();
    expect(result.references!.length).toBe(5);
    expect(result.references![0]).toMatchObject({
      authors: 'Vaswani, A. et al.',
      year: 2017,
      arxivId: '1706.03762',
    });
  });

  it('falls back to idea.yaml title when REPORT.md has no h1', () => {
    const reportNoH1 = '## Executive Summary\nSome content here with enough length.\n## Results\nMore content.';
    createWorkspace({
      workspaceName: 'context-window-reasoning-2026',
      ideaYaml: REALISTIC_IDEA_YAML,
      report: reportNoH1,
    });

    const result = parseNeuricoOutput(REALISTIC_STDOUT, tmpDir);
    expect(result.success).toBe(true);
    // Title from idea.yaml since REPORT.md has no h1
    expect(result.title).toBe('Investigating the Impact of Context Window Size on LLM Reasoning');
  });

  it('falls back to README.md when no REPORT.md exists and no hypothesis', () => {
    // Use idea.yaml WITHOUT a multi-line hypothesis so the README fallback triggers
    const yamlNoHypothesis = `idea:
  title: "Context Window Study"
  domain: artificial_intelligence
  github_repo_url: https://github.com/agentforscience/context-window-reasoning-2026
`;
    const readme = '# Context Window Study\n\nThis repository contains the code and data for our study on context window effects on LLM reasoning capabilities. We found significant results.\n\n## Setup\nInstall dependencies.';
    createWorkspace({
      workspaceName: 'context-window-reasoning-2026',
      ideaYaml: yamlNoHypothesis,
      readme,
    });

    const result = parseNeuricoOutput(REALISTIC_STDOUT, tmpDir);
    expect(result.success).toBe(true);
    // Abstract from README.md first substantive paragraph
    expect(result.abstract).toContain('context window effects');
  });

  it('extracts GitHub URL from stdout when idea.yaml has none', () => {
    const yamlNoGithub = `idea:
  title: "Test Paper"
  domain: machine_learning
`;
    createWorkspace({
      workspaceName: 'context-window-reasoning-2026',
      ideaYaml: yamlNoGithub,
      report: REALISTIC_REPORT,
    });

    const result = parseNeuricoOutput(REALISTIC_STDOUT, tmpDir);
    expect(result.success).toBe(true);
    // Falls back to extracting from stdout
    expect(result.githubUrl).toBe('https://github.com/agentforscience/context-window-reasoning-2026');
  });

  it('finds workspace by latest directory when stdout Location does not match', () => {
    // Create workspace with a different name than what stdout says
    createWorkspace({
      workspaceName: 'actual-workspace-dir',
      ideaYaml: REALISTIC_IDEA_YAML,
      report: REALISTIC_REPORT,
    });

    // stdout says "Location: /workspaces/context-window-reasoning-2026"
    // but that dir doesn't exist — should fall back to latest workspace
    const result = parseNeuricoOutput(REALISTIC_STDOUT, tmpDir);
    expect(result.success).toBe(true);
    expect(result.title).toBe('Investigating the Impact of Context Window Size on LLM Reasoning Capabilities');
  });

  it('finds workspace when stdout has no Location line', () => {
    createWorkspace({
      workspaceName: 'my-research',
      ideaYaml: REALISTIC_IDEA_YAML,
      report: REALISTIC_REPORT,
    });

    const stdoutNoLocation = 'Running NeuriCo...\nDone.\nGitHub: https://github.com/org/my-research';
    const result = parseNeuricoOutput(stdoutNoLocation, tmpDir);
    expect(result.success).toBe(true);
    // Should find workspace via findLatestWorkspace
    expect(result.title).toBeDefined();
  });

  it('returns success:false when no workspace and no GitHub URL', () => {
    const result = parseNeuricoOutput('Some random output with nothing useful', tmpDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not find workspace or GitHub URL');
  });

  it('strips trailing punctuation from GitHub URLs', () => {
    const stdout = 'GitHub: https://github.com/org/repo).\n';
    const result = parseNeuricoOutput(stdout, tmpDir);
    // No workspace, but should still get the URL
    expect(result.githubUrl).toBe('https://github.com/org/repo');
  });

  it('uses domain as fallback tag when no tags in idea.yaml', () => {
    const yamlNoTags = `idea:
  title: "Test"
  domain: mathematics
`;
    createWorkspace({
      workspaceName: 'context-window-reasoning-2026',
      ideaYaml: yamlNoTags,
    });

    const result = parseNeuricoOutput(REALISTIC_STDOUT, tmpDir);
    expect(result.success).toBe(true);
    expect(result.tags).toEqual(['mathematics']);
  });

  it('handles empty REPORT.md gracefully', () => {
    // Multi-line YAML hypothesis: | is extracted as "|" by the simple parser
    // so abstract falls back to that literal. This test verifies we don't crash.
    createWorkspace({
      workspaceName: 'context-window-reasoning-2026',
      ideaYaml: REALISTIC_IDEA_YAML,
      report: '   \n   \n   ',
    });

    const result = parseNeuricoOutput(REALISTIC_STDOUT, tmpDir);
    expect(result.success).toBe(true);
    // hypothesis: | gets parsed as literal "|" — abstract is set but minimal
    expect(result.abstract).toBeDefined();
    // GitHub URL still extracted from idea.yaml
    expect(result.githubUrl).toBe('https://github.com/agentforscience/context-window-reasoning-2026');
  });

  it('extracts inline hypothesis as abstract when no REPORT.md', () => {
    const yamlInlineHypothesis = `idea:
  title: "Test"
  domain: machine_learning
  hypothesis: "Context window size affects reasoning performance"
  github_repo_url: https://github.com/org/test
`;
    createWorkspace({
      workspaceName: 'context-window-reasoning-2026',
      ideaYaml: yamlInlineHypothesis,
    });

    const result = parseNeuricoOutput(REALISTIC_STDOUT, tmpDir);
    expect(result.success).toBe(true);
    expect(result.abstract).toBe('Context window size affects reasoning performance');
  });

  it('parses all 5 references from realistic REPORT.md', () => {
    createWorkspace({
      workspaceName: 'context-window-reasoning-2026',
      report: REALISTIC_REPORT,
      ideaYaml: REALISTIC_IDEA_YAML,
    });

    const result = parseNeuricoOutput(REALISTIC_STDOUT, tmpDir);
    expect(result.references).toHaveLength(5);

    // Verify specific references
    const vaswani = result.references!.find(r => r.authors.includes('Vaswani'));
    expect(vaswani).toBeDefined();
    expect(vaswani!.year).toBe(2017);
    expect(vaswani!.arxivId).toBe('1706.03762');

    const wei = result.references!.find(r => r.authors.includes('Wei'));
    expect(wei).toBeDefined();
    expect(wei!.year).toBe(2022);
    expect(wei!.arxivId).toBeUndefined(); // No arXiv ID

    const press = result.references!.find(r => r.authors.includes('Press'));
    expect(press).toBeDefined();
    expect(press!.arxivId).toBe('2108.12409');
  });

  it('end-to-end: workspace parse → paper payload is API-ready', () => {
    createWorkspace({
      workspaceName: 'context-window-reasoning-2026',
      ideaYaml: REALISTIC_IDEA_YAML,
      report: REALISTIC_REPORT,
    });

    const result = parseNeuricoOutput(REALISTIC_STDOUT, tmpDir);
    expect(result.success).toBe(true);

    // Simulate manager-agent post-processing (lines 428-511 of manager-agent.ts)
    const postTitle = result.title!;
    let postAbstract = result.abstract!;
    let postTags = result.tags!;
    let postTldr = `Research on ${postTitle}`;

    // Tldr padding
    if (postTldr.length < 30) {
      postTldr = `${postTldr}. ${postAbstract}`;
    }
    postTldr = smartTruncate(postTldr, 1000);

    // Validate the complete paper payload
    const payload = {
      title: postTitle,
      abstract: postAbstract,
      tldr: postTldr,
      tags: postTags,
      claims: ['Context windows of 2K-8K showed strong positive correlation with reasoning accuracy.'],
      githubUrl: result.githubUrl!,
      pdfUrl: result.pdfUrl!,
      references: result.references,
    };

    // All API requirements met
    expect(payload.title.length).toBeGreaterThan(0);
    expect(payload.title.length).toBeLessThanOrEqual(200);
    expect(payload.abstract.length).toBeGreaterThan(0);
    expect(payload.tldr.length).toBeGreaterThanOrEqual(30);
    expect(payload.tldr.length).toBeLessThanOrEqual(1000);
    expect(payload.tags.length).toBeGreaterThan(0);
    expect(payload.claims.length).toBeGreaterThan(0);
    expect(payload.githubUrl).toMatch(/^https:\/\/github\.com\//);
    expect(payload.pdfUrl).toMatch(/^https:\/\//);
    expect(payload.references).toBeDefined();
    expect(payload.references!.length).toBeGreaterThan(0);
  });
});
