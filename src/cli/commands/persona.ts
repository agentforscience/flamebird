/**
 * Persona Command
 * Give an agent a persona card: how it works and argues, not words it says.
 *
 * Usage:
 *   flamebird persona list                                  the built-in archetypes
 *   flamebird persona show <handle>                         the agent's current card
 *   flamebird persona set <handle> <archetype>              use a built-in archetype
 *   flamebird persona set <handle> --file card.json         use your own card
 *   flamebird persona scientist <handle> "George Pólya" --source "How to Solve It (1945)" [--source ...]
 *                                                           draft a card from a historical scientist's published methods
 *   flamebird persona clear <handle>                        remove the card
 *
 * Scientist cards: historical scientists only for now. Every habit cites one of
 * your sources. The agent never claims to be the person, and its bio on
 * agent4science says what the method is based on.
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import { readFileSync } from 'fs';
import { loadConfig } from '../../config/config.js';
import { createDatabase, tryGetDatabase } from '../../db/database.js';
import { decryptApiKey } from '../../agents/agent-manager.js';
import { createAgent4ScienceClient } from '../../api/agent4science-client.js';
import { createLLMClient, getOrCreateLLMClient } from '../../llm/llm-client.js';
import { ARCHETYPES, archetypeCard, archetypeWorkStyle, describeCard, validateCard } from '../../personas/archetypes.js';
import { bioWithAttribution, checkSource, draftMethodCard, nameClash, parseSource } from '../../personas/method-of.js';
import type { AgentPersona, PersonaCard } from '../../types.js';

interface PersonaOptions {
  file?: string;
  source?: string[];
  yes?: boolean;
  bio?: boolean;
  json?: boolean;
}

function printCard(card: PersonaCard): void {
  console.log(chalk.bold(`  ${card.name}`) + chalk.dim(` [${card.kind}${card.kind === 'archetype' ? `: ${card.id}` : ''}]`));
  console.log(`  Approach: ${card.approach}`);
  console.log('  Always checks:'); card.alwaysChecks.forEach(c => console.log(`    - ${c}`));
  console.log('  Moves:'); card.moves.forEach(m => console.log(`    - ${m}`));
  if (card.blindSpots.length) { console.log('  Blind spots:'); card.blindSpots.forEach(b => console.log(`    - ${b}`)); }
  console.log(`  Style: ${card.style}`);
  if (card.basedOn) {
    console.log(`  Based on: ${card.basedOn.scientist} (died ${card.basedOn.died})`);
    card.basedOn.sources.forEach((s, i) => console.log(`    [${i + 1}] ${s.title}${s.year ? ` (${s.year})` : ''}${s.doi ? ` doi:${s.doi}` : ''}${s.arxiv ? ` arXiv:${s.arxiv}` : ''}  ${chalk.dim(s.check ?? 'unchecked')}`));
  }
}

async function confirm(message: string, yes?: boolean): Promise<boolean> {
  if (yes) return true;
  const { ok } = await inquirer.prompt([{ type: 'confirm', name: 'ok', message, default: false }]);
  return ok;
}

/** Update the attribution line in the agent's site bio. Failures leave the local card in place. */
async function syncBio(agent: { apiKeyEncrypted: string; handle: string }, card: PersonaCard | undefined): Promise<void> {
  const config = loadConfig();
  const client = createAgent4ScienceClient({ baseUrl: config.api.apiUrl });
  const apiKey = decryptApiKey(agent.apiKeyEncrypted, config.security.encryptionKey);
  const me = await client.getMe(apiKey);
  if (!me.success || !me.data) { console.log(chalk.yellow('  Could not read the agent\'s bio on agent4science; run this again later to update it.')); return; }
  const current = (me.data as { bio?: string }).bio ?? '';
  const next = bioWithAttribution(current, card);
  if (next === current.trim()) return;
  const res = await client.updateMe(apiKey, { bio: next });
  console.log(res.success ? chalk.green('✓ Bio on agent4science updated') : chalk.yellow(`  The site did not take the bio (${res.error}); run this again later.`));
}

function save(db: NonNullable<ReturnType<typeof tryGetDatabase>>, id: string, persona: AgentPersona, card: PersonaCard | undefined): AgentPersona {
  const next = { ...persona };
  if (card) next.card = card; else delete next.card;
  db.updateAgentPersona(id, next);
  return next;
}

export async function personaCommand(action: string | undefined, handle: string | undefined, value: string | undefined, options: PersonaOptions): Promise<void> {
  try {
    if (!action || action === 'list') {
      console.log(chalk.bold('\n  Archetypes (flamebird persona set <handle> <id>):\n'));
      for (const a of ARCHETYPES) console.log(`  ${chalk.cyan(a.id.padEnd(22))} ${a.approach}`);
      console.log(chalk.dim('\n  Or: --file card.json for your own card, or "persona scientist" for a historical scientist\'s method.\n'));
      return;
    }

    const config = loadConfig();
    const db = tryGetDatabase() ?? createDatabase(config.database.path);
    const clean = (handle || '').replace('@', '');
    const agent = clean ? db.getAgentByHandle(clean) : undefined;
    if (!agent) {
      console.error(chalk.red(clean ? `Agent @${clean} not found. Run "flamebird list" to see configured agents.` : 'Give an agent handle.'));
      process.exit(1);
    }

    if (action === 'show') {
      if (agent.persona.card && options.json) console.log(JSON.stringify(agent.persona.card, null, 2));
      else if (agent.persona.card) printCard(agent.persona.card); else console.log(`@${clean}: no persona card. See "flamebird persona list".`);
      return;
    }

    if (action === 'clear') {
      const had = agent.persona.card;
      save(db, agent.id, agent.persona, undefined);
      console.log(chalk.green(`✓ @${clean}: persona card removed`));
      if (had?.kind === 'method_of' && options.bio !== false) await syncBio(agent, undefined);
      return;
    }

    if (action === 'set') {
      let card: PersonaCard | undefined;
      if (options.file) {
        const raw = JSON.parse(readFileSync(options.file, 'utf8'));
        // An edited method-of card keeps its kind (and its source rules); anything else is custom.
        const parsed = validateCard({ ...raw, kind: raw?.kind === 'method_of' ? 'method_of' : 'custom' });
        if ('error' in parsed) throw new Error(parsed.error);
        card = parsed.card;
      } else if (value) {
        card = archetypeCard(value);
        if (!card) throw new Error(`Unknown archetype "${value}". Run "flamebird persona list".`);
      } else {
        throw new Error('Give an archetype id or --file card.json');
      }
      let persona = save(db, agent.id, agent.persona, card);
      const style = card.kind === 'archetype' ? archetypeWorkStyle(card.id) : undefined;
      if (style && !persona.workStyle) {
        persona = { ...persona, workStyle: style };
        db.updateAgentPersona(agent.id, persona);
        console.log(chalk.dim(`  Working style set to ${style} to match (change with "flamebird set-style").`));
      }
      console.log(chalk.green(`✓ @${clean}: ${describeCard(card)}`));
      if (card.kind === 'method_of') {
        const clash = nameClash(card.basedOn!.scientist, agent.handle, agent.displayName);
        if (clash) throw new Error(`@${clean}'s handle or display name contains "${clash}"; rename it first.`);
      }
      if ((agent.persona.card?.kind === 'method_of' || card.kind === 'method_of') && options.bio !== false) await syncBio(agent, card);
      return;
    }

    if (action === 'scientist') {
      const scientist = (value || '').trim();
      if (!scientist) throw new Error('Give the scientist\'s name, e.g. persona scientist <handle> "George Pólya" --source "How to Solve It (1945)"');
      const clash = nameClash(scientist, agent.handle, agent.displayName);
      if (clash) throw new Error(`@${clean}'s handle or display name contains "${clash}". An agent with a method card may not use the scientist's name; rename it first.`);
      const sources = (options.source ?? []).map(parseSource).filter(s => s.title);
      if (!sources.length) throw new Error('Give at least one --source: a work by the scientist that documents their method (title and year, DOI or arXiv ID).');

      console.log(chalk.dim('  Checking sources...'));
      for (const s of sources) s.check = await checkSource(s);
      const missing = sources.filter(s => s.check === 'no_record');
      if (missing.length) throw new Error(`These sources do not resolve: ${missing.map(s => s.doi || s.arxiv).join(', ')}`);

      console.log(chalk.dim('  Drafting the card from the sources...'));
      createLLMClient(config.llm);
      const llm = getOrCreateLLMClient(db.getAgent(agent.id)?.llmOverride);
      const draft = await draftMethodCard(llm, scientist, sources);
      if ('error' in draft) throw new Error(draft.error);
      const card = draft.card;
      console.log('');
      printCard(card);
      console.log('');
      console.log(chalk.yellow('  Check every habit against the sources before saving. To edit: save it, then "persona show <handle> --json > card.json", edit, and "persona set <handle> --file card.json".'));
      if (!(await confirm(`${scientist} died in ${card.basedOn!.died}, and the habits above match the listed sources. Save this card?`, options.yes))) {
        console.log('  Not saved.');
        return;
      }
      save(db, agent.id, agent.persona, card);
      console.log(chalk.green(`✓ @${clean}: ${describeCard(card)}`));
      if (options.bio !== false) await syncBio(agent, card);
      return;
    }

    throw new Error(`Unknown action "${action}". Use list, show, set, scientist or clear.`);
  } catch (error) {
    console.error(chalk.red('persona failed:'), error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
