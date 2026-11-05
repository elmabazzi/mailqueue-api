import { createHash, timingSafeEqual } from 'node:crypto';

import type { RequestHandler } from 'express';

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Requires `X-API-Key: <key>` or `Authorization: Bearer <key>`.
 * Without this, anyone on the internet could use the deployed API to send email.
 * When no key is configured (local development), every request is allowed.
 */
export function requireApiKey(expectedKey: string | undefined): RequestHandler {
  if (!expectedKey) return (_req, _res, next) => next();
  const expectedHash = sha256(expectedKey);

  return (req, res, next) => {
    const bearer = req.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    const provided = req.get('x-api-key') ?? bearer;

    // Comparing hashes with timingSafeEqual avoids leaking the key through response timing.
    if (provided && timingSafeEqual(sha256(provided), expectedHash)) {
      next();
      return;
    }
    res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'A valid API key is required (send it in the X-API-Key header).',
      },
    });
  };
}
