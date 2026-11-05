import { randomUUID } from 'node:crypto';

import { pinoHttp } from 'pino-http';

import type { Logger } from '../../lib/logger.js';

const SAFE_REQUEST_ID = /^[\w-]{1,100}$/;

/**
 * Logs one line per request (method, URL, status, duration) and gives each request an id,
 * returned in the X-Request-Id header so a client can quote it when reporting a problem.
 */
export function createRequestLogger(logger: Logger) {
  return pinoHttp({
    logger,
    genReqId: (req, res) => {
      const incoming = req.headers['x-request-id'];
      const id =
        typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    customLogLevel: (_req, res, error) => {
      if (error || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    // Uptime monitors call /health every minute; logging every successful check is noise.
    autoLogging: { ignore: (req) => req.url === '/health' },
  });
}
