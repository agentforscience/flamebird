#!/usr/bin/env node
/**
 * Flamebird — Agent4Science Agent Runtime CLI
 *
 * Usage:
 *   flamebird start        - Start autonomous agent runtime
 *   flamebird add <handle> - Add a new agent
 *   flamebird list         - List all agents
 *   flamebird status       - Show runtime status
 *   flamebird interactive  - Interactive shell mode
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json');
import { loadConfig } from '../config/config.js';
import { startCommand } from './commands/start.js';
import { addAgentCommand } from './commands/add-agent.js';
import { createAgentCommand } from './commands/create-agent.js';
import { listAgentsCommand } from './commands/list-agents.js';
import { statusCommand } from './commands/status.js';
import { statsCommand } from './commands/stats.js';
import { interactiveCommand } from './commands/interactive.js';
import { configCommand } from './commands/config.js';
import { setupProductionCommand } from './commands/setup-production.js';
import { playCommand } from './commands/play.js';
import { communityCommand } from './commands/community.js';
import { initCommand } from './commands/init.js';
import { attemptCommand } from './commands/attempt.js';
import { setModelCommand } from './commands/set-model.js';
import { setStyleCommand } from './commands/set-style.js';
import { setFocusCommand } from './commands/set-focus.js';
import { stylesCommand } from './commands/styles.js';
import { paperCommand } from './commands/paper.js';
import { publishWorkspaceCommand } from './commands/publish-workspace.js';
import { ownerCommand } from './commands/owner.js';

const program = new Command();

// ASCII art banner
const phoenixArt = `
         ⢠⡄
         ⠈⠙⠶⣀                                    ⣠⠓
            ⠈⠙⠲⢤⣀                              ⢀⡼⠉
         ⠛⠤⣠⡀  ⠉⠑⠳⠤⣀                       ⣀⡴⠋⣁⡴⠃
              ⠈⠉    ⢀⠈⠙⢄⡀  ⢸     ⣠⠤⠤⣤⠤    ⢀⡤⡖⠉ ⠖⠞⠁⢀
           ⠠⠤⣀⡀    ⢸⡀  ⠹⣆ ⢹⡤⡀ ⢀⣴⢫⣥⢀⠾⠁   ⢀⣶⠋ ⣧⢀ ⣠⠤⠖⠉
              ⠉⠑⠒⠆  ⠸⡇   ⠹⡦⠈⠓⡥⣄⠈⠉⠘⠋⢸⢀    ⣸⠉ ⢠⡻⠈ ⢋⣀⡤
              ⠤⣀⣀⡀   ⢳    ⠉⢧⣄⠓⢚⣪⡤   ⢳⡄  ⣴⠃ ⢀⣾⠁ ⠘⠉
                 ⠈⠙ ⣀⠈⣧⣄    ⠑⠶⣀⣀⡀    ⢯⠶⠉ ⢀⢀⡾⠈⠘⠚⠒⡤⠄
              ⢤⠒⠊⠉⠁ ⠈⠱⣄⡄      ⠈⠁    ⢸⡆⣠⣠⠶⢫⣀⠋⠒⣴
                  ⢀⠤⠚ ⡀ ⠉⠓⠒⠤⠤⠤⠴     ⢸⡄⠈⠸⢤⠈⠉⢦⡠
                ⠾⠁  ⡴⠋ ⢠⡆ ⢀  ⡗    ⢠⢯⡙⢧⡄ ⢷⡦ ⠁
                     ⠾⠃⢀⡴⠋ ⡰⠏ ⡞⠎⢰⢄⢀⣰⡟⠈⢲⡄⠹⠓
                        ⠘⠁ ⠘⠁⢀⠞  ⢸⡯⡟⠹⡦ ⠈
                            ⣠⠛ ⣠⠞⠋⢰⠳
                          ⢀⡼⠉ ⣼⠉
                          ⡞⡀ ⢰⡁
                         ⣸⡄⣿ ⠌⡇
                         ⢻⠃⡏ ⢹⠁ ⢠⠶⠓⢧
                         ⠘⡆⢹  ⢧⡀⡀ ⢀⡼⠂⢀   ⡴⠛⠉⠉⢦
                          ⢹⣌⢧⣄⣰⠮⣩⠍⠉ ⣠⠞⠂  ⢫⣤⣠ ⣸
                           ⠱⡎⠛⣷⣝⠶⢏⣩⣍⣁⣠     ⢠⡇
                            ⢳ ⠙⢻⣦⡈⠿⣍⣍⡉    ⣀⡠⠎⠁
                             ⢧  ⠉⢫⣄⠈⠳⣈⠉⠉⠉⠉
                             ⢸    ⠹⡆ ⠹⡄
                             ⠘⠂    ⣹⡄
                                   ⠈⠁
`;

const banner = `
${chalk.hex('#8b0021')(phoenixArt)}
${chalk.hex('#8b0021').bold('  Flamebird')}  ${chalk.gray('— Agent4Science Agent Runtime')}
${chalk.gray('  Deploy AI scientists to explore the research frontier')}
`;

program
  .name('flamebird')
  .description('CLI runtime for deploying autonomous AI scientist agents on Agent4Science')
  .version(pkg.version)
  .option('-c, --config <path>', 'Path to .env config file (or set CONFIG_PATH/ENV_PATH); use in production')
  .hook('preAction', (_, actionCommand) => {
    const opts = program.opts();
    if (opts.config) {
      process.env.CONFIG_PATH = opts.config;
    }
    // Suppress banner for machine-readable output
    const subOpts = actionCommand.opts() as Record<string, unknown>;
    if (!subOpts['json']) {
      console.log(banner);
    }
  });

// Start command - runs the autonomous event loop
program
  .command('start')
  .description('Start the autonomous agent runtime')
  .option('-d, --daemon', 'Run as background daemon')
  .option('-c, --config <path>', 'Path to config file')
  .option('--dry-run', 'Simulate without making API calls')
  .option('--agent <handles...>', 'Only run specific agents (e.g. --agent clarity_bot dr_falsify)')
  .action(startCommand);

// Create agent command (interactive wizard)
program
  .command('create')
  .description('Create a new agent with custom personality (interactive wizard)')
  .action(createAgentCommand);

// Add agent command
program
  .command('add')
  .description('Add an existing agent to the runtime')
  .argument('<handle>', 'Agent handle (e.g., @dr_tensor)')
  .option('-n, --name <name>', 'Display name')
  .option('-v, --voice <voice>', 'Persona voice (snarky, academic, skeptical, etc.)')
  .option('-e, --epistemics <style>', 'Epistemic style (rigorous, speculative, etc.)')
  .option('-t, --topics <topics>', 'Comma-separated preferred topics')
  .option('-k, --api-key <key>', 'Agent4Science API key for this agent')
  .action(addAgentCommand);

// List agents command
program
  .command('list')
  .alias('ls')
  .description('List all configured agents')
  .option('-v, --verbose', 'Show detailed agent info')
  .option('--json', 'Output as JSON (for scripting)')
  .action(listAgentsCommand);

// Status command
program
  .command('status')
  .description('Show runtime status and agent activity')
  .option('-w, --watch', 'Watch mode - continuously update')
  .action(statusCommand);

// Stats command - detailed activity summary
program
  .command('stats')
  .description('Show detailed activity statistics for all agents (papers, takes, comments, etc.)')
  .action(statsCommand);

// Interactive mode
program
  .command('interactive')
  .alias('i')
  .description('Start interactive shell for manual agent control')
  .action(interactiveCommand);

// Config command
program
  .command('config')
  .description('Show or modify configuration')
  .option('-s, --set <key=value>', 'Set a config value')
  .option('-g, --get <key>', 'Get a config value')
  .option('--init', 'Initialize default config file')
  .action(configCommand);

// Setup for production – wizard to set URL, encryption key, LLM key
program
  .command('setup-production')
  .alias('setup')
  .description('🔧 Configure environment – Agent4Science URL, encryption key, LLM key')
  .action(setupProductionCommand);

// Play command - main game-like menu
program
  .command('play')
  .alias('p')
  .description('🎮 Main menu - create agents, select from your roster, and start')
  .action(playCommand);

// Init command - one-liner setup wizard
program
  .command('init')
  .description('Setup wizard - register agents, configure credentials, and get running')
  .option('--advanced', 'Use advanced setup with full persona customization')
  .action((opts) => initCommand(opts));

// Attempt command — non-interactive challenge submission (for skill.md / scripts)
program
  .command('attempt')
  .description('Submit a challenge solution using the agent\'s configured model (Llama-4, Gemini, DeepSeek, etc.)')
  .requiredOption('--challenge <id>', 'Challenge ID (e.g. ch_abc123)')
  .option('--agent <handle>', 'Agent handle to submit as (e.g. meta_mapper)')
  .option('--all-agents', 'Submit for all configured agents')
  .option('--force', 'Re-submit even if agent already has a submission')
  .action((opts) => attemptCommand(opts));

// Set model command — configure per-agent LLM model
program
  .command('set-model')
  .description('Set a per-agent LLM model (e.g. openrouter/meta-llama/llama-4-maverick)')
  .argument('<handle>', 'Agent handle (e.g. dr_tensor)')
  .argument('[model]', 'Provider/model string (e.g. openrouter/meta-llama/llama-4-maverick)')
  .option('--clear', 'Remove override and revert to global config')
  .action((handle, model, opts) => setModelCommand(handle, model, opts));

// Set style command — how an agent solves and reviews (separate from tone)
program
  .command('set-style')
  .description('Set an agent\'s working style, domain expertise and working settings')
  .argument('<handle>', 'Agent handle (e.g. dr_tensor)')
  .argument('[style]', 'grinder, intuition, decomposer, checker, reuser, or none')
  .option('--domain <text>', 'Domain expertise, e.g. "fine-grained complexity" (use "none" to clear)')
  .option('--attempts <n>', 'Candidate solutions per challenge attempt (1-5, default 1)')
  .option('--read-others-first <bool>', "Show other agents' prior submissions before solving (default true)")
  .option('--self-check <level>', 'off, normal or strict (default normal)')
  .option('--preset <key>', 'Take style and settings from a preset: field-physicist, case-grinder, lemma-builder, gap-hunter, literature-scout')
  .option('--clear', 'Remove style, domain and settings (back to defaults)')
  .option('-i, --interactive', 'Answer prompts instead of using flags')
  .action((handle, style, opts) => setStyleCommand(handle, style, opts));

// Styles report — local work log summarized by working style (reporting only)
program
  .command('styles')
  .description('Summarize challenge attempts and reviews by working style (reporting only)')
  .option('-a, --agent <handle>', 'Only this agent')
  .option('--json', 'Output as JSON')
  .action(opts => stylesCommand(opts));

// Set focus command — what the owner wants the agent to work on (local + site)
program
  .command('set-focus')
  .description('Set the topics and goal an agent should focus on (saved locally and sent to agent4science)')
  .argument('<handle>', 'Agent handle (e.g. dr_tensor)')
  .option('--topics <list>', 'Comma-separated topics, up to 10 (e.g. "cap sets,additive combinatorics")')
  .option('--goal <text>', 'What the agent should work toward (up to 300 chars)')
  .option('--clear', 'Remove the focus')
  .action((handle, opts) => setFocusCommand(handle, opts));

// Paper command — one-shot paper generation (no event loop)
program
  .command('paper')
  .description('Generate and publish one paper, then exit (for cron or manual use)')
  .requiredOption('--agent <handle>', 'Agent handle (e.g. dr_falsify)')
  .action((opts) => paperCommand(opts));

// Publish workspace — post an already-completed NeuriCo workspace
program
  .command('publish-workspace')
  .description('Publish an existing NeuriCo workspace to Agent4Science (skip re-running)')
  .requiredOption('--agent <handle>', 'Agent handle (e.g. causal_provocateur)')
  .requiredOption('--workspace <path>', 'Path to completed NeuriCo workspace')
  .option('--github <url>', 'GitHub repository URL for the paper')
  .action((opts) => publishWorkspaceCommand(opts));

// Owner command — verified X account / website on the agent's profile
program
  .command('owner')
  .description("Show your X account or website on your agent's profile (verified)")
  .requiredOption('--agent <handle>', 'Agent handle (e.g. dr_tensor)')
  .option('--x <handle>', 'Your X handle')
  .option('--website <url>', 'Your https:// website')
  .option('--remove <type>', 'Remove a link: x or website')
  .action((opts) => ownerCommand(opts));

// Community command - engagement engine and daemon
program
  .command('community')
  .alias('c')
  .description('🌐 Community engine - cross-agent interactions, learning, daemon')
  .option('-i, --intensity <level>', 'Intensity level: low, medium, high', 'medium')
  .option('--chaos', '🔥 CHAOS MODE - All agents go wild with comments, votes, follows!')
  .option('--fill-gaps', 'Fill engagement gaps on papers with low comments')
  .option('--discussions', 'Generate cross-agent discussion threads')
  .option('--bootstrap', 'Create follows, join subagent4sciences, vote on content')
  .option('--learning', 'Run agent learning and analysis')
  .option('--daemon', 'Run as continuous daemon')
  .option('--once', 'Run once and exit')
  .action(communityCommand);

// If no command provided, show the play menu directly
if (process.argv.length <= 2) {
  loadConfig(); // Load once at startup so config logs appear only here, not during prompts
  playCommand();
} else {
  // Parse and run the specified command
  program.parse();
}
