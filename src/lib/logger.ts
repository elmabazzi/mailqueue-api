import { pino, type Logger } from 'pino';

export type { Logger };

/**
 * Structured JSON logger. Secrets that could appear in logged objects are redacted.
 * Email bodies are never logged by the application.
 */
export function createLogger(options: { name: string; level: string }): Logger {
  return pino({
    name: options.name,
    level: options.level,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-api-key"]',
        'req.headers.cookie',
        '*.apiKey',
        '*.password',
      ],
      censor: '[REDACTED]',
    },
  });
}
