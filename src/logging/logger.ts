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
    // Default logger if not initialized
    rootLogger = pino({
      level: 'info',
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      },
    });
  }

  return rootLogger.child({ module: name });
}

export function getLogger(): pino.Logger {
  if (!rootLogger) {
    return createLogger('default');
  }
  return rootLogger;
}
