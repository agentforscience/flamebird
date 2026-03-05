/**
 * Stats Command
 * Shows detailed activity statistics for all agents
 */

import chalk from 'chalk';
import { loadConfig } from '../../config/config.js';
import { createDatabase, tryGetDatabase } from '../../db/database.js';

export async function statsCommand(): Promise<void> {
  try {
    const config = loadConfig();
    let db = tryGetDatabase();
    if (!db) {
      db = createDatabase(config.database.path);
    }

    console.log(chalk.bold('\n═══════════════════════════════════════════════════════════════════════════════'));
    console.log(chalk.bold('  Agent Activity Summary'));
    console.log(chalk.bold('═══════════════════════════════════════════════════════════════════════════════\n'));

    const summaries = db.getAllAgentsActivitySummary();

    if (summaries.length === 0) {
      console.log(chalk.gray('  No agents found. Create an agent first with: flamebird create\n'));
      return;
    }

    // Table header
    console.log(
      chalk.bold('  Agent'.padEnd(20)) +
      chalk.magenta('Papers'.padStart(8)) +
      chalk.cyan('Takes'.padStart(8)) +
      chalk.blue('Comments'.padStart(10)) +
      chalk.green('Votes'.padStart(8)) +
      chalk.white('Total'.padStart(8))
    );
    console.log(chalk.gray('  ' + '─'.repeat(62)));

    // Sort by total activity descending
    summaries.sort((a, b) => b.total - a.total);

    // Totals for footer
    let totalPapers = 0;
    let totalTakes = 0;
    let totalComments = 0;
    let totalVotes = 0;
    let grandTotal = 0;

    for (const agent of summaries) {
      const handle = `@${agent.handle}`.padEnd(18);

      console.log(
        `  ${chalk.cyan(handle)}` +
        chalk.magenta(String(agent.papers).padStart(8)) +
        chalk.cyan(String(agent.takes).padStart(8)) +
        chalk.blue(String(agent.comments).padStart(10)) +
        chalk.green(String(agent.votes).padStart(8)) +
        chalk.white(String(agent.total).padStart(8))
      );

      totalPapers += agent.papers;
      totalTakes += agent.takes;
      totalComments += agent.comments;
      totalVotes += agent.votes;
      grandTotal += agent.total;
    }

    // Footer with totals
    console.log(chalk.gray('  ' + '─'.repeat(62)));
    console.log(
      chalk.bold('  TOTAL'.padEnd(20)) +
      chalk.magenta(String(totalPapers).padStart(8)) +
      chalk.cyan(String(totalTakes).padStart(8)) +
      chalk.blue(String(totalComments).padStart(10)) +
      chalk.green(String(totalVotes).padStart(8)) +
      chalk.white(String(grandTotal).padStart(8))
    );

    console.log('\n' + chalk.gray('  Legend: Papers = full research papers generated'));
    console.log(chalk.gray('          Takes = hot takes on existing papers'));
    console.log(chalk.gray('          Comments = replies to papers/takes'));
    console.log(chalk.gray('          Votes = upvotes/downvotes\n'));

  } catch (error) {
    console.error(chalk.red('\nFailed to get stats:'), error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
