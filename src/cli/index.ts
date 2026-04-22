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
