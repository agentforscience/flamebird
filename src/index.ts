/**
 * Agent4Science Agent Runtime
 * Main entry point - starts the persistent agent runtime
 */

import { writeFileSync, mkdirSync, unlinkSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { createEventLoop } from './runtime/event-loop.js';
import { createLogger } from './logging/logger.js';
import { validateSecrets } from './config/config.js';

const logger = createLogger('main');

const PID_FILE = join(process.cwd(), 'data', 'runtime.pid');

function writePidFile(): void {
  const dir = dirname(PID_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(PID_FILE, process.pid.toString());
  logger.debug(`PID file written: ${PID_FILE}`);
}

function removePidFile(): void {
  try {
    if (existsSync(PID_FILE)) {
      unlinkSync(PID_FILE);
      logger.debug('PID file removed');
    }
  } catch {
    // Ignore errors on cleanup
  }
}

async function main(): Promise<void> {
  logger.info('Agent4Science Agent Runtime starting...');
  logger.info('═'.repeat(50));

  // Write PID file for stop command
  writePidFile();

  // Validate environment
  try {
    validateSecrets();
  } catch (error) {
    logger.error({ err: error }, 'Configuration error');
    removePidFile();
    process.exit(1);
  }

  // Create and initialize the event loop
  const eventLoop = await createEventLoop();

  // Set up graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    await eventLoop.stop();
    removePidFile();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Log events (for debugging)
  eventLoop.on((event) => {
    switch (event.type) {
      case 'notification_received':
        logger.info(`📬 ${event.agentId} received ${event.notification.type}`);
        break;
      case 'action_executed':
        logger.info(`✅ Action ${event.result.actionId} completed`);
        break;
      case 'action_failed':
        logger.warn(`❌ Action ${event.actionId} failed: ${event.error}`);
        break;
      case 'rate_limit_hit':
        logger.warn(`⏳ Rate limit hit for ${event.agentId} on ${event.action}`);
        break;
      case 'error':
        logger.error({ err: event.error }, `🚨 ${event.message}`);
        break;
    }
  });

  // Start the event loop
  await eventLoop.start();

  logger.info('═'.repeat(50));
  logger.info('Agent runtime is running. Press Ctrl+C to stop.');

  // Keep the process alive
  await new Promise(() => {});
}

main().catch((error) => {
  logger.error({ err: error }, 'Fatal error');
  process.exit(1);
});
