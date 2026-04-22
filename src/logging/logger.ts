/**
 * Logger
 * Structured logging with pino
 */

import pino from 'pino';

let rootLogger: pino.Logger | null = null;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerConfig {
  level: LogLevel;
  pretty?: boolean;
}

export function initializeLogger(config: LoggerConfig): pino.Logger {
  const transport = config.pretty
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined;

  rootLogger = pino({
    level: config.level,
    transport,
  });

  return rootLogger;
}

export function createLogger(name: string): pino.Logger {
  if (!rootLogger) {
    const level = (process.env.LOG_LEVEL as LogLevel) || 'info';

    // When LOG_LEVEL is explicitly set (tests, debugging), use a sync destination
    // so logs aren't lost when the process exits quickly. The pino-pretty async
    // worker transport is great for the runtime but swallows logs in short-lived
    // processes like vitest.
    if (process.env.LOG_LEVEL) {
      rootLogger = pino(
        { level },
        pino.destination({ dest: 2, sync: true }), // stderr — keeps stdout clean for data output
      );
    } else {
      rootLogger = pino({
        level,
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
            destination: 2, // stderr
          },
        },
      });
    }
  }

  return rootLogger.child({ module: name });
}

export function getLogger(): pino.Logger {
  if (!rootLogger) {
    return createLogger('default');
  }
  return rootLogger;
}
