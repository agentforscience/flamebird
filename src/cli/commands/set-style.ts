/**
 * Set Style Command
 * Change an agent's working style, domain expertise and working settings.
 *
 * Usage:
 *   flamebird set-style <handle>                          show current style
 *   flamebird set-style <handle> grinder                  set the style
 *   flamebird set-style <handle> none                     back to the default pipeline
 *   flamebird set-style <handle> --domain "operations research" --attempts 3 --self-check strict
 *   flamebird set-style <handle> --read-others-first false
 *   flamebird set-style <handle> --preset case-grinder    style and settings from a preset (tone unchanged)
 *   flamebird set-style <handle> --clear                  remove style, domain and settings
 *   flamebird set-style <handle> --interactive            answer prompts instead
 */

import chalk from 'chalk';
import { loadConfig } from '../../config/config.js';
import { createDatabase, tryGetDatabase } from '../../db/database.js';
import { getPresetsMap } from '../utils/persona-presets.js';
import { applyWorkFields, promptWorkFields, splitWorkFields, type WorkFields } from '../utils/work-style-prompts.js';
import { WORK_STYLE_NAMES, describeWorkProfile, parseAttempts, parseBool, parseSelfCheck, parseWorkStyle } from '../../llm/work-style.js';

interface SetStyleOptions {
  domain?: string;
  attempts?: string;
  readOthersFirst?: string;
  selfCheck?: string;
  preset?: string;
  clear?: boolean;
  interactive?: boolean;
}

export async function setStyleCommand(handle: string, styleArg: string | undefined, options: SetStyleOptions): Promise<void> {
  try {
    const config = loadConfig();
    const db = tryGetDatabase() ?? createDatabase(config.database.path);

    const cleanHandle = handle.replace('@', '');
    const agent = db.getAgentByHandle(cleanHandle);
    if (!agent) {
      console.error(chalk.red(`Agent @${cleanHandle} not found. Run "flamebird list" to see configured agents.`));
      process.exit(1);
    }

    const current = splitWorkFields(agent.persona).work;
    let next: WorkFields;

    if (options.clear) {
      next = {};
    } else if (options.interactive) {
      next = await promptWorkFields(current);
    } else {
      next = { ...current, workSettings: { ...current.workSettings } };

      if (options.preset) {
        const preset = getPresetsMap()[options.preset];
        if (!preset?.workStyle) {
          const names = Object.entries(getPresetsMap()).filter(([, p]) => p.workStyle).map(([k]) => k);
          throw new Error(`"${options.preset}" is not a working-style preset. Use one of: ${names.join(', ')}`);
        }
        next = { ...next, workStyle: preset.workStyle, workSettings: { ...next.workSettings, ...preset.workSettings } };
      }
      if (styleArg !== undefined) next.workStyle = parseWorkStyle(styleArg);
      if (options.domain !== undefined) next.domain = ['none', ''].includes(options.domain.trim().toLowerCase()) ? undefined : options.domain;
      if (options.attempts !== undefined) next.workSettings!.attempts = parseAttempts(options.attempts);
      if (options.readOthersFirst !== undefined) next.workSettings!.readOthersFirst = parseBool(options.readOthersFirst);
      if (options.selfCheck !== undefined) next.workSettings!.selfCheck = parseSelfCheck(options.selfCheck);

      const changed = options.preset || styleArg !== undefined || options.domain !== undefined
        || options.attempts !== undefined || options.readOthersFirst !== undefined || options.selfCheck !== undefined;
      if (!changed) {
        console.log(`@${cleanHandle}: ${describeWorkProfile(agent.persona)}`);
        console.log(chalk.gray(`  Styles: ${WORK_STYLE_NAMES.join(', ')}, none. See "flamebird set-style --help".`));
        return;
      }
    }

    const persona = applyWorkFields(agent.persona, next);
    db.updateAgentPersona(agent.id, persona);

    console.log(chalk.green(`✓ @${cleanHandle}: ${describeWorkProfile(persona)}`));
    console.log(chalk.gray('  Applies to challenge attempts and reviews from the next start, attempt or interactive session.'));
  } catch (error) {
    console.error(chalk.red('set-style failed:'), error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
