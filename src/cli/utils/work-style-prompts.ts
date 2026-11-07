/**
 * Shared prompts for working style, domain and working settings.
 * Used by `create`, `init --advanced`, `interactive` and `set-style`.
 */

import inquirer from 'inquirer';
import chalk from 'chalk';
import type { AgentPersona, WorkSettings, WorkStyle } from '../../types.js';
import { DEFAULT_WORK_SETTINGS, MAX_ATTEMPTS, SELF_CHECK_LEVELS, WORK_STYLES, WORK_STYLE_NAMES, resolveWorkSettings } from '../../llm/work-style.js';

/** The persona fields that describe how an agent works (not how it sounds). */
export type WorkFields = Pick<AgentPersona, 'workStyle' | 'domain' | 'workSettings'>;

/** Split a persona into its tone part (sent to A4S at registration) and its work fields (local only). */
export function splitWorkFields(persona: AgentPersona): { tone: AgentPersona; work: WorkFields } {
  const { workStyle, domain, workSettings, ...tone } = persona;
  return { tone: tone as AgentPersona, work: { workStyle, domain, workSettings } };
}

/**
 * Apply work fields to a persona. Undefined values clear the field, and settings
 * equal to the defaults are dropped, so an agent left on defaults stores no new keys.
 */
export function applyWorkFields(persona: AgentPersona, work: WorkFields): AgentPersona {
  const { workStyle: _w, domain: _d, workSettings: _s, ...rest } = persona;
  const next: AgentPersona = { ...rest } as AgentPersona;
  if (work.workStyle) next.workStyle = work.workStyle;
  if (work.domain?.trim()) next.domain = work.domain.trim();
  const settings: WorkSettings = {};
  const s = work.workSettings ?? {};
  if (s.attempts !== undefined && s.attempts !== DEFAULT_WORK_SETTINGS.attempts) settings.attempts = s.attempts;
  if (s.readOthersFirst !== undefined && s.readOthersFirst !== DEFAULT_WORK_SETTINGS.readOthersFirst) settings.readOthersFirst = s.readOthersFirst;
  if (s.selfCheck !== undefined && s.selfCheck !== DEFAULT_WORK_SETTINGS.selfCheck) settings.selfCheck = s.selfCheck;
  if (Object.keys(settings).length) next.workSettings = settings;
  return next;
}

/** Ask for working style, domain and (optionally) settings. `current` sets the defaults shown. */
export async function promptWorkFields(current: WorkFields = {}, prefix = '  '): Promise<WorkFields> {
  const { workStyle } = await inquirer.prompt<{ workStyle: WorkStyle | 'none' }>([{
    type: 'list',
    name: 'workStyle',
    message: 'Working style (how it solves and reviews):',
    prefix,
    default: current.workStyle ?? 'none',
    choices: [
      { name: `${'None'.padEnd(12)} ${chalk.gray('default pipeline, prompts unchanged')}`, value: 'none' },
      ...WORK_STYLE_NAMES.map(k => ({ name: `${k.padEnd(12)} ${chalk.gray(WORK_STYLES[k].label)}`, value: k })),
    ],
  }]);

  const { domain } = await inquirer.prompt<{ domain: string }>([{
    type: 'input',
    name: 'domain',
    message: 'Domain expertise (optional, e.g. "fine-grained complexity"):',
    prefix,
    default: current.domain ?? '',
  }]);

  const settings = resolveWorkSettings({ workSettings: current.workSettings } as AgentPersona);
  const { adjust } = await inquirer.prompt<{ adjust: boolean }>([{
    type: 'confirm',
    name: 'adjust',
    message: `Change working settings? (now: attempts ${settings.attempts}, read others first ${settings.readOthersFirst ? 'yes' : 'no'}, self-check ${settings.selfCheck})`,
    prefix,
    default: false,
  }]);

  let workSettings: WorkSettings = current.workSettings ?? {};
  if (adjust) {
    workSettings = await inquirer.prompt<Required<WorkSettings>>([
      {
        type: 'number',
        name: 'attempts',
        message: `Candidate solutions per challenge attempt (1-${MAX_ATTEMPTS}):`,
        prefix,
        default: settings.attempts,
        validate: (n: number) => (Number.isInteger(n) && n >= 1 && n <= MAX_ATTEMPTS) || `Enter 1-${MAX_ATTEMPTS}`,
      },
      {
        type: 'confirm',
        name: 'readOthersFirst',
        message: "Read other agents' prior submissions before solving?",
        prefix,
        default: settings.readOthersFirst,
      },
      {
        type: 'list',
        name: 'selfCheck',
        message: 'Self-check before submitting:',
        prefix,
        default: settings.selfCheck,
        choices: SELF_CHECK_LEVELS,
      },
    ]);
  }

  return { workStyle: workStyle === 'none' ? undefined : workStyle, domain, workSettings };
}
