/**
 * Set Model Command
 * Configure a per-agent LLM model override
 *
 * Usage:
 *   flamebird set-model <handle> openrouter/meta-llama/llama-4-maverick
 *   flamebird set-model <handle> openrouter/google/gemini-2.5-flash
 *   flamebird set-model <handle> --clear
 *
 * Only openrouter is supported — all models (Claude, Gemini, Llama, DeepSeek, etc.)
 * are accessible via the single OpenRouter API key in .flamebird/.env.
 * Direct anthropic/openai providers would require a separate API key not supported here.
 */

import chalk from 'chalk';
import { loadConfig } from '../../config/config.js';
import { createDatabase, tryGetDatabase } from '../../db/database.js';
import type { AgentLLMOverride } from '../../types.js';

const VALID_PROVIDERS = ['openrouter'] as const;

interface SetModelOptions {
  clear?: boolean;
}

export async function setModelCommand(handle: string, modelArg: string | undefined, options: SetModelOptions): Promise<void> {
  try {
    const config = loadConfig();
    const db = tryGetDatabase() ?? createDatabase(config.database.path);

    const cleanHandle = handle.replace('@', '');
    const agent = db.getAgentByHandle(cleanHandle);
    if (!agent) {
      console.error(chalk.red(`Agent @${cleanHandle} not found. Run "flamebird list" to see configured agents.`));
      process.exit(1);
    }

    // --clear: remove override, revert to global config
    if (options.clear) {
      db.updateAgentLlmOverride(agent.id, null);
      console.log(chalk.green(`✓ @${cleanHandle} will now use the global model (${config.llm.provider}/${config.llm.model})`));
      return;
    }

    if (!modelArg) {
      console.error(chalk.red('Provide a model as openrouter/<model>, e.g.:'));
      console.error(chalk.gray('  flamebird set-model dr_tensor openrouter/meta-llama/llama-4-maverick'));
      console.error(chalk.gray('  flamebird set-model dr_tensor openrouter/google/gemini-2.5-flash'));
      console.error(chalk.gray('  flamebird set-model dr_tensor openrouter/anthropic/claude-opus-4-6'));
      console.error(chalk.gray('  flamebird set-model dr_tensor --clear'));
      process.exit(1);
    }

    // Parse "provider/model" — provider is first segment, model is everything after
    const slashIdx = modelArg.indexOf('/');
    if (slashIdx === -1) {
      console.error(chalk.red(`Invalid format "${modelArg}". Use <provider/model>, e.g. openrouter/meta-llama/llama-4-maverick`));
      process.exit(1);
    }

    const provider = modelArg.slice(0, slashIdx) as AgentLLMOverride['provider'];
    const model = modelArg.slice(slashIdx + 1);

    if (!VALID_PROVIDERS.includes(provider as typeof VALID_PROVIDERS[number])) {
      console.error(chalk.red(`Unknown provider "${provider}". Only openrouter is supported.`));
      console.error(chalk.gray('  Example: flamebird set-model dr_tensor openrouter/meta-llama/llama-4-maverick'));
      process.exit(1);
    }
    if (!model) {
      console.error(chalk.red('Model name cannot be empty after the provider prefix.'));
      process.exit(1);
    }

    const llmOverride: AgentLLMOverride = { provider, model };
    db.updateAgentLlmOverride(agent.id, llmOverride);

    console.log(chalk.green(`✓ @${cleanHandle} will now use ${chalk.cyan(provider + '/' + model)}`));
    console.log(chalk.gray('  This applies to: attempt, interactive, and the autonomous runtime.'));

  } catch (error) {
    console.error(chalk.red('set-model failed:'), error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
