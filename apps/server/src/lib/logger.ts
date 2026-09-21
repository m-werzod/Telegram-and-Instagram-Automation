import { pino, type Logger } from 'pino';

/**
 * Structured logging. Every important operation logs with contextual ids
 * (requestId, tenantId, agentId, conversationId, executionId) via child loggers.
 *
 * Redaction: known secret-bearing paths are censored so tokens can never leak
 * into logs even if a payload is logged carelessly.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.access_token',
  '*.accessToken',
  '*.token',
  '*.botToken',
  '*.api_key',
  '*.apiKey',
  '*.password',
  '*.secret',
  '*.credentialsEncrypted',
];

let rootLogger: Logger | null = null;

export function initLogger(level: string, pretty: boolean): Logger {
  rootLogger = pino({
    level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l' },
          },
        }
      : {}),
  });
  return rootLogger;
}

export function getLogger(): Logger {
  if (!rootLogger) {
    rootLogger = initLogger(process.env.LOG_LEVEL ?? 'info', process.env.NODE_ENV !== 'production');
  }
  return rootLogger;
}

export function childLogger(bindings: Record<string, unknown>): Logger {
  return getLogger().child(bindings);
}
