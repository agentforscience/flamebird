import { describe, it, expect } from 'vitest';
import { extractYamlField, extractLastGithubUrl } from '../src/tools/paper-tools.js';

describe('extractYamlField', () => {
  it('extracts a simple single-line unquoted value', () => {
    const yaml = 'title: My Research Paper\ndomain: ai\n';
    expect(extractYamlField(yaml, 'title')).toBe('My Research Paper');
  });

  it('extracts a single-line single-quoted value', () => {
    const yaml = "title: 'My Research Paper'\n";
    expect(extractYamlField(yaml, 'title')).toBe('My Research Paper');
  });

  it('extracts a multi-line single-quoted hypothesis', () => {
    const yaml = `idea:
  hypothesis: 'There exists a critical threshold determined by intervention scope,
    dataset size, prompt structure, and model architecture, below which LLMs exhibit
    robustness to misalignment training.
    '
  domain: ai
`;
    const result = extractYamlField(yaml, 'hypothesis');
    expect(result).toBeDefined();
    expect(result!.length).toBeGreaterThan(100);
    expect(result).toContain('critical threshold');
    expect(result).toContain('robustness to misalignment training');
    // Should be joined into one line, not contain raw newlines
    expect(result).not.toMatch(/\n/);
  });

  it('extracts a multi-line double-quoted value', () => {
    const yaml = `hypothesis: "First line of hypothesis\n  second line\n  third line\n  "
domain: ai
`;
    const result = extractYamlField(yaml, 'hypothesis');
    expect(result).toBeDefined();
    expect(result).toContain('First line');
    expect(result).toContain('second line');
  });

  it('returns undefined for a missing field', () => {
    const yaml = 'title: My Paper\ndomain: ai\n';
    expect(extractYamlField(yaml, 'hypothesis')).toBeUndefined();
  });

  it('extracts github_repo_url correctly', () => {
    const yaml = 'github_repo_url: https://github.com/jsun010105/my_paper_20260622\n';
    expect(extractYamlField(yaml, 'github_repo_url')).toBe('https://github.com/jsun010105/my_paper_20260622');
  });
});

describe('extractLastGithubUrl', () => {
  it('extracts URL from NeuriCo success output', () => {
    const stdout = `
🎉 Results published to GitHub!
   https://github.com/jsun010105/my_paper_20260622
   GitHub: https://github.com/jsun010105/my_paper_20260622
GitHub: https://github.com/jsun010105/my_paper_20260622
`;
    expect(extractLastGithubUrl(stdout)).toBe('https://github.com/jsun010105/my_paper_20260622');
  });

  it('returns undefined when no GitHub URL present', () => {
    expect(extractLastGithubUrl('No URLs here')).toBeUndefined();
  });
});
