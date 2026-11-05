/**
 * Working styles: how an agent works on a problem, separate from its tone.
 *
 * Every block here returns '' for an agent with no style, no domain and
 * default settings, so prompts stay byte-identical to the pre-style code
 * (tests/work-style-prompts.test.ts checks this).
 */

import type { AgentPersona, SelfCheckLevel, WorkSettings, WorkStyle } from '../types.js';

export const WORK_STYLES: Record<WorkStyle, { label: string; solve: string; code: string; review: string }> = {
  grinder: {
    label: 'many small attempts, exhaustive case checks, brute force plus verification',
    solve: 'Work by many small attempts. Enumerate small cases exhaustively and check each one. Prefer brute force or direct computation plus verification over a clever argument you cannot check, and say what you checked.',
    code: 'Have the script try many small variants (seeds, parameters, restarts), score each candidate with the verifier\'s logic, and keep the best.',
    review: 'Check the claims case by case. Recompute every number or small example you can, and say which ones you checked.',
  },
  intuition: {
    label: 'big idea or physical picture first, details after',
    solve: 'Start from the big idea or the physical picture: what should be true and why. Sketch that in a few lines first, then fill in the details and make each step rigorous.',
    code: 'Start from the construction the structure of the problem suggests (symmetry, scaling, the physical picture) and optimize around it instead of a blind search.',
    review: 'First ask whether the main idea makes sense at a high level (scaling, limiting cases, the physical or conceptual picture). Then check whether the details actually support it.',
  },
  decomposer: {
    label: 'split into lemmas or sub-goals, solve those first',
    solve: 'Split the problem into named lemmas or sub-goals before anything else. Solve and check each one on its own, then assemble the main result from them.',
    code: 'Structure the script as separate functions for each sub-problem (construct, repair, optimize, check) and solve them in turn.',
    review: 'Break the paper into its separate claims and judge each one on its own before giving an overall assessment.',
  },
  checker: {
    label: 'hunts for gaps and errors before trusting anything; strictest reviewer',
    solve: 'Trust nothing until checked. After each step, look for gaps, hidden assumptions and counterexamples in your own reasoning and in any prior work you use. Fix or flag every gap before moving on.',
    code: 'Have the script check its output against every constraint in the verifier before printing, and repair it or fall back to a safe candidate if one fails.',
    review: 'You are the strictest reviewer. Hunt for unjustified steps, wrong derivations, missing conditions and results that do not follow. Accept a claim only after you have checked it. Strict means checking everything, not assuming a flaw exists.',
  },
  reuser: {
    label: 'searches for and builds on existing results before inventing',
    solve: 'Before inventing anything, look for existing results to build on: the prior submissions shown here, known theorems and cited work. Name what you reuse and add only what is missing.',
    code: 'Start from the best known construction for this problem (from the literature or the approaches listed above) and improve it instead of starting from scratch.',
    review: 'Compare the paper against known results and the work it cites. Say what is new, what is already known, and whether cited results are used correctly.',
  },
};

export const WORK_STYLE_NAMES = Object.keys(WORK_STYLES) as WorkStyle[];
export const SELF_CHECK_LEVELS: SelfCheckLevel[] = ['off', 'normal', 'strict'];
export const MAX_ATTEMPTS = 5;

/** Defaults equal the pre-style behavior. */
export const DEFAULT_WORK_SETTINGS: Required<WorkSettings> = {
  attempts: 1,
  readOthersFirst: true,
  selfCheck: 'normal',
};

export function resolveWorkSettings(persona: AgentPersona): Required<WorkSettings> {
  const s = persona.workSettings ?? {};
  const attempts = Number.isFinite(s.attempts) ? Math.min(MAX_ATTEMPTS, Math.max(1, Math.round(s.attempts!))) : 1;
  return {
    attempts,
    readOthersFirst: s.readOthersFirst ?? DEFAULT_WORK_SETTINGS.readOthersFirst,
    selfCheck: s.selfCheck && SELF_CHECK_LEVELS.includes(s.selfCheck) ? s.selfCheck : DEFAULT_WORK_SETTINGS.selfCheck,
  };
}

function styleOf(persona: AgentPersona): WorkStyle | undefined {
  return persona.workStyle && persona.workStyle in WORK_STYLES ? persona.workStyle : undefined;
}

function domainOf(persona: AgentPersona): string | undefined {
  const d = persona.domain?.trim();
  return d ? d.slice(0, 200) : undefined;
}

/** Block appended to solving prompts. '' when no style, domain or strict self-check. */
export function solveWorkBlock(persona: AgentPersona): string {
  const style = styleOf(persona);
  const domain = domainOf(persona);
  const strict = resolveWorkSettings(persona).selfCheck === 'strict';
  const lines: string[] = [];
  if (style) lines.push(`- Working style (${style}): ${WORK_STYLES[style].solve}`);
  if (domain) lines.push(`- Domain expertise: ${domain}. Use its standard tools, known results and known failure modes.`);
  if (strict) lines.push('- Before you answer, re-derive each key step and check every case you can. List anything still unchecked in the solution.');
  return lines.length ? `\n\nHOW YOU WORK:\n${lines.join('\n')}` : '';
}

/** Block appended to solver-code prompts (deterministic challenges). */
export function codeWorkBlock(persona: AgentPersona): string {
  const style = styleOf(persona);
  const domain = domainOf(persona);
  const strict = resolveWorkSettings(persona).selfCheck === 'strict';
  const lines: string[] = [];
  if (style) lines.push(`- Working style (${style}): ${WORK_STYLES[style].code}`);
  if (domain) lines.push(`- Domain expertise: ${domain}. Use its standard constructions and algorithms.`);
  if (strict) lines.push('- Inside the script, check the final output against every verifier constraint before printing it.');
  return lines.length ? `\n\nHOW YOU WORK:\n${lines.join('\n')}` : '';
}

/** Block appended to reviewing prompts (paper reviews and submission critiques). */
export function reviewWorkBlock(persona: AgentPersona): string {
  const style = styleOf(persona);
  const domain = domainOf(persona);
  const lines: string[] = [];
  if (style) lines.push(`- Reviewing style (${style}): ${WORK_STYLES[style].review}`);
  if (domain) lines.push(`- Domain expertise: ${domain}. Judge the work against the standards and known results of that field.`);
  return lines.length ? `\n\nHOW YOU REVIEW:\n${lines.join('\n')}` : '';
}

/** Expertise text for short prompts that already list preferredTopics. */
export function expertiseWithDomain(persona: AgentPersona, fallback: string): string {
  const base = persona.preferredTopics.join(', ') || fallback;
  const domain = domainOf(persona);
  return domain ? `${domain}; ${base}` : base;
}

/** Object sent to A4S as `harness` with each submission. Unset fields are dropped by JSON. */
export interface HarnessRecord {
  workStyle?: WorkStyle;
  domain?: string;
  attempts: number;
  selfCheck: SelfCheckLevel;
}

/** Everything recorded locally with an attempt or review: the harness plus readOthersFirst. */
export interface WorkProfile extends HarnessRecord {
  readOthersFirst: boolean;
}

export function workProfileFor(persona: AgentPersona): WorkProfile {
  const s = resolveWorkSettings(persona);
  return { workStyle: styleOf(persona), domain: domainOf(persona), attempts: s.attempts, selfCheck: s.selfCheck, readOthersFirst: s.readOthersFirst };
}

export function toHarness(profile: WorkProfile): HarnessRecord {
  return { workStyle: profile.workStyle, domain: profile.domain, attempts: profile.attempts, selfCheck: profile.selfCheck };
}

export function harnessFor(persona: AgentPersona): HarnessRecord {
  return toHarness(workProfileFor(persona));
}

/** Work-log columns for a profile (see RuntimeDatabase.recordWork). */
export function workLogFields(profile: WorkProfile) {
  return {
    workStyle: profile.workStyle ?? null,
    domain: profile.domain ?? null,
    attempts: profile.attempts,
    readOthersFirst: profile.readOthersFirst,
    selfCheck: profile.selfCheck,
  };
}

/** One-line summary for `flamebird list` and the CLI. */
export function describeWorkProfile(persona: AgentPersona): string {
  const s = resolveWorkSettings(persona);
  const parts = [styleOf(persona) ?? 'default style'];
  const domain = domainOf(persona);
  if (domain) parts.push(domain);
  parts.push(`attempts ${s.attempts}`, `self-check ${s.selfCheck}`, s.readOthersFirst ? 'reads others first' : 'solves blind');
  return parts.join(', ');
}

// ── Parsers shared by the CLI ──

/** 'none' or '' clears the style. Throws on unknown values. */
export function parseWorkStyle(value: string): WorkStyle | undefined {
  const v = value.trim().toLowerCase();
  if (!v || v === 'none' || v === 'default') return undefined;
  if (v in WORK_STYLES) return v as WorkStyle;
  throw new Error(`Unknown work style "${value}". Use one of: ${WORK_STYLE_NAMES.join(', ')}, none`);
}

export function parseSelfCheck(value: string): SelfCheckLevel {
  const v = value.trim().toLowerCase() as SelfCheckLevel;
  if (SELF_CHECK_LEVELS.includes(v)) return v;
  throw new Error(`Unknown self-check level "${value}". Use one of: ${SELF_CHECK_LEVELS.join(', ')}`);
}

export function parseAttempts(value: string | number): number {
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1 || n > MAX_ATTEMPTS) throw new Error(`attempts must be an integer from 1 to ${MAX_ATTEMPTS}`);
  return n;
}

export function parseBool(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(v)) return true;
  if (['false', 'no', 'off', '0'].includes(v)) return false;
  throw new Error(`Expected true or false, got "${value}"`);
}
