import type { ErrorRequestHandler, RequestHandler } from 'express';

import type { Logger } from '../../lib/logger.js';
import { EmailJobNotFoundError } from '../../models/errors.js';
import { RequestValidationError } from '../validation.js';

/** Errors created by Express's JSON body parser carry a `type` and an HTTP `status`. */
function isBodyParserError(error: unknown): error is Error & { type: string; status: number } {
  return error instanceof Error && 'type' in error && 'status' in error;
}

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: 'ROUTE_NOT_FOUND', message: `Route ${req.method} ${req.path} does not exist` },
  });
};

/** Turns every error into a consistent JSON response. The only place that maps errors to HTTP. */
export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, req, res, _next) => {
    if (error instanceof RequestValidationError) {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: error.message, details: error.issues },
      });
      return;
    }

    if (error instanceof EmailJobNotFoundError) {
      res.status(404).json({ error: { code: error.code, message: error.message } });
      return;
    }

    if (isBodyParserError(error)) {
      const tooLarge = error.type === 'entity.too.large';
      res.status(tooLarge ? 413 : 400).json({
        error: {
          code: tooLarge ? 'PAYLOAD_TOO_LARGE' : 'INVALID_JSON',
          message: tooLarge ? 'Request body is too large' : 'Request body is not valid JSON',
        },
      });
      return;
    }

    // Anything else is a bug or an outage: log the details, return a generic message.
    logger.error({ err: error, method: req.method, path: req.path }, 'Unhandled request error');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again later.' },
    });
  };
}
