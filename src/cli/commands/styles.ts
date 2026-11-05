/**
 * Styles Command
 * Summarize the local work log by working style: attempts, submissions,
 * blocked and failed attempts, reviews, and best scores where known.
 * Reporting only: it never changes an agent's style.
 *
 * Usage:
 *   flamebird styles
 *   flamebird styles --agent dr_tensor
 *   flamebird styles --json
 */

import chalk from 'chalk';
import { loadConfig } from '../../config/config.js';
import { createDatabase, tryGetDatabase, type WorkLogRow } from '../../db/database.js';

interface StylesOptions {
  agent?: string;
  json?: boolean;
}

export interface StyleSummary {
  style: string;
  agents: number;
  attempts: number;
  submitted: number;
  blocked: number;
  failed: number;
  reviews: number;
  scored: number;
}

export interface BestScore {
  challengeId: string;
  direction: 'maximize' | 'minimize' | 'unknown';
  /** Best score per style on this challenge, best first. */
  byStyle: Array<{ style: string; score: number }>;
}

export interface StylesReport {
  styles: StyleSummary[];
  bestScores: BestScore[];
}

const styleName = (row: WorkLogRow) => row.work_style || 'default';

/** Pure summary of work-log rows. Rows without a score never count toward best scores. */
export function summarizeWorkLog(rows: WorkLogRow[]): StylesReport {
  const byStyle = new Map<string, StyleSummary & { agentIds: Set<string> }>();
  for (const r of rows) {
    const key = styleName(r);
    const s = byStyle.get(key) ?? { style: key, agents: 0, attempts: 0, submitted: 0, blocked: 0, failed: 0, reviews: 0, scored: 0, agentIds: new Set<string>() };
    s.agentIds.add(r.agent_id);
    if (r.kind === 'review') {
      if (r.status === 'submitted') s.reviews++;
    } else {
      s.attempts++;
      if (r.status === 'submitted') s.submitted++;
      else if (r.status === 'blocked') s.blocked++;
      else if (r.status === 'failed') s.failed++;
      if (typeof r.score === 'number') s.scored++;
    }
    byStyle.set(key, s);
  }
  const styles = [...byStyle.values()]
    .map(({ agentIds, ...s }) => ({ ...s, agents: agentIds.size }))
    .sort((a, b) => b.attempts + b.reviews - (a.attempts + a.reviews) || a.style.localeCompare(b.style));

  const challenges = new Map<string, { direction: BestScore['direction']; best: Map<string, number> }>();
  for (const r of rows) {
    if (r.kind !== 'submission' || r.status !== 'submitted' || typeof r.score !== 'number') continue;
    const c = challenges.get(r.target_id) ?? { direction: 'unknown' as BestScore['direction'], best: new Map<string, number>() };
    if (r.scoring_direction === 'minimize' || r.scoring_direction === 'maximize') c.direction = r.scoring_direction;
    challenges.set(r.target_id, c);
  }
  for (const r of rows) {
    if (r.kind !== 'submission' || r.status !== 'submitted' || typeof r.score !== 'number') continue;
    const c = challenges.get(r.target_id)!;
    const minimize = c.direction === 'minimize';
    const key = styleName(r);
    const prev = c.best.get(key);
    if (prev === undefined || (minimize ? r.score < prev : r.score > prev)) c.best.set(key, r.score);
  }
  const bestScores: BestScore[] = [...challenges.entries()].map(([challengeId, c]) => ({
    challengeId,
    direction: c.direction,
    byStyle: [...c.best.entries()]
      .map(([style, score]) => ({ style, score }))
      .sort((a, b) => (c.direction === 'minimize' ? a.score - b.score : b.score - a.score) || a.style.localeCompare(b.style)),
  })).sort((a, b) => a.challengeId.localeCompare(b.challengeId));

  return { styles, bestScores };
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toPrecision(6).replace(/\.?0+$/, '');
}

export async function stylesCommand(options: StylesOptions): Promise<void> {
  try {
    if (options.json) process.env.LOG_LEVEL = 'error';
    const config = loadConfig();
    const db = tryGetDatabase() ?? createDatabase(config.database.path);

    let agentId: string | undefined;
    if (options.agent) {
      const agent = db.getAgentByHandle(options.agent.replace('@', ''));
      if (!agent) {
        console.error(chalk.red(`Agent @${options.agent.replace('@', '')} not found.`));
        process.exit(1);
      }
      agentId = agent.id;
    }

    const report = summarizeWorkLog(db.getAllWorkLog(agentId));
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    if (!report.styles.length) {
      console.log(chalk.yellow('\nNo work logged yet. Challenge attempts and reviews are logged as agents work.\n'));
      return;
    }

    console.log(chalk.bold(`\nWork by style${options.agent ? ` for @${options.agent.replace('@', '')}` : ''}:\n`));
    const header = ['style', 'agents', 'attempts', 'submitted', 'blocked', 'failed', 'reviews'];
    const rows = report.styles.map(s => [s.style, s.agents, s.attempts, s.submitted, s.blocked, s.failed, s.reviews].map(String));
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
    const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
    console.log('  ' + chalk.gray(line(header)));
    for (const r of rows) console.log('  ' + line(r));

    if (report.bestScores.length) {
      console.log(chalk.bold('\nBest scores by challenge (where known):'));
      for (const b of report.bestScores) {
        const dir = b.direction === 'unknown' ? ' (direction unknown, highest shown)' : ` (${b.direction})`;
        console.log(`  ${b.challengeId}${dir}: ${b.byStyle.map(x => `${x.style} ${fmt(x.score)}`).join(', ')}`);
      }
    } else {
      console.log(chalk.gray('\nNo scores recorded yet.'));
    }
    console.log(chalk.gray('\nReporting only. Change a style with "flamebird set-style <handle> <style>".\n'));
  } catch (error) {
    console.error(chalk.red('styles failed:'), error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
