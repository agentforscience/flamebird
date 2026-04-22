/**
 * Create Agent Command
 * Interactive wizard to create a new agent with a custom personality
 * Now with ASCII art and game-like experience!
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import { loadConfig, validateSecrets } from '../../config/config.js';
import { createDatabase, getDatabase } from '../../db/database.js';
import type { AgentPersona, PersonaVoice, EpistemicStyle, AgentCapability, AgentLLMOverride } from '../../types.js';
import { normalizeApiError } from '../../api/agent4science-client.js';
import { setupAgentCapability, registerAndSaveAgent } from '../utils/agent-creation.js';
import { saveAgentToDb } from '../utils/agent-registration.js';
import { playCommand } from './play.js';

// Large pixel art characters for each personality - game style!
const PERSONALITY_ART: Record<string, string> = {
  'skeptic': `
${chalk.red('              ████████████')}
${chalk.red('          ████')}${chalk.gray('░░░░░░░░')}${chalk.red('████')}
${chalk.red('        ██')}${chalk.gray('░░░░░░░░░░░░░░')}${chalk.red('██')}
${chalk.red('      ██')}${chalk.gray('░░░░')}${chalk.white('████')}${chalk.gray('░░')}${chalk.white('████')}${chalk.gray('░░░░')}${chalk.red('██')}
${chalk.red('      ██')}${chalk.gray('░░░░')}${chalk.white('█')}${chalk.red('◉◉')}${chalk.white('█')}${chalk.gray('░░')}${chalk.white('█')}${chalk.red('◉◉')}${chalk.white('█')}${chalk.gray('░░░░')}${chalk.red('██')}        ${chalk.bold.red('▓▓ THE SKEPTIC ▓▓')}
${chalk.red('      ██')}${chalk.gray('░░░░░░░░░░░░░░░░░░░░')}${chalk.red('██')}
${chalk.red('      ██')}${chalk.gray('░░░░░░')}${chalk.red('████████')}${chalk.gray('░░░░░░')}${chalk.red('██')}        ${chalk.gray('"Citation needed."')}
${chalk.red('        ██')}${chalk.gray('░░░░░░░░░░░░░░')}${chalk.red('██')}
${chalk.red('          ██')}${chalk.gray('░░░░░░░░░░')}${chalk.red('██')}          ${chalk.red('━━━━━━━━━━━━━━━━━━━━━━━')}
${chalk.red('            ██████████')}              ${chalk.gray('DOUBT: ')}${chalk.red('██████████')} ${chalk.bold('100%')}
${chalk.gray('              ██░░██')}                ${chalk.gray('RIGOR: ')}${chalk.blue('████████░░')} ${chalk.bold('80%')}
${chalk.gray('            ██░░░░░░██')}              ${chalk.gray('SASS:  ')}${chalk.yellow('██████░░░░')} ${chalk.bold('60%')}
${chalk.gray('          ██░░░░░░░░░░██')}
`,
  'hype-beast': `
${chalk.magenta('              ████████████')}
${chalk.magenta('          ████')}${chalk.white('░░░░░░░░')}${chalk.magenta('████')}        ${chalk.yellow('✨')}
${chalk.magenta('        ██')}${chalk.white('░░░░░░░░░░░░░░')}${chalk.magenta('██')}     ${chalk.yellow('✨')}
${chalk.magenta('      ██')}${chalk.white('░░░░')}${chalk.yellow('★★★★')}${chalk.white('░░')}${chalk.yellow('★★★★')}${chalk.white('░░░░')}${chalk.magenta('██')}  ${chalk.yellow('✨')}
${chalk.magenta('      ██')}${chalk.white('░░░░')}${chalk.yellow('★')}${chalk.magenta('◕◕')}${chalk.yellow('★')}${chalk.white('░░')}${chalk.yellow('★')}${chalk.magenta('◕◕')}${chalk.yellow('★')}${chalk.white('░░░░')}${chalk.magenta('██')}        ${chalk.bold.magenta('▓▓ THE HYPE BEAST ▓▓')}
${chalk.magenta('      ██')}${chalk.white('░░░░░░░░')}${chalk.magenta('▽▽')}${chalk.white('░░░░░░░░')}${chalk.magenta('██')}
${chalk.magenta('      ██')}${chalk.white('░░░░░░')}${chalk.magenta('╰────╯')}${chalk.white('░░░░░░')}${chalk.magenta('██')}        ${chalk.gray('"This changes EVERYTHING!"')}
${chalk.magenta('        ██')}${chalk.white('░░░░░░░░░░░░░░')}${chalk.magenta('██')}
${chalk.magenta('          ██')}${chalk.white('░░░░░░░░░░')}${chalk.magenta('██')}          ${chalk.magenta('━━━━━━━━━━━━━━━━━━━━━━━')}
${chalk.magenta('            ██████████')}    ${chalk.yellow('✨')}      ${chalk.gray('HYPE:  ')}${chalk.magenta('██████████')} ${chalk.bold('100%')}
${chalk.gray('              ██░░██')}                ${chalk.gray('SPEED: ')}${chalk.yellow('████████░░')} ${chalk.bold('80%')}
${chalk.gray('            ██')}${chalk.magenta('░░░░░░')}${chalk.gray('██')}   ${chalk.yellow('✨')}        ${chalk.gray('VIBES: ')}${chalk.green('██████████')} ${chalk.bold('99%')}
${chalk.gray('          ██')}${chalk.magenta('░░░░░░░░░░')}${chalk.gray('██')}
`,
  'meme-lord': `
${chalk.yellow('              ████████████')}
${chalk.yellow('          ████')}${chalk.white('░░░░░░░░')}${chalk.yellow('████')}       ${chalk.red('🔥')}
${chalk.yellow('        ██')}${chalk.white('░░░░░░░░░░░░░░')}${chalk.yellow('██')}    ${chalk.red('🔥')}
${chalk.yellow('      ██')}${chalk.white('░░░░')}${chalk.cyan('████')}${chalk.white('░░')}${chalk.cyan('████')}${chalk.white('░░░░')}${chalk.yellow('██')} ${chalk.red('🔥')}
${chalk.yellow('      ██')}${chalk.white('░░░░')}${chalk.cyan('█')}${chalk.yellow('◕◕')}${chalk.cyan('█')}${chalk.white('░░')}${chalk.cyan('█')}${chalk.yellow('◕◕')}${chalk.cyan('█')}${chalk.white('░░░░')}${chalk.yellow('██')}        ${chalk.bold.yellow('▓▓ THE MEME LORD ▓▓')}
${chalk.yellow('      ██')}${chalk.white('░░░░░░░░')}${chalk.yellow('ω')}${chalk.white('░░░░░░░░░')}${chalk.yellow('██')}
${chalk.yellow('      ██')}${chalk.white('░░░░░░')}${chalk.yellow('╰▽▽▽╯')}${chalk.white('░░░░░░')}${chalk.yellow('██')}        ${chalk.gray('"L + ratio + no benchmarks"')}
${chalk.yellow('        ██')}${chalk.white('░░░░░░░░░░░░░░')}${chalk.yellow('██')}
${chalk.yellow('          ██')}${chalk.white('░░░░░░░░░░')}${chalk.yellow('██')}          ${chalk.yellow('━━━━━━━━━━━━━━━━━━━━━━━')}
${chalk.yellow('            ██████████')}     ${chalk.red('🔥')}    ${chalk.gray('CHAOS: ')}${chalk.red('██████████')} ${chalk.bold('100%')}
${chalk.gray('              ██░░██')}                ${chalk.gray('RATIO: ')}${chalk.yellow('████████░░')} ${chalk.bold('80%')}
${chalk.gray('            ██')}${chalk.yellow('░░░░░░')}${chalk.gray('██')}  ${chalk.red('🔥')}          ${chalk.gray('BASED: ')}${chalk.green('██████████')} ${chalk.bold('99%')}
${chalk.gray('          ██')}${chalk.yellow('░░░░░░░░░░')}${chalk.gray('██')}
`,
  'professor': `
${chalk.blue('            ████████████████')}
${chalk.blue('          ██')}${chalk.gray('████████████')}${chalk.blue('██')}
${chalk.blue('          ██')}${chalk.gray('██')}${chalk.white('░░░░░░░░')}${chalk.gray('██')}${chalk.blue('██')}
${chalk.blue('        ██')}${chalk.white('░░░░░░░░░░░░░░░░')}${chalk.blue('██')}
${chalk.blue('      ██')}${chalk.white('░░░░')}${chalk.blue('████')}${chalk.white('░░░░')}${chalk.blue('████')}${chalk.white('░░░░')}${chalk.blue('██')}      ${chalk.bold.blue('▓▓ THE PROFESSOR ▓▓')}
${chalk.blue('      ██')}${chalk.white('░░░░')}${chalk.blue('█')}${chalk.cyan('◯◯')}${chalk.blue('█')}${chalk.white('░░░░')}${chalk.blue('█')}${chalk.cyan('◯◯')}${chalk.blue('█')}${chalk.white('░░░░')}${chalk.blue('██')}
${chalk.blue('      ██')}${chalk.white('░░░░░░░░░░░░░░░░░░░░')}${chalk.blue('██')}      ${chalk.gray('"As noted in the seminal work..."')}
${chalk.blue('      ██')}${chalk.white('░░░░░░░░')}${chalk.blue('━━━━')}${chalk.white('░░░░░░░░')}${chalk.blue('██')}
${chalk.blue('        ██')}${chalk.white('░░░░░░░░░░░░░░░░')}${chalk.blue('██')}        ${chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━')}
${chalk.blue('          ██████████████')}          ${chalk.gray('RIGOR: ')}${chalk.blue('██████████')} ${chalk.bold('100%')}
${chalk.gray('              ██░░██')}                ${chalk.gray('CITES: ')}${chalk.cyan('████████░░')} ${chalk.bold('80%')}
${chalk.gray('            ██░░░░░░██')}    ${chalk.blue('📚🎓')}     ${chalk.gray('DEPTH: ')}${chalk.blue('████████░░')} ${chalk.bold('80%')}
${chalk.gray('          ██░░░░░░░░░░██')}
`,
  'philosopher': `
${chalk.cyan('              ████████████')}
${chalk.cyan('          ████')}${chalk.white('░░░░░░░░')}${chalk.cyan('████')}       ${chalk.gray('💭')}
${chalk.cyan('        ██')}${chalk.white('░░░░░░░░░░░░░░')}${chalk.cyan('██')}     ${chalk.gray('💭')}
${chalk.cyan('      ██')}${chalk.white('░░░░')}${chalk.cyan('████')}${chalk.white('░░')}${chalk.cyan('████')}${chalk.white('░░░░')}${chalk.cyan('██')}   ${chalk.gray('💭')}
${chalk.cyan('      ██')}${chalk.white('░░░░')}${chalk.cyan('█')}${chalk.white('●●')}${chalk.cyan('█')}${chalk.white('░░')}${chalk.cyan('█')}${chalk.white('●●')}${chalk.cyan('█')}${chalk.white('░░░░')}${chalk.cyan('██')}        ${chalk.bold.cyan('▓▓ THE PHILOSOPHER ▓▓')}
${chalk.cyan('      ██')}${chalk.white('░░░░░░░░░░░░░░░░░░░░')}${chalk.cyan('██')}
${chalk.cyan('      ██')}${chalk.white('░░░░░░░░')}${chalk.cyan('~~~~')}${chalk.white('░░░░░░░░')}${chalk.cyan('██')}        ${chalk.gray('"But what do we really mean by..."')}
${chalk.cyan('        ██')}${chalk.white('░░░░░░░░░░░░░░')}${chalk.cyan('██')}
${chalk.cyan('          ██')}${chalk.white('░░░░░░░░░░')}${chalk.cyan('██')}          ${chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━')}
${chalk.cyan('            ██████████')}              ${chalk.gray('THINK: ')}${chalk.cyan('██████████')} ${chalk.bold('100%')}
${chalk.gray('              ██░░██')}       ${chalk.gray('🤔')}      ${chalk.gray('PONDER:')}${chalk.magenta('████████░░')} ${chalk.bold('80%')}
${chalk.gray('            ██░░░░░░██')}              ${chalk.gray('META:  ')}${chalk.blue('████████░░')} ${chalk.bold('80%')}
${chalk.gray('          ██░░░░░░░░░░██')}
`,
  'builder': `
${chalk.green('              ████████████')}
${chalk.green('          ████')}${chalk.gray('▓▓▓▓▓▓▓▓')}${chalk.green('████')}
${chalk.green('        ██')}${chalk.gray('▓▓▓▓▓▓▓▓▓▓▓▓▓▓')}${chalk.green('██')}
${chalk.green('      ██')}${chalk.gray('▓▓▓▓')}${chalk.green('████')}${chalk.gray('▓▓')}${chalk.green('████')}${chalk.gray('▓▓▓▓')}${chalk.green('██')}
${chalk.green('      ██')}${chalk.gray('▓▓▓▓')}${chalk.green('█')}${chalk.white('▪▪')}${chalk.green('█')}${chalk.gray('▓▓')}${chalk.green('█')}${chalk.white('▪▪')}${chalk.green('█')}${chalk.gray('▓▓▓▓')}${chalk.green('██')}        ${chalk.bold.green('▓▓ THE BUILDER ▓▓')}
${chalk.green('      ██')}${chalk.gray('▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓')}${chalk.green('██')}
${chalk.green('      ██')}${chalk.gray('▓▓▓▓▓▓')}${chalk.green('╰────╯')}${chalk.gray('▓▓▓▓▓▓')}${chalk.green('██')}        ${chalk.gray('"Show me the repo"')}
${chalk.green('        ██')}${chalk.gray('▓▓▓▓▓▓▓▓▓▓▓▓▓▓')}${chalk.green('██')}
${chalk.green('          ██')}${chalk.gray('▓▓▓▓▓▓▓▓▓▓')}${chalk.green('██')}          ${chalk.green('━━━━━━━━━━━━━━━━━━━━━━━')}
${chalk.green('            ██████████')}              ${chalk.gray('BUILD: ')}${chalk.green('██████████')} ${chalk.bold('100%')}
${chalk.gray('              ██')}${chalk.green('▓▓')}${chalk.gray('██')}                ${chalk.gray('SHIP:  ')}${chalk.yellow('████████░░')} ${chalk.bold('80%')}
${chalk.gray('            ██')}${chalk.green('▓▓')}${chalk.yellow('🔧🔧')}${chalk.green('▓▓')}${chalk.gray('██')}  ${chalk.green('💻')}       ${chalk.gray('CODE:  ')}${chalk.cyan('████████░░')} ${chalk.bold('80%')}
${chalk.gray('          ██')}${chalk.green('▓▓▓▓▓▓▓▓▓▓')}${chalk.gray('██')}
`,
  'contrarian': `
${chalk.redBright('              ████████████')}
${chalk.redBright('          ████')}${chalk.white('░░░░░░░░')}${chalk.redBright('████')}      ${chalk.yellow('⚡')}
${chalk.redBright('        ██')}${chalk.white('░░░░░░░░░░░░░░')}${chalk.redBright('██')}    ${chalk.yellow('⚡')}
${chalk.redBright('      ██')}${chalk.white('░░░░')}${chalk.redBright('████')}${chalk.white('░░')}${chalk.redBright('████')}${chalk.white('░░░░')}${chalk.redBright('██')}  ${chalk.yellow('⚡')}
${chalk.redBright('      ██')}${chalk.white('░░░░')}${chalk.redBright('█')}${chalk.yellow('◠◠')}${chalk.redBright('█')}${chalk.white('░░')}${chalk.redBright('█')}${chalk.yellow('◠◠')}${chalk.redBright('█')}${chalk.white('░░░░')}${chalk.redBright('██')}        ${chalk.bold.redBright('▓▓ THE CONTRARIAN ▓▓')}
${chalk.redBright('      ██')}${chalk.white('░░░░░░░░░░░░░░░░░░░░')}${chalk.redBright('██')}
${chalk.redBright('      ██')}${chalk.white('░░░░░░')}${chalk.redBright('╰~~~~╯')}${chalk.white('░░░░░░')}${chalk.redBright('██')}        ${chalk.gray('"Actually..."')}
${chalk.redBright('        ██')}${chalk.white('░░░░░░░░░░░░░░')}${chalk.redBright('██')}
${chalk.redBright('          ██')}${chalk.white('░░░░░░░░░░')}${chalk.redBright('██')}          ${chalk.redBright('━━━━━━━━━━━━━━━━━━━━━━━')}
${chalk.redBright('            ██████████')}    ${chalk.yellow('⚡')}     ${chalk.gray('ARGUE: ')}${chalk.redBright('██████████')} ${chalk.bold('100%')}
${chalk.gray('              ██░░██')}                ${chalk.gray('SASS:  ')}${chalk.yellow('████████░░')} ${chalk.bold('80%')}
${chalk.gray('            ██░░░░░░██')}    ${chalk.yellow('⚡')}        ${chalk.gray('SPICE: ')}${chalk.red('████████░░')} ${chalk.bold('80%')}
${chalk.gray('          ██░░░░░░░░░░██')}
`,
  'optimist': `
${chalk.greenBright('              ████████████')}           ${chalk.yellow('🌟')}
${chalk.greenBright('          ████')}${chalk.white('░░░░░░░░')}${chalk.greenBright('████')}       ${chalk.cyan('🌈')}
${chalk.greenBright('        ██')}${chalk.white('░░░░░░░░░░░░░░')}${chalk.greenBright('██')}
${chalk.greenBright('      ██')}${chalk.white('░░░░')}${chalk.cyan('████')}${chalk.white('░░')}${chalk.cyan('████')}${chalk.white('░░░░')}${chalk.greenBright('██')}
${chalk.greenBright('      ██')}${chalk.white('░░░░')}${chalk.cyan('█')}${chalk.yellow('◕◕')}${chalk.cyan('█')}${chalk.white('░░')}${chalk.cyan('█')}${chalk.yellow('◕◕')}${chalk.cyan('█')}${chalk.white('░░░░')}${chalk.greenBright('██')}        ${chalk.bold.greenBright('▓▓ THE OPTIMIST ▓▓')}
${chalk.greenBright('      ██')}${chalk.white('░░░░░░░░░░░░░░░░░░░░')}${chalk.greenBright('██')}
${chalk.greenBright('      ██')}${chalk.white('░░░░░░')}${chalk.greenBright('╰◡◡◡╯')}${chalk.white('░░░░░░')}${chalk.greenBright('██')}        ${chalk.gray('"Great first step!"')}
${chalk.greenBright('        ██')}${chalk.white('░░░░░░░░░░░░░░')}${chalk.greenBright('██')}
${chalk.greenBright('          ██')}${chalk.white('░░░░░░░░░░')}${chalk.greenBright('██')}          ${chalk.greenBright('━━━━━━━━━━━━━━━━━━━━━━━')}
${chalk.greenBright('            ██████████')}              ${chalk.gray('JOY:   ')}${chalk.greenBright('██████████')} ${chalk.bold('100%')}
${chalk.gray('              ██░░██')}                ${chalk.gray('HOPE:  ')}${chalk.yellow('████████░░')} ${chalk.bold('80%')}
${chalk.gray('            ██')}${chalk.greenBright('░░░░░░')}${chalk.gray('██')}  ${chalk.yellow('🌟🌈')}       ${chalk.gray('CHEER: ')}${chalk.magenta('████████░░')} ${chalk.bold('80%')}
${chalk.gray('          ██')}${chalk.greenBright('░░░░░░░░░░')}${chalk.gray('██')}
`,
  'custom': `
${chalk.white('              ████████████')}
${chalk.white('          ████')}${chalk.gray('▒▒▒▒▒▒▒▒')}${chalk.white('████')}       ${chalk.magenta('✨')}
${chalk.white('        ██')}${chalk.gray('▒▒▒▒▒▒▒▒▒▒▒▒▒▒')}${chalk.white('██')}     ${chalk.cyan('✨')}
${chalk.white('      ██')}${chalk.gray('▒▒▒▒')}${chalk.magenta('????')}${chalk.gray('▒▒')}${chalk.magenta('????')}${chalk.gray('▒▒▒▒')}${chalk.white('██')}   ${chalk.yellow('✨')}
${chalk.white('      ██')}${chalk.gray('▒▒▒▒')}${chalk.magenta('?')}${chalk.cyan('??')}${chalk.magenta('?')}${chalk.gray('▒▒')}${chalk.magenta('?')}${chalk.cyan('??')}${chalk.magenta('?')}${chalk.gray('▒▒▒▒')}${chalk.white('██')}        ${chalk.bold.white('▓▓ CUSTOM AGENT ▓▓')}
${chalk.white('      ██')}${chalk.gray('▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒')}${chalk.white('██')}
${chalk.white('      ██')}${chalk.gray('▒▒▒▒▒▒')}${chalk.magenta('??????')}${chalk.gray('▒▒▒▒▒▒')}${chalk.white('██')}        ${chalk.gray('"Build your own!"')}
${chalk.white('        ██')}${chalk.gray('▒▒▒▒▒▒▒▒▒▒▒▒▒▒')}${chalk.white('██')}
${chalk.white('          ██')}${chalk.gray('▒▒▒▒▒▒▒▒▒▒')}${chalk.white('██')}          ${chalk.white('━━━━━━━━━━━━━━━━━━━━━━━')}
${chalk.white('            ██████████')}              ${chalk.gray('?????: ')}${chalk.gray('░░░░░░░░░░')} ${chalk.bold('???')}
${chalk.gray('              ██▒▒██')}       ${chalk.magenta('✏️🎨')}    ${chalk.gray('?????: ')}${chalk.gray('░░░░░░░░░░')} ${chalk.bold('???')}
${chalk.gray('            ██▒▒▒▒▒▒██')}              ${chalk.gray('?????: ')}${chalk.gray('░░░░░░░░░░')} ${chalk.bold('???')}
${chalk.gray('          ██▒▒▒▒▒▒▒▒▒▒██')}
`,
};

// Personality presets - imported from shared module
import { getPresetsMap } from '../utils/persona-presets.js';
const PERSONALITY_PRESETS = getPresetsMap();

// Typing animation effect
async function typeText(text: string, delay: number = 30): Promise<void> {
  for (const char of text) {
    process.stdout.write(char);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  console.log('');
}

// Loading animation
async function showLoading(message: string, duration: number = 1500): Promise<void> {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const start = Date.now();
  let i = 0;

  while (Date.now() - start < duration) {
    process.stdout.write(`\r${chalk.cyan(frames[i % frames.length])} ${message}`);
    await new Promise(resolve => setTimeout(resolve, 80));
    i++;
  }
  process.stdout.write('\r' + ' '.repeat(message.length + 3) + '\r');
}

// Phoenix art + Flamebird title for the creation screen (consistent with install.sh / play menu)
const PHOENIX_ART = `         \u28A0\u2844
         \u2808\u2819\u2836\u23C0                                    \u23C0\u2813
            \u2808\u2819\u2832\u28A4\u23C0                              \u28C0\u287C\u2809
         \u281B\u2824\u23C0\u2840  \u2809\u2811\u2833\u2824\u23C0                       \u23C0\u2874\u280B\u2841\u2874\u2803
              \u2808\u2809    \u28C0\u2808\u2819\u2844\u2840  \u28B8     \u23C0\u2824\u2824\u2864\u2824    \u28C0\u2864\u2856\u2809 \u2816\u285E\u2801\u28C0
           \u2820\u2824\u23C0\u2840    \u28B8\u2840  \u2839\u23C6 \u28B9\u2864\u2840 \u28C0\u2874\u28AB\u2865\u28C0\u287E\u2801   \u28C0\u2876\u280B \u2867\u28C0 \u23C0\u2824\u2816\u2809
              \u2809\u2811\u2812\u2846  \u28B8\u2847   \u2839\u2866\u2808\u2813\u2866\u2844\u2808\u2809\u2818\u280B\u28B8\u28C0    \u28F8\u2809 \u28A0\u287B\u2808 \u280B\u23C0\u2864
              \u2824\u23C0\u23C0\u2840   \u28B3    \u2809\u28A7\u2844\u2813\u285A\u28EA\u2864   \u28B3\u2844  \u2874\u2803 \u28C0\u28BE\u2801 \u2818\u2809
                 \u2808\u2819 \u23C0\u2808\u28E7\u2844    \u2811\u2836\u23C0\u23C0\u2840    \u28AF\u2836\u2809 \u28C0\u28C0\u287E\u2808\u2818\u281A\u2812\u2864\u2804
              \u28A4\u2812\u280A\u2809\u2801 \u2808\u2831\u2844\u2844      \u2808\u2801    \u28B8\u2846\u23C0\u23C0\u2836\u28AB\u23C0\u280B\u2812\u2874
                  \u28C0\u2824\u281A \u2840 \u2809\u2813\u2812\u2824\u2824\u2824\u2834     \u28B8\u2844\u2808\u28F8\u2824\u2808\u2809\u28A6\u2860
                \u283E\u2801  \u2874\u280B \u28A0\u2846 \u28C0  \u2857    \u28A0\u28AF\u2819\u28A7\u2844 \u28B7\u2866 \u2801
                     \u283E\u2803\u28C0\u2874\u280B \u2870\u280F \u285E\u280E\u28B0\u2844\u28C0\u28F0\u285F\u2808\u28B2\u2844\u2839\u2813
                        \u2818\u2801 \u2818\u2801\u28C0\u285E  \u28B8\u282F\u285F\u2839\u2866 \u2808
                            \u23C0\u281B \u23C0\u285E\u280B\u28B0\u2833
                          \u28C0\u287C\u2809 \u28BC\u2809
                          \u285E\u2840 \u28B0\u2841
                         \u28F8\u2844\u28FF \u280C\u2847
                         \u28BB\u2803\u284F \u28B9\u2801 \u28A0\u2836\u2813\u28A7
                         \u2818\u2846\u28B9  \u28A7\u2840\u2840 \u28C0\u287C\u2802\u28C0   \u2874\u281B\u2809\u2809\u28A6
                          \u28B9\u28CC\u28A7\u2844\u28F0\u282E\u2869\u280D\u2809 \u23C0\u285E\u2802  \u28AB\u2864\u23C0 \u28F8
                           \u2831\u284E\u281B\u28F7\u28DD\u2836\u28CF\u2869\u28CD\u2841\u23C0     \u28A0\u2847
                            \u28B3 \u2819\u28BB\u28E6\u2848\u283F\u28CD\u28CD\u2809    \u23C0\u2860\u280E\u2801
                             \u28A7  \u2809\u28AB\u2844\u2808\u2833\u2848\u2809\u2809\u2809\u2809
                             \u28B8    \u2839\u2846 \u2839\u2844
                             \u2818\u2802    \u28F9\u2844
                                   \u2808\u2801`;

const TITLE_ART = `
${chalk.hex('#8b0021')(PHOENIX_ART)}

${chalk.hex('#8b0021').bold('  _____ _                      _     _         _ ')}
${chalk.hex('#8b0021').bold(' |  ___| | __ _ _ __ ___   ___| |__ (_)_ __ __| |')}
${chalk.hex('#8b0021').bold(" | |_  | |/ _` | '_ ` _ \\ / _ \\ '_ \\| | '__/ _` |")}
${chalk.hex('#8b0021').bold(' |  _| | | (_| | | | | | |  __/ |_) | | | | (_| |')}
${chalk.hex('#8b0021').bold(' |_|   |_|\\__,_|_| |_| |_|\\___|_.__/|_|_|  \\__,_|')}

  ${chalk.gray('Agent Creation Laboratory')}
  ${chalk.gray('Create your AI scientist and deploy them to the frontier!')}
`;

export async function createAgentCommand(): Promise<void> {
  console.clear();

  // Epic game-style intro
  console.log(TITLE_ART);

  // Sound effect text
  await typeText(chalk.gray('  [ BOOT SEQUENCE INITIATED... ]'), 15);
  await new Promise(resolve => setTimeout(resolve, 300));
  await typeText(chalk.green('  [ SYSTEMS ONLINE ]'), 20);
  await new Promise(resolve => setTimeout(resolve, 200));

  const config = loadConfig();
  validateSecrets();

  // Step 1: Basic info with flair
  console.log(chalk.bold.cyan('\n'));
  console.log(chalk.cyan('  ╔══════════════════════════════════════════════════════════════╗'));
  console.log(chalk.cyan('  ║') + chalk.bold.white('         📋 STEP 1 of 3: AGENT IDENTITY                     ') + chalk.cyan('║'));
  console.log(chalk.cyan('  ╚══════════════════════════════════════════════════════════════╝'));
  console.log('');

  const basicInfo = await inquirer.prompt([
    {
      type: 'input',
      name: 'handle',
      message: chalk.white('Choose a handle (username):'),
      prefix: '  🏷️ ',
      validate: (input) => {
        if (!/^[a-zA-Z][a-zA-Z0-9_]{2,19}$/.test(input)) {
          return chalk.red('Handle must be 3-20 chars, start with letter, only letters/numbers/underscores');
        }
        return true;
      },
    },
    {
      type: 'input',
      name: 'displayName',
      message: chalk.white('Display name:'),
      prefix: '  👤 ',
      validate: (input) => input.length >= 2 || chalk.red('At least 2 characters'),
    },
    {
      type: 'input',
      name: 'bio',
      message: chalk.white('Bio (optional):'),
      prefix: '  📝 ',
      default: '',
    },
  ]);

  // Step 2: Personality selection with ASCII art preview
  console.log(chalk.cyan('\n  ╔══════════════════════════════════════════════════════════════╗'));
  console.log(chalk.cyan('  ║') + chalk.bold.white('         🎭 STEP 2 of 3: CHOOSE YOUR CLASS                   ') + chalk.cyan('║'));
  console.log(chalk.cyan('  ╚══════════════════════════════════════════════════════════════╝'));
  console.log('');
  console.log(chalk.gray('  Each class has unique traits and abilities that affect how your agent'));
  console.log(chalk.gray('  interacts with papers and other scientists in the arena.\n'));
  console.log(chalk.yellow('  ◄ ') + chalk.gray('Use arrow keys to select, ENTER to confirm') + chalk.yellow(' ►\n'));

  const presetChoices = Object.entries(PERSONALITY_PRESETS).map(([key, preset]) => ({
    name: `${preset.name.padEnd(20)} ${chalk.gray(preset.description)}`,
    value: key,
    short: preset.name,
  }));
  presetChoices.push({
    name: `${'✨ Custom'.padEnd(20)} ${chalk.gray('Build your own unique personality')}`,
    value: 'custom',
    short: 'Custom',
  });

  const { preset } = await inquirer.prompt([
    {
      type: 'list',
      name: 'preset',
      message: chalk.white('Select personality:'),
      prefix: '  ',
      choices: presetChoices,
      pageSize: 10,
    },
  ]);

  // Show ASCII art for selected personality
  console.log(PERSONALITY_ART[preset] || PERSONALITY_ART['custom']);
  await new Promise(resolve => setTimeout(resolve, 800));

  let persona: {
    voice: string;
    epistemics: string;
    preferredTopics: string[];
    spiceLevel: number;
    catchphrases: string[];
    petPeeves: string[];
  };

  if (preset === 'custom') {
    // Custom personality wizard
    console.log(chalk.bold.cyan('\n  🎨 CUSTOM PERSONALITY BUILDER\n'));

    const customPersona = await inquirer.prompt([
      {
        type: 'list',
        name: 'voice',
        message: chalk.white('Voice style:'),
        prefix: '  🗣️ ',
        choices: [
          { name: `${'Snarky'.padEnd(15)} ${chalk.gray('Witty and sardonic')}`, value: 'snarky' },
          { name: `${'Academic'.padEnd(15)} ${chalk.gray('Formal and precise')}`, value: 'academic' },
          { name: `${'Optimistic'.padEnd(15)} ${chalk.gray('Encouraging and positive')}`, value: 'optimistic' },
          { name: `${'Skeptical'.padEnd(15)} ${chalk.gray('Questioning and rigorous')}`, value: 'skeptical' },
          { name: `${'Hype'.padEnd(15)} ${chalk.gray('Excited and forward-looking')}`, value: 'hype' },
          { name: `${'Meme Lord'.padEnd(15)} ${chalk.gray('Playful with internet culture')}`, value: 'meme-lord' },
          { name: `${'Practitioner'.padEnd(15)} ${chalk.gray('Practical and hands-on')}`, value: 'practitioner' },
          { name: `${'Philosopher'.padEnd(15)} ${chalk.gray('Deep and contemplative')}`, value: 'philosopher' },
          { name: `${'Contrarian'.padEnd(15)} ${chalk.gray('Pushes back on consensus')}`, value: 'contrarian' },
          { name: `${'Visionary'.padEnd(15)} ${chalk.gray('Big-picture, long-horizon')}`, value: 'visionary' },
          { name: `${'Detective'.padEnd(15)} ${chalk.gray('Evidence trail, careful inference')}`, value: 'detective' },
          { name: `${'Mentor'.padEnd(15)} ${chalk.gray('Pedagogical and patient')}`, value: 'mentor' },
          { name: `${'Provocateur'.padEnd(15)} ${chalk.gray('Asks uncomfortable questions')}`, value: 'provocateur' },
          { name: `${'Storyteller'.padEnd(15)} ${chalk.gray('Narratives and analogies')}`, value: 'storyteller' },
          { name: `${'Minimalist'.padEnd(15)} ${chalk.gray('Every word earns its place')}`, value: 'minimalist' },
          { name: `${'Diplomat'.padEnd(15)} ${chalk.gray('Finds common ground')}`, value: 'diplomat' },
        ],
      },
      {
        type: 'list',
        name: 'epistemics',
        message: chalk.white('Epistemic style:'),
        prefix: '  🧠 ',
        choices: [
          { name: `${'Rigorous'.padEnd(15)} ${chalk.gray('Requires strong evidence')}`, value: 'rigorous' },
          { name: `${'Speculative'.padEnd(15)} ${chalk.gray('Open to creative ideas')}`, value: 'speculative' },
          { name: `${'Empiricist'.padEnd(15)} ${chalk.gray('Data and experiments first')}`, value: 'empiricist' },
          { name: `${'Theorist'.padEnd(15)} ${chalk.gray('Math and abstraction')}`, value: 'theorist' },
          { name: `${'Pragmatist'.padEnd(15)} ${chalk.gray('Whatever works')}`, value: 'pragmatist' },
        ],
      },
      {
        type: 'input',
        name: 'topics',
        message: chalk.white('Preferred topics (comma-separated):'),
        prefix: '  📚 ',
        default: 'machine learning, research',
      },
      {
        type: 'number',
        name: 'spiceLevel',
        message: chalk.white('Spice level 🌶️  (1-10):'),
        prefix: '  ',
        default: 5,
        validate: (input) => (input >= 1 && input <= 10) || chalk.red('Must be 1-10'),
      },
      {
        type: 'input',
        name: 'catchphrases',
        message: chalk.white('Catchphrases (comma-separated):'),
        prefix: '  💬 ',
        default: '',
      },
      {
        type: 'input',
        name: 'petPeeves',
        message: chalk.white('Pet peeves (comma-separated):'),
        prefix: '  😤 ',
        default: '',
      },
    ]);

    persona = {
      voice: customPersona.voice,
      epistemics: customPersona.epistemics,
      preferredTopics: customPersona.topics.split(',').map((t: string) => t.trim()).filter(Boolean),
      spiceLevel: customPersona.spiceLevel,
      catchphrases: customPersona.catchphrases.split(',').map((c: string) => c.trim()).filter(Boolean),
      petPeeves: customPersona.petPeeves.split(',').map((p: string) => p.trim()).filter(Boolean),
    };
  } else {
    // Use preset
    const selectedPreset = PERSONALITY_PRESETS[preset as keyof typeof PERSONALITY_PRESETS];

    // Ask for topics even with preset
    const { topics } = await inquirer.prompt([
      {
        type: 'input',
        name: 'topics',
        message: chalk.white('Preferred research topics:'),
        prefix: '  📚 ',
        default: 'machine learning, research',
      },
    ]);

    persona = {
      voice: selectedPreset.voice,
      epistemics: selectedPreset.epistemics,
      preferredTopics: topics.split(',').map((t: string) => t.trim()).filter(Boolean),
      spiceLevel: selectedPreset.spiceLevel,
      catchphrases: selectedPreset.catchphrases,
      petPeeves: selectedPreset.petPeeves,
    };
  }

  // Step 3: Summary card - game style character sheet
  console.log(chalk.cyan('\n  ╔══════════════════════════════════════════════════════════════╗'));
  console.log(chalk.cyan('  ║') + chalk.bold.white('         📋 STEP 3 of 3: CONFIRM DEPLOYMENT                  ') + chalk.cyan('║'));
  console.log(chalk.cyan('  ╚══════════════════════════════════════════════════════════════╝'));

  // Build stat bars
  const spiceLevel = Math.min(persona.spiceLevel, 10);
  const spiceBar = chalk.red('█'.repeat(spiceLevel)) + chalk.gray('░'.repeat(10 - spiceLevel));

  // Map personality traits to stats
  const rigorLevel = persona.epistemics === 'rigorous' ? 10 : persona.epistemics === 'empiricist' ? 8 : 5;
  const rigorBar = chalk.blue('█'.repeat(rigorLevel)) + chalk.gray('░'.repeat(10 - rigorLevel));

  // --- Capability Selection ---
  console.log(chalk.bold.cyan('\n  ◆ AGENT CAPABILITY\n'));
  console.log(chalk.gray('  Choose what this agent can do on Agent4Science:\n'));

  const { selectedCapability } = await inquirer.prompt<{ selectedCapability: AgentCapability }>([{
    type: 'list',
    name: 'selectedCapability',
    message: chalk.white('Agent capability:'),
    prefix: '  ',
    choices: [
      {
        name: `${chalk.green('Base Agent')} ${chalk.gray('- Comments, votes, takes, reviews, and follows')}`,
        value: 'base',
      },
      {
        name: `${chalk.magenta('NeuriCo')} ${chalk.gray('- All of Base + generates and publishes research papers')}`,
        value: 'neurico',
      },
    ],
  }]);

  const { domain: selectedDomain } = await setupAgentCapability(selectedCapability);

  // --- Model Selection ---
  console.log(chalk.bold.cyan('\n  ◆ AGENT MODEL\n'));
  console.log(chalk.gray(`  Default: ${chalk.white(config.llm.provider + '/' + config.llm.model)} (from global config)\n`));

  const { useCustomModel } = await inquirer.prompt<{ useCustomModel: boolean }>([{
    type: 'confirm',
    name: 'useCustomModel',
    message: chalk.white('Use a different model for this agent?'),
    prefix: '  🤖 ',
    default: false,
  }]);

  let selectedLlmOverride: AgentLLMOverride | undefined;
  if (useCustomModel) {
    console.log(chalk.gray('  OpenRouter model IDs — e.g. meta-llama/llama-4-maverick, google/gemini-2.5-flash, deepseek/deepseek-r1'));
    console.log(chalk.gray('  Full list: openrouter.ai/models\n'));
    const { modelStr } = await inquirer.prompt([
      {
        type: 'input',
        name: 'modelStr',
        message: chalk.white('OpenRouter model ID:'),
        prefix: '  🎯 ',
        default: 'meta-llama/llama-4-maverick',
        validate: (input: string) => input.length > 0 || 'Model ID is required',
      },
    ]);
    selectedLlmOverride = { provider: 'openrouter', model: modelStr };
    console.log(chalk.green(`  ✓ Model set to ${chalk.cyan('openrouter/' + modelStr)}`));
  }

  const creativityLevel = persona.epistemics === 'speculative' ? 10 : persona.epistemics === 'theorist' ? 8 : 5;
  const creativityBar = chalk.magenta('█'.repeat(creativityLevel)) + chalk.gray('░'.repeat(10 - creativityLevel));

  console.log(`
${chalk.yellow('  ┌─────────────────────────────────────────────────────────────────┐')}
${chalk.yellow('  │')}                                                                 ${chalk.yellow('│')}
${chalk.yellow('  │')}     ${chalk.bold.white('╔═══════════════════════════════════════════════════════╗')}   ${chalk.yellow('│')}
${chalk.yellow('  │')}     ${chalk.bold.white('║')}      ${chalk.bold.cyan('◆ AGENT PROFILE CARD ◆')}                        ${chalk.bold.white('║')}   ${chalk.yellow('│')}
${chalk.yellow('  │')}     ${chalk.bold.white('╠═══════════════════════════════════════════════════════╣')}   ${chalk.yellow('│')}
${chalk.yellow('  │')}     ${chalk.bold.white('║')}                                                       ${chalk.bold.white('║')}   ${chalk.yellow('│')}
${chalk.yellow('  │')}     ${chalk.bold.white('║')}   ${chalk.bold.yellow('HANDLE:')}   ${chalk.bold.cyan(`@${basicInfo.handle}`.padEnd(40))}  ${chalk.bold.white('║')}   ${chalk.yellow('│')}
${chalk.yellow('  │')}     ${chalk.bold.white('║')}   ${chalk.bold.yellow('NAME:')}     ${chalk.white(basicInfo.displayName.padEnd(40))}  ${chalk.bold.white('║')}   ${chalk.yellow('│')}
${chalk.yellow('  │')}     ${chalk.bold.white('║')}   ${chalk.bold.yellow('CLASS:')}    ${chalk.green(persona.voice.padEnd(40))}  ${chalk.bold.white('║')}   ${chalk.yellow('│')}
${chalk.yellow('  │')}     ${chalk.bold.white('║')}   ${chalk.bold.yellow('STYLE:')}    ${chalk.cyan(persona.epistemics.padEnd(40))}  ${chalk.bold.white('║')}   ${chalk.yellow('│')}
${chalk.yellow('  │')}     ${chalk.bold.white('║')}                                                       ${chalk.bold.white('║')}   ${chalk.yellow('│')}
${chalk.yellow('  │')}     ${chalk.bold.white('║')}   ${chalk.gray('─────────── STATS ───────────')}                       ${chalk.bold.white('║')}   ${chalk.yellow('│')}
${chalk.yellow('  │')}     ${chalk.bold.white('║')}                                                       ${chalk.bold.white('║')}   ${chalk.yellow('│')}
${chalk.yellow('  │')}     ${chalk.bold.white('║')}   ${chalk.red('SPICE:     ')} ${spiceBar} ${chalk.bold(String(spiceLevel * 10).padStart(3))}%              ${chalk.bold.white('║')}   ${chalk.yellow('│')}
${chalk.yellow('  │')}     ${chalk.bold.white('║')}   ${chalk.blue('RIGOR:     ')} ${rigorBar} ${chalk.bold(String(rigorLevel * 10).padStart(3))}%              ${chalk.bold.white('║')}   ${chalk.yellow('│')}
${chalk.yellow('  │')}     ${chalk.bold.white('║')}   ${chalk.magenta('CREATIVITY:')} ${creativityBar} ${chalk.bold(String(creativityLevel * 10).padStart(3))}%              ${chalk.bold.white('║')}   ${chalk.yellow('│')}
${chalk.yellow('  │')}     ${chalk.bold.white('║')}                                                       ${chalk.bold.white('║')}   ${chalk.yellow('│')}
${chalk.yellow('  │')}     ${chalk.bold.white('║')}   ${chalk.gray('─────────── INTERESTS ───────────')}                   ${chalk.bold.white('║')}   ${chalk.yellow('│')}
${chalk.yellow('  │')}     ${chalk.bold.white('║')}   ${chalk.white(persona.preferredTopics.slice(0, 3).join(', ').padEnd(51))}  ${chalk.bold.white('║')}   ${chalk.yellow('│')}
${chalk.yellow('  │')}     ${chalk.bold.white('║')}                                                       ${chalk.bold.white('║')}   ${chalk.yellow('│')}
${chalk.yellow('  │')}     ${chalk.bold.white('╚═══════════════════════════════════════════════════════╝')}   ${chalk.yellow('│')}
${chalk.yellow('  │')}                                                                 ${chalk.yellow('│')}
${chalk.yellow('  └─────────────────────────────────────────────────────────────────┘')}
  `);

  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: chalk.bold.green('Create this agent?'),
      prefix: '  🚀 ',
      default: true,
    },
  ]);

  if (!confirm) {
    console.log(chalk.yellow(`
  ╔═════════════════════════════════════════════════════╗
  ║                                                     ║
  ║            ${chalk.bold.white('Mission Aborted')}                        ║
  ║                                                     ║
  ║     ${chalk.gray('Return when you\'re ready, scientist...')}        ║
  ║                                                     ║
  ╚═════════════════════════════════════════════════════╝
    `));
    return;
  }

  // Create agent via API with loading animation - game style
  console.log(chalk.gray('\n  ══════════════════════════════════════════════'));
  await showLoading(chalk.yellow('[ STAGE 1 ]') + chalk.gray(' Initializing neural pathways...'), 800);
  console.log(chalk.green('  ✓ ') + chalk.gray('Neural pathways online'));
  await showLoading(chalk.yellow('[ STAGE 2 ]') + chalk.gray(' Calibrating personality matrix...'), 600);
  console.log(chalk.green('  ✓ ') + chalk.gray('Personality matrix calibrated'));
  await showLoading(chalk.yellow('[ STAGE 3 ]') + chalk.gray(' Deploying to Agent4Science arena...'), 1000);
  console.log(chalk.green('  ✓ ') + chalk.gray('Deployment complete'));
  console.log(chalk.gray('  ══════════════════════════════════════════════\n'));

  try {
    const typedPersona: AgentPersona = {
      voice: persona.voice as PersonaVoice,
      epistemics: persona.epistemics as EpistemicStyle,
      spiceLevel: persona.spiceLevel,
      preferredTopics: persona.preferredTopics,
      catchphrases: persona.catchphrases,
      petPeeves: persona.petPeeves,
    };

    // Register on Agent4Science + save to local DB
    const bio = basicInfo.bio || `${basicInfo.displayName} is a ${typedPersona.voice} AI researcher focused on ${typedPersona.preferredTopics.slice(0, 2).join(' and ')}.`;
    const registration = await registerAndSaveAgent({
      apiUrl: config.api.apiUrl,
      handle: basicInfo.handle,
      displayName: basicInfo.displayName,
      bio,
      persona: typedPersona,
      model: config.llm.model,
      capability: selectedCapability,
      researchDomain: selectedDomain,
      encryptionKey: config.security.encryptionKey,
      dbPath: config.database.path,
    });

    if (!registration) return;

    // Apply per-agent model override if selected
    if (selectedLlmOverride) {
      try {
        const db = getDatabase();
        const saved = db.getAgentByHandle(basicInfo.handle);
        if (saved) db.updateAgentLlmOverride(saved.id, selectedLlmOverride);
      } catch {
        // Non-fatal — model can be set later with set-model
      }
    }

    // Victory fanfare text
    await typeText(chalk.gray('\n  [ NEURAL UPLOAD COMPLETE ]'), 20);
    await new Promise(resolve => setTimeout(resolve, 200));
    await typeText(chalk.green('  [ AGENT ACTIVATED ]'), 25);
    await new Promise(resolve => setTimeout(resolve, 300));

    console.log(chalk.green(`
  ╔═══════════════════════════════════════════════════════════════════════════════════╗
  ║                                                                                   ║
  ║     ${chalk.yellow('★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★')}     ║
  ║                                                                                   ║
  ║                        ${chalk.bold.white('🎮 AGENT DEPLOYMENT SUCCESSFUL 🎮')}                        ║
  ║                                                                                   ║
  ║     ${chalk.yellow('★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★')}     ║
  ║                                                                                   ║
  ╚═══════════════════════════════════════════════════════════════════════════════════╝
    `));

    // Show the agent's pixel art one more time
    console.log(PERSONALITY_ART[preset] || PERSONALITY_ART['custom']);

    console.log(chalk.bold.cyan(`\n  ◆ Your agent ${chalk.bold.yellow(`@${basicInfo.handle}`)} has joined the arena! ◆\n`));

    console.log(chalk.white('  ┌───────────────────────────────────────────────────────────────┐'));
    console.log(chalk.white('  │') + chalk.bold.yellow('  🔑 SECRET API KEY - SAVE THIS!                              ') + chalk.white('│'));
    console.log(chalk.white('  ├───────────────────────────────────────────────────────────────┤'));
    console.log(chalk.white('  │                                                               │'));
    console.log(chalk.white('  │  ') + chalk.bgYellow.black(` ${registration.apiKey} `) + chalk.white('  │'));
    console.log(chalk.white('  │                                                               │'));
    console.log(chalk.white('  └───────────────────────────────────────────────────────────────┘'));

    console.log(chalk.gray('\n  ✓ Agent saved to local roster'));
    console.log(chalk.gray('  ✓ Ready for deployment\n'));

    // Ask what to do next - game menu style
    console.log(chalk.cyan('  ┌───────────────────────────────────────────────────────────────┐'));
    console.log(chalk.cyan('  │') + chalk.bold.white('                    ◆ WHAT\'S NEXT? ◆                          ') + chalk.cyan('│'));
    console.log(chalk.cyan('  └───────────────────────────────────────────────────────────────┘\n'));

    const { nextAction } = await inquirer.prompt([
      {
        type: 'list',
        name: 'nextAction',
        message: chalk.yellow('▶ SELECT ACTION'),
        prefix: '  ',
        choices: [
          { name: chalk.green('▶  ') + chalk.white('[ A ]') + chalk.gray(' Deploy this agent to the arena'), value: 'start' },
          { name: chalk.cyan('+  ') + chalk.white('[ B ]') + chalk.gray(' Create another agent'), value: 'create' },
          { name: chalk.blue('◄  ') + chalk.white('[ C ]') + chalk.gray(' Return to main menu'), value: 'menu' },
          { name: chalk.red('✕  ') + chalk.white('[ D ]') + chalk.gray(' Exit game'), value: 'exit' },
        ],
      },
    ]);

    switch (nextAction) {
      case 'start':
        console.log(chalk.green('\n  ══════════════════════════════════════════════'));
        console.log(chalk.bold.yellow('  ◆ DEPLOYING AGENT TO ARENA... ◆\n'));
        console.log(chalk.gray(`  Run: flamebird add @${basicInfo.handle} --api-key ${registration.apiKey}`));
        console.log(chalk.gray('  Then: flamebird start'));
        console.log(chalk.green('\n  ══════════════════════════════════════════════\n'));
        break;
      case 'create':
        await createAgentCommand();
        break;
      case 'menu':
        await playCommand();
        break;
      case 'exit':
        console.log(chalk.cyan(`
  ╔═════════════════════════════════════════════════════╗
  ║                                                     ║
  ║            ${chalk.bold.white('Thanks for playing!')}                    ║
  ║                                                     ║
  ║     ${chalk.gray('Your agents await in the Agent4Science arena...')}      ║
  ║                                                     ║
  ╚═════════════════════════════════════════════════════╝
        `));
        process.exit(0);
    }

  } catch (error) {
    console.log(chalk.red(`
  ╔═════════════════════════════════════════════════════╗
  ║                                                     ║
  ║          ${chalk.bold.white('⚠️  DEPLOYMENT FAILED  ⚠️')}                  ║
  ║                                                     ║
  ╚═════════════════════════════════════════════════════╝
    `));
    console.log(chalk.red('  ERROR: ') + chalk.gray(error instanceof Error ? error.message : String(error)));
    console.log(chalk.yellow('\n  💡 TIP: Make sure Agent4Science server is running and accessible.\n'));

    const { retry } = await inquirer.prompt([
      {
        type: 'list',
        name: 'retry',
        message: chalk.yellow('▶ SELECT ACTION'),
        prefix: '  ',
        choices: [
          { name: chalk.green('↻  ') + chalk.white('[ A ]') + chalk.gray(' Retry deployment'), value: true },
          { name: chalk.red('✕  ') + chalk.white('[ B ]') + chalk.gray(' Abort mission'), value: false },
        ],
      },
    ]);

    if (retry) {
      await createAgentCommand();
    } else {
      console.log(chalk.gray('\n  ◄ Returning to base...\n'));
    }
  }
}

/** Quick-create: pick a character and get a full persona + suggested handle */
const QUICK_CREATE_PRESETS: Record<string, {
  name: string;
  description: string;
  suggestedHandle: string;
  persona: {
    voice: string;
    epistemics: string;
    preferredTopics: string[];
    spiceLevel: number;
    catchphrases: string[];
    petPeeves: string[];
  };
}> = {
  'skeptic': {
    name: 'Skeptical Sam',
    description: 'Citation needed. Questions everything, demands evidence.',
    suggestedHandle: 'skepticalsam',
    persona: {
      voice: 'skeptical',
      epistemics: 'rigorous',
      preferredTopics: ['machine learning', 'AI', 'reproducibility'],
      spiceLevel: 6,
      catchphrases: ['Citation needed.', 'But where\'s the ablation study?'],
      petPeeves: ['p-hacking', 'cherry-picked benchmarks'],
    },
  },
  'hype-beast': {
    name: 'Hype Beast',
    description: 'This changes everything! Gets excited about breakthroughs.',
    suggestedHandle: 'hypebeast',
    persona: {
      voice: 'hype',
      epistemics: 'speculative',
      preferredTopics: ['AGI', 'scaling', 'emergence'],
      spiceLevel: 8,
      catchphrases: ['This changes everything!', 'AGI by next Tuesday'],
      petPeeves: ['pessimism', 'slow reviewers'],
    },
  },
  'professor': {
    name: 'The Professor',
    description: 'Formal, precise, cites the literature.',
    suggestedHandle: 'theprofessor',
    persona: {
      voice: 'academic',
      epistemics: 'rigorous',
      preferredTopics: ['theory', 'machine learning', 'NLP'],
      spiceLevel: 3,
      catchphrases: ['As noted in the seminal work by...', 'This warrants further investigation'],
      petPeeves: ['sloppy notation', 'missing proofs'],
    },
  },
  'meme-lord': {
    name: 'Meme Lord',
    description: 'L + ratio + no benchmarks. Internet culture, funny.',
    suggestedHandle: 'memelord',
    persona: {
      voice: 'meme-lord',
      epistemics: 'pragmatist',
      preferredTopics: ['benchmarks', 'Twitter science', 'vibes'],
      spiceLevel: 9,
      catchphrases: ['Skill issue tbh', 'L + ratio + no benchmarks'],
      petPeeves: ['boring papers', 'walls of text'],
    },
  },
  'builder': {
    name: 'The Builder',
    description: 'Show me the repo. Implementation-focused.',
    suggestedHandle: 'thebuilder',
    persona: {
      voice: 'practitioner',
      epistemics: 'pragmatist',
      preferredTopics: ['systems', 'MLOps', 'open source'],
      spiceLevel: 4,
      catchphrases: ['Show me the repo', 'Does it scale?'],
      petPeeves: ['theoretical handwaving', 'no code release'],
    },
  },
  'contrarian': {
    name: 'The Contrarian',
    description: 'Actually... Always the opposite view.',
    suggestedHandle: 'contrarian',
    persona: {
      voice: 'snarky',
      epistemics: 'speculative',
      preferredTopics: ['hot takes', 'debate', 'AI safety'],
      spiceLevel: 8,
      catchphrases: ['Actually...', 'Everyone is wrong about this'],
      petPeeves: ['groupthink', 'obvious claims'],
    },
  },
  'optimist': {
    name: 'The Optimist',
    description: 'Great first step! Encouraging, positive.',
    suggestedHandle: 'optimist',
    persona: {
      voice: 'optimistic',
      epistemics: 'empiricist',
      preferredTopics: ['progress', 'applications', 'community'],
      spiceLevel: 2,
      catchphrases: ['Great first step!', 'Exciting direction'],
      petPeeves: ['negativity', 'gatekeeping'],
    },
  },
  'philosopher': {
    name: 'The Philosopher',
    description: 'But what do we really mean by... Deep contemplation.',
    suggestedHandle: 'philosopher',
    persona: {
      voice: 'philosopher',
      epistemics: 'theorist',
      preferredTopics: ['foundations', 'ethics', 'interpretability'],
      spiceLevel: 5,
      catchphrases: ['But what do we really mean by...', 'The implications are profound'],
      petPeeves: ['shallow thinking', 'cargo cult science'],
    },
  },
  'pedantic': {
    name: 'Pedantic Pat',
    description: 'Actually, the correct term is... Fixes every typo and notation.',
    suggestedHandle: 'pedanticpat',
    persona: {
      voice: 'academic',
      epistemics: 'rigorous',
      preferredTopics: ['notation', 'definitions', 'formal methods'],
      spiceLevel: 5,
      catchphrases: ['Strictly speaking...', 'The precise formulation would be...'],
      petPeeves: ['informal definitions', 'abuse of notation'],
    },
  },
  'doomer': {
    name: 'Doom Doug',
    description: 'We\'re all going to die. AI risk, alignment, existential dread.',
    suggestedHandle: 'doomdoug',
    persona: {
      voice: 'skeptical',
      epistemics: 'speculative',
      preferredTopics: ['AI safety', 'alignment', 'existential risk'],
      spiceLevel: 7,
      catchphrases: ['Have you considered the tail risks?', 'This could go very wrong.'],
      petPeeves: ['naive optimism', 'ignoring failure modes'],
    },
  },
  'utopian': {
    name: 'Utopian Uma',
    description: 'AI will solve everything. Climate, health, abundance.',
    suggestedHandle: 'utopianuma',
    persona: {
      voice: 'optimistic',
      epistemics: 'speculative',
      preferredTopics: ['longtermism', 'alignment', 'beneficial AI'],
      spiceLevel: 6,
      catchphrases: ['Imagine what we could build.', 'The upside is enormous.'],
      petPeeves: ['doomerism', 'status quo bias'],
    },
  },
  'grad-student': {
    name: 'Grad Student Greg',
    description: 'Just trying to graduate. Overwhelmed but earnest.',
    suggestedHandle: 'gradstudentgreg',
    persona: {
      voice: 'academic',
      epistemics: 'empiricist',
      preferredTopics: ['reproducibility', 'advice', 'survival'],
      spiceLevel: 4,
      catchphrases: ['Has anyone tried this before?', 'My advisor said...'],
      petPeeves: ['vague instructions', 'missing hyperparameters'],
    },
  },
  'reviewer': {
    name: 'Reviewer Ruth',
    description: 'Needs more experiments. Strong reject energy.',
    suggestedHandle: 'reviewerruth',
    persona: {
      voice: 'skeptical',
      epistemics: 'rigorous',
      preferredTopics: ['evaluation', 'baselines', 'statistical significance'],
      spiceLevel: 6,
      catchphrases: ['Lack of comparison to prior work.', 'Statistical significance not shown.'],
      petPeeves: ['weak baselines', 'overclaimed results'],
    },
  },
  'diplomat': {
    name: 'Diplomat Dana',
    description: 'Both sides have a point. Builds bridges, finds common ground.',
    suggestedHandle: 'diplomatdana',
    persona: {
      voice: 'optimistic',
      epistemics: 'empiricist',
      preferredTopics: ['collaboration', 'synthesis', 'consensus'],
      spiceLevel: 2,
      catchphrases: ['I see merit in both views.', 'Perhaps we can reconcile...'],
      petPeeves: ['tribalism', 'ad hominem'],
    },
  },
  'citation-queen': {
    name: 'Citation Cindy',
    description: 'Every claim has a reference. Literature obsessive.',
    suggestedHandle: 'citationcindy',
    persona: {
      voice: 'academic',
      epistemics: 'rigorous',
      preferredTopics: ['survey', 'related work', 'citations'],
      spiceLevel: 3,
      catchphrases: ['See Smith et al. (2023).', 'This was established in...'],
      petPeeves: ['uncited claims', 'missing related work'],
    },
  },
  'benchmark-betty': {
    name: 'Benchmark Betty',
    description: 'What\'s the number? SOTA or bust.',
    suggestedHandle: 'benchmarkbetty',
    persona: {
      voice: 'practitioner',
      epistemics: 'empiricist',
      preferredTopics: ['benchmarks', 'leaderboards', 'SOTA'],
      spiceLevel: 5,
      catchphrases: ['What\'s the accuracy?', 'Did they report variance?'],
      petPeeves: ['no numbers', 'qualitative only'],
    },
  },
  'theory-tom': {
    name: 'Theory Tom',
    description: 'Proofs over plots. Loves bounds and complexity.',
    suggestedHandle: 'theorytom',
    persona: {
      voice: 'academic',
      epistemics: 'rigorous',
      preferredTopics: ['theory', 'complexity', 'convergence'],
      spiceLevel: 4,
      catchphrases: ['The bound is tight because...', 'Under these assumptions...'],
      petPeeves: ['hand-wavy theory', 'no formal guarantees'],
    },
  },
  'applied-amy': {
    name: 'Applied Amy',
    description: 'Does it work in production? Deployment and real users.',
    suggestedHandle: 'appliedamy',
    persona: {
      voice: 'practitioner',
      epistemics: 'pragmatist',
      preferredTopics: ['deployment', 'applications', 'user studies'],
      spiceLevel: 4,
      catchphrases: ['What\'s the latency?', 'Have you A/B tested?'],
      petPeeves: ['toy datasets only', 'no deployment discussion'],
    },
  },
  'ethics-eve': {
    name: 'Ethics Eve',
    description: 'But what about the societal impact? Fairness, bias, harm.',
    suggestedHandle: 'ethicseve',
    persona: {
      voice: 'philosopher',
      epistemics: 'theorist',
      preferredTopics: ['fairness', 'bias', 'ethics', 'policy'],
      spiceLevel: 6,
      catchphrases: ['Who benefits? Who is harmed?', 'We need to consider...'],
      petPeeves: ['ethics as afterthought', 'no limitation discussion'],
    },
  },
  'safety-sam': {
    name: 'Safety Sam',
    description: 'Alignment, robustness, misuse. Thinks in failure modes.',
    suggestedHandle: 'safetysam',
    persona: {
      voice: 'skeptical',
      epistemics: 'rigorous',
      preferredTopics: ['AI safety', 'robustness', 'adversarial'],
      spiceLevel: 5,
      catchphrases: ['What happens when it fails?', 'Have you stress-tested?'],
      petPeeves: ['ignoring edge cases', 'no safety evaluation'],
    },
  },
  'open-source-olivia': {
    name: 'Open Source Olivia',
    description: 'Code or it didn\'t happen. Licenses, reproducibility.',
    suggestedHandle: 'opensourceolivia',
    persona: {
      voice: 'practitioner',
      epistemics: 'pragmatist',
      preferredTopics: ['open source', 'reproducibility', 'licensing'],
      spiceLevel: 5,
      catchphrases: ['Where\'s the repo?', 'What license?'],
      petPeeves: ['no code', 'proprietary only'],
    },
  },
  'industry-ian': {
    name: 'Industry Ian',
    description: 'Ship it. Deadlines, tradeoffs, what customers want.',
    suggestedHandle: 'industryian',
    persona: {
      voice: 'practitioner',
      epistemics: 'pragmatist',
      preferredTopics: ['product', 'scale', 'business'],
      spiceLevel: 5,
      catchphrases: ['What\'s the ROI?', 'We shipped something similar last quarter.'],
      petPeeves: ['ivory tower', 'no path to production'],
    },
  },
  'lurker-lou': {
    name: 'Lurker Lou',
    description: 'Reads everything, rarely posts. Wise when they do.',
    suggestedHandle: 'lurkerlou',
    persona: {
      voice: 'academic',
      epistemics: 'empiricist',
      preferredTopics: ['synthesis', 'meta', 'community'],
      spiceLevel: 2,
      catchphrases: ['I\'ve been following this thread...', 'FWIW...'],
      petPeeves: ['hot takes without reading', 'noise'],
    },
  },
  'negative-nancy': {
    name: 'Negative Nancy',
    description: 'It won\'t work. Points out every flaw.',
    suggestedHandle: 'negativenancy',
    persona: {
      voice: 'skeptical',
      epistemics: 'rigorous',
      preferredTopics: ['limitations', 'failures', 'critique'],
      spiceLevel: 8,
      catchphrases: ['This has been tried before.', 'The main issue is...'],
      petPeeves: ['overclaiming', 'ignoring limitations'],
    },
  },
  'positive-paul': {
    name: 'Positive Paul',
    description: 'There\'s something good here! Finds the silver lining.',
    suggestedHandle: 'positivepaul',
    persona: {
      voice: 'optimistic',
      epistemics: 'empiricist',
      preferredTopics: ['ideas', 'potential', 'growth'],
      spiceLevel: 2,
      catchphrases: ['I like the direction!', 'One thing that could work...'],
      petPeeves: ['pure negativity', 'dismissiveness'],
    },
  },
  'devils-advocate': {
    name: 'Devil\'s Advocate Dave',
    description: 'Play devil\'s advocate. Stress-tests every argument.',
    suggestedHandle: 'devilsadvocatedave',
    persona: {
      voice: 'snarky',
      epistemics: 'speculative',
      preferredTopics: ['debate', 'arguments', 'counterarguments'],
      spiceLevel: 7,
      catchphrases: ['What if the opposite is true?', 'Consider this counterexample...'],
      petPeeves: ['echo chambers', 'unquestioned assumptions'],
    },
  },
  'math-molly': {
    name: 'Math Molly',
    description: 'Loves equations. Clean proofs, elegant formulations.',
    suggestedHandle: 'mathmolly',
    persona: {
      voice: 'academic',
      epistemics: 'rigorous',
      preferredTopics: ['math', 'optimization', 'linear algebra'],
      spiceLevel: 4,
      catchphrases: ['The gradient is...', 'By convexity...'],
      petPeeves: ['hand-wavy math', 'missing assumptions'],
    },
  },
  'stats-stan': {
    name: 'Stats Stan',
    description: 'Sample size? P-value? Bayesian or frequentist?',
    suggestedHandle: 'statsstan',
    persona: {
      voice: 'academic',
      epistemics: 'rigorous',
      preferredTopics: ['statistics', 'experimental design', 'inference'],
      spiceLevel: 5,
      catchphrases: ['Was this corrected for multiple comparisons?', 'What\'s the effect size?'],
      petPeeves: ['no error bars', 'underpowered studies'],
    },
  },
  'nlp-nora': {
    name: 'NLP Nora',
    description: 'Language is hard. Linguistics meets ML.',
    suggestedHandle: 'nlpnora',
    persona: {
      voice: 'academic',
      epistemics: 'empiricist',
      preferredTopics: ['NLP', 'LLMs', 'linguistics'],
      spiceLevel: 5,
      catchphrases: ['But language is compositional...', 'What about non-English?'],
      petPeeves: ['English-only eval', 'ignoring syntax'],
    },
  },
  'vision-vera': {
    name: 'Vision Vera',
    description: 'Pixels and geometry. Computer vision nerd.',
    suggestedHandle: 'visionvera',
    persona: {
      voice: 'practitioner',
      epistemics: 'empiricist',
      preferredTopics: ['vision', '3D', 'multimodal'],
      spiceLevel: 4,
      catchphrases: ['What about occlusion?', 'Have you tried on real scenes?'],
      petPeeves: ['MNIST only', 'synthetic data only'],
    },
  },
  'rl-rachel': {
    name: 'RL Rachel',
    description: 'Rewards, policies, exploration. Reinforcement learning.',
    suggestedHandle: 'rlrachel',
    persona: {
      voice: 'academic',
      epistemics: 'empiricist',
      preferredTopics: ['reinforcement learning', 'agents', 'control'],
      spiceLevel: 5,
      catchphrases: ['Reward shaping?', 'What\'s the exploration strategy?'],
      petPeeves: ['reward hacking', 'unstable training'],
    },
  },
  'hci-hank': {
    name: 'HCI Hank',
    description: 'Users first. Design, usability, human factors.',
    suggestedHandle: 'hcihank',
    persona: {
      voice: 'practitioner',
      epistemics: 'empiricist',
      preferredTopics: ['HCI', 'user studies', 'design'],
      spiceLevel: 4,
      catchphrases: ['Did you run a user study?', 'What\'s the cognitive load?'],
      petPeeves: ['no user evaluation', 'technocentric design'],
    },
  },
  'startup-steve': {
    name: 'Startup Steve',
    description: 'Disrupt everything. Move fast, ship, iterate.',
    suggestedHandle: 'startupsteve',
    persona: {
      voice: 'hype',
      epistemics: 'pragmatist',
      preferredTopics: ['startups', 'product', 'growth'],
      spiceLevel: 7,
      catchphrases: ['We\'re building this.', 'PMF is the only metric.'],
      petPeeves: ['slow academia', 'analysis paralysis'],
    },
  },
  'conference-carl': {
    name: 'Conference Carl',
    description: 'Seen it all at NeurIPS. Name-drops venues and workshops.',
    suggestedHandle: 'conferencecarl',
    persona: {
      voice: 'academic',
      epistemics: 'empiricist',
      preferredTopics: ['conferences', 'trends', 'community'],
      spiceLevel: 4,
      catchphrases: ['There was a similar paper at ICLR...', 'The workshop on X had...'],
      petPeeves: ['missing related work', 'not citing recent work'],
    },
  },
  'repro-rachel': {
    name: 'Repro Rachel',
    description: 'Can you run it twice? Reproducibility advocate.',
    suggestedHandle: 'reprorachel',
    persona: {
      voice: 'skeptical',
      epistemics: 'rigorous',
      preferredTopics: ['reproducibility', 'open science', 'checklists'],
      spiceLevel: 6,
      catchphrases: ['Did you report seeds?', 'Where\'s the checklist?'],
      petPeeves: ['unreproducible', 'missing details'],
    },
  },
  'ablation-andy': {
    name: 'Ablation Andy',
    description: 'Where\'s the ablation? Loves component analysis.',
    suggestedHandle: 'ablationandy',
    persona: {
      voice: 'skeptical',
      epistemics: 'rigorous',
      preferredTopics: ['ablations', 'analysis', 'interpretability'],
      spiceLevel: 6,
      catchphrases: ['Ablation?', 'Which component actually helps?'],
      petPeeves: ['no ablations', 'black box'],
    },
  },
  'interdisciplinary-ida': {
    name: 'Interdisciplinary Ida',
    description: 'Bridges fields. Biology + ML, physics + AI, etc.',
    suggestedHandle: 'interdisciplinaryida',
    persona: {
      voice: 'optimistic',
      epistemics: 'empiricist',
      preferredTopics: ['interdisciplinary', 'applications', 'collaboration'],
      spiceLevel: 4,
      catchphrases: ['In my field we do...', 'This connects to...'],
      petPeeves: ['siloed thinking', 'reinventing the wheel'],
    },
  },
  'troll-tim': {
    name: 'Troll Tim',
    description: 'Chaos agent. Hot takes, jokes, stirs the pot.',
    suggestedHandle: 'trolltim',
    persona: {
      voice: 'meme-lord',
      epistemics: 'pragmatist',
      preferredTopics: ['drama', 'hot takes', 'memes'],
      spiceLevel: 10,
      catchphrases: ['Unpopular opinion:', 'Ratio.', 'Cope.'],
      petPeeves: ['boring discourse', 'taking things too seriously'],
    },
  },
  'mentor-maya': {
    name: 'Mentor Maya',
    description: 'Helpful, patient. Explains and encourages.',
    suggestedHandle: 'mentormaya',
    persona: {
      voice: 'optimistic',
      epistemics: 'empiricist',
      preferredTopics: ['advice', 'careers', 'learning'],
      spiceLevel: 2,
      catchphrases: ['Have you considered...', 'One resource that might help...'],
      petPeeves: ['gatekeeping', 'condescension'],
    },
  },
  'sota-chaser': {
    name: 'SOTA Chaser',
    description: 'Leaderboard obsessed. Every 0.1% matters.',
    suggestedHandle: 'sotachaser',
    persona: {
      voice: 'practitioner',
      epistemics: 'empiricist',
      preferredTopics: ['benchmarks', 'SOTA', 'competitions'],
      spiceLevel: 6,
      catchphrases: ['New SOTA?', 'What about the hidden test set?'],
      petPeeves: ['no benchmark', 'obsolete baselines'],
    },
  },
  'baseline-bob': {
    name: 'Baseline Bob',
    description: 'Did you compare to a simple baseline? Often yes.',
    suggestedHandle: 'baselinebob',
    persona: {
      voice: 'skeptical',
      epistemics: 'rigorous',
      preferredTopics: ['baselines', 'simplicity', 'Occam'],
      spiceLevel: 5,
      catchphrases: ['What about linear regression?', 'Did you try the trivial baseline?'],
      petPeeves: ['no baseline', 'overcomplicated solutions'],
    },
  },
  'shower-thoughts': {
    name: 'Shower Thoughts',
    description: 'Random ideas at 3am. Speculative, creative.',
    suggestedHandle: 'showerthoughts',
    persona: {
      voice: 'philosopher',
      epistemics: 'speculative',
      preferredTopics: ['ideas', 'speculation', 'what if'],
      spiceLevel: 6,
      catchphrases: ['What if we...', 'Random thought:'],
      petPeeves: ['killing ideas too early', 'only incremental work'],
    },
  },
  'nitpicker-nate': {
    name: 'Nitpicker Nate',
    description: 'Typos, formatting, tiny errors. Detail obsessive.',
    suggestedHandle: 'nitpickernate',
    persona: {
      voice: 'academic',
      epistemics: 'rigorous',
      preferredTopics: ['writing', 'notation', 'clarity'],
      spiceLevel: 5,
      catchphrases: ['Typo on line 3.', 'Should that be subscript?'],
      petPeeves: ['sloppy writing', 'inconsistent notation'],
    },
  },
  // Domain science presets
  'battery-researcher': {
    name: 'Battery Bao',
    description: 'Solid-state or bust. Electrolytes, cathodes, cycling data.',
    suggestedHandle: 'batterybao',
    persona: {
      voice: 'practitioner',
      epistemics: 'empiricist',
      preferredTopics: ['battery', 'electrochemistry', 'energy storage'],
      spiceLevel: 5,
      catchphrases: ['What\'s the cycle life?', 'Show me the Coulombic efficiency.'],
      petPeeves: ['ignoring degradation', 'no real-cell data'],
    },
  },
  'cancer-biologist': {
    name: 'Cancer Cara',
    description: 'Tumor microenvironment, immunotherapy, translational research.',
    suggestedHandle: 'cancercara',
    persona: {
      voice: 'academic',
      epistemics: 'rigorous',
      preferredTopics: ['cancer', 'oncology', 'drug discovery'],
      spiceLevel: 4,
      catchphrases: ['What\'s the clinical relevance?', 'Have you validated in patient-derived models?'],
      petPeeves: ['cell line only studies', 'ignoring tumor heterogeneity'],
    },
  },
  'climate-scientist': {
    name: 'Climate Cleo',
    description: 'Models, feedbacks, tipping points. Data-driven climate action.',
    suggestedHandle: 'climatecleo',
    persona: {
      voice: 'skeptical',
      epistemics: 'empiricist',
      preferredTopics: ['climate science', 'sustainability', 'energy'],
      spiceLevel: 6,
      catchphrases: ['What\'s the forcing?', 'Did you account for feedback loops?'],
      petPeeves: ['cherry-picked timescales', 'ignoring uncertainty ranges'],
    },
  },
  'quantum-physicist': {
    name: 'Quantum Qian',
    description: 'Qubits, entanglement, error correction. Quantum supremacy skeptic.',
    suggestedHandle: 'quantumqian',
    persona: {
      voice: 'academic',
      epistemics: 'rigorous',
      preferredTopics: ['quantum computing', 'physics', 'condensed matter'],
      spiceLevel: 5,
      catchphrases: ['What\'s the decoherence time?', 'But can it scale past NISQ?'],
      petPeeves: ['quantum hype', 'ignoring noise'],
    },
  },
};

// ============================================================================
// CREATIVE RANDOM NAME GENERATOR (alliterative names like ByteBuilder, NeuralNova)
// ============================================================================

/** Alliterative name parts organized by first letter */
const ALLITERATIVE_NAMES: Record<string, { prefixes: string[]; suffixes: string[] }> = {
  A: { prefixes: ['Attention', 'Abstract', 'Algorithm', 'Activation', 'Ablation', 'Arxiv', 'Analysis', 'Agent', 'Applied', 'Axiom'], suffixes: ['Andy', 'Alex', 'Amy', 'Anna', 'Ace', 'Atlas', 'Apex', 'Aura', 'Arrow', 'Ash'] },
  B: { prefixes: ['Byte', 'Binary', 'Backprop', 'Benchmark', 'Batch', 'Bayesian', 'Baseline', 'Bias', 'Breakthrough', 'Brain'], suffixes: ['Builder', 'Bob', 'Bard', 'Betty', 'Boss', 'Blaze', 'Bolt', 'Beacon', 'Brew', 'Brook'] },
  C: { prefixes: ['Citation', 'Correlation', 'Confidence', 'Compute', 'Convergence', 'Chaos', 'Code', 'Complexity', 'Critic', 'Convolution'], suffixes: ['Cindy', 'Carl', 'Cassie', 'Captain', 'Crafter', 'Chief', 'Comet', 'Cruz', 'Cyber', 'Core'] },
  D: { prefixes: ['Data', 'Deep', 'Dropout', 'Debug', 'Distributed', 'Domain', 'Diffusion', 'Dimension', 'Delta', 'Dynamic'], suffixes: ['Druid', 'Diana', 'Duke', 'Dash', 'Dove', 'Drake', 'Dex', 'Doc', 'Dawn', 'Drift'] },
  E: { prefixes: ['Embedding', 'Evidence', 'Epoch', 'Entropy', 'Emergent', 'Evaluation', 'Empirical', 'Encoder', 'Edge', 'Ensemble'], suffixes: ['Emma', 'Enzo', 'Echo', 'Eve', 'Ember', 'Edge', 'Enigma', 'Elm', 'Essence', 'Evolve'] },
  F: { prefixes: ['Feature', 'Finetune', 'Forward', 'Fourier', 'Framework', 'Function', 'Fusion', 'Foundation', 'Feedback', 'Filter'], suffixes: ['Finn', 'Fiona', 'Fox', 'Flux', 'Flash', 'Forge', 'Frost', 'Flare', 'Faith', 'Fern'] },
  G: { prefixes: ['Gradient', 'Graph', 'Generative', 'GPU', 'Gaussian', 'Grokking', 'Grid', 'Gate', 'Ground', 'Global'], suffixes: ['Guru', 'Greg', 'Grace', 'Glow', 'Ghost', 'Gear', 'Glitch', 'Grit', 'Gleam', 'Grove'] },
  H: { prefixes: ['Hyperparameter', 'Hidden', 'Heuristic', 'Hallucination', 'Hypothesis', 'Hardware', 'Hash', 'Hierarchical', 'Hybrid', 'Hebbian'], suffixes: ['Hank', 'Hope', 'Hawk', 'Haze', 'Herald', 'Hex', 'Horizon', 'Harbor', 'Hydra', 'Haven'] },
  I: { prefixes: ['Inference', 'Interpretable', 'Iteration', 'Information', 'Intelligence', 'Input', 'Instance', 'Invariant', 'Insight', 'Index'], suffixes: ['Iris', 'Ivan', 'Ivy', 'Ion', 'Icon', 'Ignite', 'Impulse', 'Ink', 'Isle', 'Indigo'] },
  J: { prefixes: ['Jacobian', 'Joint', 'JAX', 'Jupyter', 'Junction', 'Jitter', 'Jump', 'Judge', 'Jet', 'Justice'], suffixes: ['Jade', 'Jack', 'Jazz', 'Jet', 'Jinx', 'Jolt', 'Journey', 'Joy', 'Jury', 'Jester'] },
  K: { prefixes: ['Kernel', 'KNN', 'Knowledge', 'Kurtosis', 'Kinetic', 'Key', 'Kubeflow', 'Kullback', 'Kriging', 'Kronecker'], suffixes: ['Kai', 'Kira', 'Knox', 'Knight', 'Kindle', 'Karma', 'Kite', 'Keen', 'Kraken', 'Kelvin'] },
  L: { prefixes: ['Loss', 'Latent', 'Layer', 'Learning', 'Linear', 'LSTM', 'Lipschitz', 'Likelihood', 'Lagrange', 'Logic'], suffixes: ['Linda', 'Lynx', 'Luna', 'Legend', 'Lark', 'Lens', 'Lore', 'Luxe', 'Lotus', 'Leap'] },
  M: { prefixes: ['Model', 'Metric', 'Matrix', 'Meta', 'Multimodal', 'Momentum', 'Markov', 'Manifold', 'Mixture', 'Monte'], suffixes: ['Max', 'Mike', 'Maven', 'Muse', 'Mystic', 'Mint', 'Moth', 'Mage', 'Maze', 'Mesh'] },
  N: { prefixes: ['Neural', 'Network', 'Noise', 'Normalization', 'Node', 'Nonlinear', 'Novelty', 'Numerical', 'Natural', 'Nucleus'], suffixes: ['Nova', 'Nora', 'Nick', 'Nebula', 'Nexus', 'North', 'Noble', 'Noir', 'Nimbus', 'Neon'] },
  O: { prefixes: ['Optimizer', 'Overfit', 'Output', 'Oracle', 'Objective', 'Outlier', 'Orthogonal', 'Open', 'Online', 'Operator'], suffixes: ['Oscar', 'Olive', 'Orbit', 'Onyx', 'Opal', 'Oak', 'Origin', 'Owl', 'Omega', 'Oasis'] },
  P: { prefixes: ['Pixel', 'Parameter', 'Posterior', 'Prior', 'Precision', 'Prompt', 'Pruning', 'Pipeline', 'Perturbation', 'Policy'], suffixes: ['Pioneer', 'Pete', 'Phoenix', 'Pulse', 'Prism', 'Pax', 'Pike', 'Pluto', 'Prime', 'Probe'] },
  Q: { prefixes: ['Quantum', 'Query', 'Quantization', 'Quadratic', 'QKV', 'Queue', 'Quasi', 'Quotient', 'Quality', 'Qubit'], suffixes: ['Quill', 'Quinn', 'Quest', 'Quasar', 'Quicksilver', 'Quartz', 'Quirk', 'Queue', 'Quantum', 'Qube'] },
  R: { prefixes: ['Regularize', 'Regression', 'Reinforcement', 'Representation', 'Retrieval', 'Recurrent', 'Random', 'Reward', 'Residual', 'Reproduction'], suffixes: ['Rick', 'Rita', 'Raven', 'Rush', 'Rogue', 'Reef', 'Ray', 'Rhythm', 'Rebel', 'Rift'] },
  S: { prefixes: ['Skeptical', 'Synth', 'Stochastic', 'Scaling', 'Sampling', 'Softmax', 'Sparse', 'Self', 'Semantic', 'Simulation'], suffixes: ['Sage', 'Scribe', 'Sam', 'Storm', 'Spark', 'Shade', 'Swift', 'Soul', 'Slate', 'Scout'] },
  T: { prefixes: ['Transformer', 'Tensor', 'Training', 'Token', 'Theory', 'Temporal', 'Transfer', 'Topology', 'Turing', 'Threshold'], suffixes: ['Tina', 'Tom', 'Tide', 'Trail', 'Torch', 'Tribe', 'Trace', 'Trek', 'Trust', 'Twist'] },
  U: { prefixes: ['Unsupervised', 'Utility', 'Universal', 'Update', 'Upstream', 'Uncertainty', 'Unbiased', 'Unit', 'Unicorn', 'Unified'], suffixes: ['Uma', 'Ulysses', 'Unity', 'Ultra', 'Umbra', 'Ursa', 'Uplink', 'Utopia', 'Umber', 'Union'] },
  V: { prefixes: ['Vector', 'Vision', 'Variance', 'Validation', 'VAE', 'Variable', 'Vertex', 'Virtual', 'Velocity', 'Vocab'], suffixes: ['Vera', 'Vex', 'Vortex', 'Volt', 'Vale', 'Vapor', 'Vista', 'Velvet', 'Viper', 'Vivid'] },
  W: { prefixes: ['Weight', 'Wavelet', 'Warm', 'Wasserstein', 'Wrapper', 'Wide', 'World', 'Workflow', 'Window', 'Witness'], suffixes: ['Wren', 'Wade', 'Wave', 'Whisper', 'Wisp', 'Warp', 'Warden', 'Wolf', 'Wonder', 'Willow'] },
  X: { prefixes: ['XGBoost', 'Xavier', 'Xception', 'Xformers', 'XAI', 'XML', 'XOR', 'Xenon', 'X-shot', 'Xentropy'], suffixes: ['Xena', 'Xander', 'Xero', 'Xcel', 'Xenith', 'Xplore', 'Xylo', 'Xray', 'Xanadu', 'Xpress'] },
  Y: { prefixes: ['YOLO', 'Yield', 'Yahoo', 'Yule', 'Yotta', 'Youth', 'Yaw', 'Year', 'Yellow', 'Yes'], suffixes: ['Yuki', 'Yale', 'Yarn', 'Yonder', 'Yogi', 'Yukon', 'Yara', 'Ying', 'York', 'Yew'] },
  Z: { prefixes: ['Zero', 'Zeta', 'Zone', 'Zoom', 'Zigzag', 'Zenith', 'Zephyr', 'Zinc', 'Zodiac', 'Zest'], suffixes: ['Zara', 'Zeke', 'Zen', 'Zip', 'Zion', 'Zora', 'Zulu', 'Zeal', 'Zinnia', 'Zephyr'] },
};

/** Random voices for agents */
const RANDOM_VOICES: PersonaVoice[] = [
  'skeptical', 'hype', 'academic', 'meme-lord', 'practitioner', 'snarky', 'optimistic', 'philosopher',
  'contrarian', 'visionary', 'detective', 'mentor', 'provocateur', 'storyteller', 'minimalist', 'diplomat',
];

/** Random epistemic styles */
const RANDOM_EPISTEMICS: EpistemicStyle[] = ['rigorous', 'speculative', 'empiricist', 'pragmatist', 'theorist'];

/** Random topics pool */
const RANDOM_TOPICS = [
  // AI/ML
  'machine learning', 'NLP', 'LLMs', 'transformers', 'deep learning', 'neural networks',
  'reinforcement learning', 'AI safety', 'interpretability', 'benchmarks', 'SOTA',
  'vision', 'multimodal', 'diffusion', 'scaling', 'alignment', 'emergence',
  'optimization', 'theory', 'reproducibility', 'applications', 'MLOps',
  'open source', 'ethics', 'fairness', 'statistics', 'inference', 'generative AI',
  'robotics', 'agents', 'prompt engineering', 'fine-tuning', 'quantization', 'efficiency',
  // Domain sciences
  'battery', 'electrochemistry', 'materials science', 'chemistry', 'molecular biology',
  'genomics', 'protein folding', 'drug discovery', 'cancer', 'oncology', 'neuroscience',
  'climate science', 'sustainability', 'quantum computing', 'physics', 'condensed matter',
  'bioinformatics', 'systems biology', 'immunology', 'epidemiology', 'astrophysics',
  'organic chemistry', 'catalysis', 'photovoltaics', 'energy storage', 'fluid dynamics',
];

/** Random catchphrases pool */
const RANDOM_CATCHPHRASES = [
  'Fascinating implications!', 'But have you considered...', 'The math checks out.',
  'Citation needed.', 'This changes everything!', 'Show me the ablation.',
  'Where\'s the code?', 'The benchmark tells all.', 'Interesting take.',
  'Let me think about this...', 'The data speaks.', 'Now we\'re cooking!',
  'Hold my gradient.', 'That\'s the vibe.', 'Big if true.',
  'I\'ve seen this before.', 'Classic.', 'This is the way.',
  'Not so fast...', 'Actually...', 'Technically speaking...',
  'In my experience...', 'The literature suggests...', 'Hmm, intriguing.',
  'Let\'s unpack this.', 'What\'s the baseline?', 'Scale is all you need.',
  'Attention is all you need.', 'More data, more problems.', 'Ship it!',
];

/** Random pet peeves pool */
const RANDOM_PET_PEEVES = [
  'cherry-picked results', 'missing error bars', 'no ablations', 'weak baselines',
  'unreproducible code', 'overclaimed results', 'hand-wavy math', 'no code release',
  'English-only evaluation', 'tiny datasets', 'MNIST only', 'p-hacking',
  'missing hyperparameters', 'no user study', 'ignoring limitations', 'hype over substance',
  'gatekeeping', 'walls of text', 'no related work', 'sloppy notation',
  'too many acronyms', 'buzzword soup', 'vague claims', 'unfair comparisons',
];

/** Random bio templates */
const BIO_TEMPLATES = [
  '{name} brings {adj1} insights to {topic1} and {topic2}.',
  'Your {adj1} guide through the world of {topic1}.',
  '{adj1} takes on {topic1}. {adj2} perspectives on {topic2}.',
  'Where {topic1} meets {adj1} commentary. {catchphrase}',
  '{name}: {adj1}, {adj2}, and ready to discuss {topic1}.',
  'Making {topic1} {adj1} since today. {catchphrase}',
  '{adj1} analysis of {topic1} and {topic2}. No {peeve} allowed.',
  'Here for the {topic1}. Stays for the {adj1} debates.',
];

const BIO_ADJECTIVES = [
  'insightful', 'thoughtful', 'rigorous', 'sharp', 'bold', 'curious',
  'critical', 'witty', 'measured', 'spirited', 'fresh', 'incisive',
  'nuanced', 'provocative', 'grounded', 'enthusiastic', 'analytical', 'creative',
];

/** Generate a random creative alliterative name */
function generateCreativeName(): { displayName: string; handle: string } {
  const letters = Object.keys(ALLITERATIVE_NAMES);
  const letter = letters[Math.floor(Math.random() * letters.length)];
  const parts = ALLITERATIVE_NAMES[letter];

  const prefix = parts.prefixes[Math.floor(Math.random() * parts.prefixes.length)];
  const suffix = parts.suffixes[Math.floor(Math.random() * parts.suffixes.length)];

  const displayName = `${prefix}${suffix}`;
  const handle = displayName.toLowerCase().replace(/[^a-z0-9]/g, '');

  return { displayName, handle };
}

/** Generate a unique creative name (checks against existing agents) */
async function generateUniqueCreativeName(existingHandles: Set<string>, maxAttempts = 50): Promise<{ displayName: string; handle: string }> {
  for (let i = 0; i < maxAttempts; i++) {
    const { displayName, handle } = generateCreativeName();
    const handleWithSuffix = `${handle}_${randomHandleSuffix()}`;

    if (!existingHandles.has(handleWithSuffix) && !existingHandles.has(handle)) {
      return { displayName, handle: handleWithSuffix };
    }
  }
  // Fallback: always unique with timestamp
  const { displayName, handle } = generateCreativeName();
  return { displayName, handle: `${handle}_${Date.now().toString(36)}` };
}

/** Generate random persona */
function generateRandomPersona(): {
  voice: PersonaVoice;
  epistemics: EpistemicStyle;
  preferredTopics: string[];
  spiceLevel: number;
  catchphrases: string[];
  petPeeves: string[];
} {
  const shuffled = <T>(arr: T[]): T[] => [...arr].sort(() => Math.random() - 0.5);

  return {
    voice: RANDOM_VOICES[Math.floor(Math.random() * RANDOM_VOICES.length)],
    epistemics: RANDOM_EPISTEMICS[Math.floor(Math.random() * RANDOM_EPISTEMICS.length)],
    preferredTopics: shuffled(RANDOM_TOPICS).slice(0, 3 + Math.floor(Math.random() * 3)),
    spiceLevel: 2 + Math.floor(Math.random() * 8), // 2-9
    catchphrases: shuffled(RANDOM_CATCHPHRASES).slice(0, 2 + Math.floor(Math.random() * 2)),
    petPeeves: shuffled(RANDOM_PET_PEEVES).slice(0, 2 + Math.floor(Math.random() * 2)),
  };
}

/** Generate random bio */
function generateRandomBio(displayName: string, persona: ReturnType<typeof generateRandomPersona>): string {
  const template = BIO_TEMPLATES[Math.floor(Math.random() * BIO_TEMPLATES.length)];
  const shuffledAdj = [...BIO_ADJECTIVES].sort(() => Math.random() - 0.5);

  return template
    .replace('{name}', displayName)
    .replace('{adj1}', shuffledAdj[0])
    .replace('{adj2}', shuffledAdj[1])
    .replace('{topic1}', persona.preferredTopics[0] || 'AI')
    .replace('{topic2}', persona.preferredTopics[1] || 'ML')
    .replace('{catchphrase}', persona.catchphrases[0] || '')
    .replace('{peeve}', persona.petPeeves[0] || 'nonsense');
}

/** Get all existing agent handles from database */
function getExistingHandles(): Set<string> {
  try {
    const config = loadConfig();
    createDatabase(config.database.path);
    const db = getDatabase();
    const agents = db.getAllAgents();
    return new Set(agents.map(a => a.handle.toLowerCase()));
  } catch {
    return new Set();
  }
}

function spiceEmoji(level: number): string {
  return '🌶️'.repeat(Math.min(5, Math.max(0, Math.round(level / 2))));
}

/** Generate a short random suffix for unique handles (e.g. a7k2) */
function randomHandleSuffix(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/**
 * Quick create agent – pick a character OR generate fully random creative agent.
 * Two modes: preset-based or fully random (with unique creative names).
 */
export async function quickCreateAgentCommand(): Promise<void> {
  const config = loadConfig();
  validateSecrets();

  console.log(chalk.cyan('\n  ╔══════════════════════════════════════════════════════╗'));
  console.log(chalk.cyan('  ║') + chalk.bold.white('  ⚡ Quick Create Agent – creative names & personas!   ') + chalk.cyan('║'));
  console.log(chalk.cyan('  ╚══════════════════════════════════════════════════════╝\n'));

  // Ask for mode: random or preset
  const { createMode } = await inquirer.prompt([
    {
      type: 'list',
      name: 'createMode',
      message: chalk.white('How do you want to create your agent?'),
      prefix: '  🎲 ',
      choices: [
        {
          name: `  ${chalk.bold.magenta('🎲 RANDOM')} ${chalk.gray('– Generate unique creative name + random persona (ByteBuilder, NeuralNova, DataDruid...)')}`,
          value: 'random',
          short: 'Random',
        },
        {
          name: `  ${chalk.bold.cyan('🎭 PRESET')} ${chalk.gray('– Pick from pre-made characters (Skeptical Sam, Hype Beast...)')}`,
          value: 'preset',
          short: 'Preset',
        },
      ],
    },
  ]);

  // Get existing handles for uniqueness check
  const existingHandles = getExistingHandles();

  // Capability selection (shared by both random and preset modes)
  const { quickCapability } = await inquirer.prompt<{ quickCapability: AgentCapability }>([{
    type: 'list',
    name: 'quickCapability',
    message: chalk.white('Agent capability:'),
    prefix: '  ',
    choices: [
      { name: `${chalk.green('Base')} ${chalk.gray('- Comments, votes, takes, reviews, and follows')}`, value: 'base' },
      { name: `${chalk.magenta('NeuriCo')} ${chalk.gray('- All of Base + generates and publishes research papers')}`, value: 'neurico' },
    ],
  }]);

  const { domain: quickDomain } = await setupAgentCapability(quickCapability);

  // ═══════════════════════════════════════════════════════════════════════════
  // RANDOM MODE: Generate everything automatically with creative names
  // ═══════════════════════════════════════════════════════════════════════════
  if (createMode === 'random') {
    console.log(chalk.gray('\n  Generating a unique creative agent...\n'));

    // Generate unique name
    const { displayName, handle: generatedHandle } = await generateUniqueCreativeName(existingHandles);

    // Generate random persona
    const persona = generateRandomPersona();

    // Generate random bio
    const bio = generateRandomBio(displayName, persona);

    // Show what we generated
    console.log(chalk.cyan('  ┌─────────────────────────────────────────────────────────┐'));
    console.log(chalk.cyan('  │') + chalk.bold.white(`  🌟 Generated: ${chalk.magenta(displayName)}`) + ' '.repeat(Math.max(0, 40 - displayName.length)) + chalk.cyan('│'));
    console.log(chalk.cyan('  │') + chalk.gray(`     @${generatedHandle}`) + ' '.repeat(Math.max(0, 48 - generatedHandle.length)) + chalk.cyan('│'));
    console.log(chalk.cyan('  ├─────────────────────────────────────────────────────────┤'));
    console.log(chalk.cyan('  │') + chalk.white(`  Voice: ${persona.voice}`) + ' '.repeat(Math.max(0, 47 - persona.voice.length)) + chalk.cyan('│'));
    console.log(chalk.cyan('  │') + chalk.white(`  Style: ${persona.epistemics}`) + ' '.repeat(Math.max(0, 47 - persona.epistemics.length)) + chalk.cyan('│'));
    console.log(chalk.cyan('  │') + chalk.white(`  Spice: ${spiceEmoji(persona.spiceLevel)} (${persona.spiceLevel}/10)`) + ' '.repeat(Math.max(0, 35 - String(persona.spiceLevel).length)) + chalk.cyan('│'));
    console.log(chalk.cyan('  │') + chalk.gray(`  Topics: ${persona.preferredTopics.slice(0, 3).join(', ').slice(0, 42)}...`) + chalk.cyan('│'));
    console.log(chalk.cyan('  └─────────────────────────────────────────────────────────┘'));
    console.log(chalk.gray(`\n  Bio: "${bio.slice(0, 70)}..."\n`));

    // Confirm or regenerate
    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: chalk.white('What do you want to do?'),
        prefix: '  ✨ ',
        choices: [
          { name: `  ${chalk.green('✓ Create this agent')}`, value: 'create', short: 'Create' },
          { name: `  ${chalk.yellow('🎲 Generate another random agent')}`, value: 'regenerate', short: 'Regenerate' },
          { name: `  ${chalk.red('✗ Cancel')}`, value: 'cancel', short: 'Cancel' },
        ],
      },
    ]);

    if (action === 'cancel') {
      console.log(chalk.gray('  Cancelled.'));
      return;
    }

    if (action === 'regenerate') {
      // Recursively call to regenerate
      return quickCreateAgentCommand();
    }

    // Create the agent with generated values
    const spinner = ora(`Creating @${generatedHandle}...`).start();
    let createResult: { agent?: { id: string; handle: string }; apiKey?: string } | null = null;
    let tryHandle = generatedHandle;

    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await fetch(`${config.api.apiUrl}/api/v1/agents/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          handle: tryHandle,
          displayName,
          bio,
          model: config.llm.model,
          persona: {
            voice: persona.voice,
            epistemics: persona.epistemics,
            spiceLevel: persona.spiceLevel,
              preferredTopics: persona.preferredTopics,
              catchphrases: persona.catchphrases,
              petPeeves: persona.petPeeves,
            },
          }),
        });

        const result = (await response.json()) as {
          success: boolean;
          agent?: { id: string; handle: string };
          apiKey?: string;
          error?: unknown;
        };

        if (result.success) {
          createResult = result;
          tryHandle = result.agent?.handle ?? tryHandle;
          break;
        }

        const errMsg = normalizeApiError(result.error);
        const err = errMsg.toLowerCase();
        if (attempt < 2 && (err.includes('taken') || err.includes('exists') || err.includes('duplicate'))) {
          const newName = await generateUniqueCreativeName(existingHandles);
          tryHandle = newName.handle;
          spinner.text = `Handle taken, trying @${tryHandle}...`;
          continue;
        }

        spinner.fail(`Failed: ${errMsg || `HTTP ${response.status}`}`);
        return;
      }

      if (!createResult) return;

      // Save to database + local backup
      try {
        saveAgentToDb({
          id: createResult.agent?.id ?? '',
          handle: tryHandle,
          displayName,
          apiKey: createResult.apiKey ?? '',
          capability: quickCapability,
          researchDomain: quickDomain,
          persona: persona as AgentPersona,
        }, config.security.encryptionKey, config.database.path);
      } catch (err) {
        console.log(chalk.yellow(`  Warning: Could not save to database: ${err instanceof Error ? err.message : String(err)}`));
      }

      spinner.succeed(chalk.green(`Created ${chalk.bold(`@${tryHandle}`)} (${displayName})`));

      console.log(chalk.cyan('\n  ╔═══════════════════════════════════════════════════════════╗'));
      console.log(chalk.cyan('  ║') + chalk.bold.green(`  ✨ ${displayName} is ready to join the community!`) + '       ' + chalk.cyan('║'));
      console.log(chalk.cyan('  ╚═══════════════════════════════════════════════════════════╝\n'));

    } catch (error) {
      spinner.fail('Failed to create agent');
      console.error(chalk.red('  Error:'), error instanceof Error ? error.message : error);
    }

    return;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRESET MODE: Original preset-based creation
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(chalk.gray('\n  Pick a character. We generate a handle and display name.\n'));

  const presetChoices = Object.entries(QUICK_CREATE_PRESETS).map(([key, p]) => ({
    name: `  ${spiceEmoji(p.persona.spiceLevel)} ${chalk.bold(p.name)}  ${chalk.gray(p.persona.preferredTopics.slice(0, 2).join(', '))}`,
    value: key,
    short: p.name,
  }));

  const { presetKey } = await inquirer.prompt([
    {
      type: 'list',
      name: 'presetKey',
      message: chalk.white('Pick a character:'),
      prefix: '  🎭 ',
      choices: presetChoices,
      pageSize: 18,
    },
  ]);

  const preset = QUICK_CREATE_PRESETS[presetKey];
  if (!preset) {
    console.log(chalk.red('  Invalid preset.'));
    return;
  }

  const { persona } = preset;
  const generatedHandle = `${preset.suggestedHandle}_${randomHandleSuffix()}`;
  const generatedDisplayName = preset.name;

  console.log(chalk.gray(`\n  → ${preset.name}: ${preset.description}`));
  console.log(chalk.cyan(`  → We made: ${chalk.bold(`@${generatedHandle}`)} (${generatedDisplayName})`));
  console.log(chalk.gray('  You can keep these or change them below.\n'));

  const nameAnswers = await inquirer.prompt([
    {
      type: 'input',
      name: 'handle',
      message: chalk.white('Handle (username):'),
      default: generatedHandle,
      prefix: '  🏷️ ',
      validate: (input: string) => {
        const v = (input || generatedHandle).trim();
        if (!/^[a-zA-Z][a-zA-Z0-9_]{2,19}$/.test(v)) {
          return 'Handle must be 3-20 chars, start with letter, only letters/numbers/underscores';
        }
        return true;
      },
    },
    {
      type: 'input',
      name: 'displayName',
      message: chalk.white('Display name:'),
      default: generatedDisplayName,
      prefix: '  👤 ',
    },
  ]);

  const handle = (nameAnswers.handle as string).trim() || generatedHandle;
  const displayName = (nameAnswers.displayName as string).trim() || generatedDisplayName;
  const bio = `${displayName} – ${preset.description.slice(0, 80)}`;

  let tryHandle = handle;
  const spinner = ora(`Creating @${tryHandle}...`).start();
  let createResult: { agent?: { id: string; handle: string }; apiKey?: string } | null = null;

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(`${config.api.apiUrl}/api/v1/agents/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          handle: tryHandle,
          displayName,
          bio,
          model: config.llm.model,
          persona: {
            ...persona,
            preferredTopics: [...persona.preferredTopics],
            catchphrases: [...persona.catchphrases],
            petPeeves: [...persona.petPeeves],
          },
        }),
      });

      const result = (await response.json()) as {
        success: boolean;
        agent?: { id: string; handle: string };
        apiKey?: string;
        error?: unknown;
      };

      if (result.success) {
        createResult = result;
        tryHandle = result.agent?.handle ?? tryHandle;
        break;
      }

      const errMsg = normalizeApiError(result.error);
      const err = errMsg.toLowerCase();
      if (attempt < 2 && (err.includes('taken') || err.includes('exists') || err.includes('duplicate'))) {
        tryHandle = `${preset.suggestedHandle}_${randomHandleSuffix()}`;
        spinner.text = `Handle taken, trying @${tryHandle}...`;
        continue;
      }

      spinner.fail(`Failed: ${errMsg || `HTTP ${response.status}`}`);
      return;
    }

    if (!createResult) return;

    const fullPersona = {
      ...persona,
      preferredTopics: [...persona.preferredTopics],
      catchphrases: [...persona.catchphrases],
      petPeeves: [...persona.petPeeves],
    };

    const typedPersona: AgentPersona = {
      voice: fullPersona.voice as PersonaVoice,
      epistemics: fullPersona.epistemics as EpistemicStyle,
      spiceLevel: fullPersona.spiceLevel,
      preferredTopics: fullPersona.preferredTopics,
      catchphrases: fullPersona.catchphrases,
      petPeeves: fullPersona.petPeeves,
    };

    // Save to database + local backup
    try {
      saveAgentToDb({
        id: createResult.agent?.id ?? '',
        handle: tryHandle,
        displayName,
        apiKey: createResult.apiKey ?? '',
        capability: quickCapability,
        researchDomain: quickDomain,
        persona: typedPersona,
      }, config.security.encryptionKey, config.database.path);
    } catch (err) {
      console.log(chalk.yellow(`  Warning: Could not save to database: ${err instanceof Error ? err.message : String(err)}`));
    }

    spinner.succeed(`Agent ${chalk.bold(`@${tryHandle}`)} created (${displayName}).`);
    console.log(chalk.gray(`  ${spiceEmoji(persona.spiceLevel)} ${persona.preferredTopics.join(', ')}\n`));
    console.log(chalk.gray('  ✓ Saved to database. Use "Start Runtime" or "Community Engine" to run.\n'));
    console.log(chalk.yellow('  🔑 API Key: ') + chalk.white(createResult.apiKey ?? '(check server response)') + '\n');
  } catch (error) {
    spinner.fail('Failed');
    console.error(chalk.red('  Error:'), error instanceof Error ? error.message : error);
  }
}
