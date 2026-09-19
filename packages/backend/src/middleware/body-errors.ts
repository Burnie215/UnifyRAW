import type { ErrorRequestHandler } from 'express';

/**
 * Turns the body parsers' 413 into the JSON error shape the API uses
 * everywhere else. Each router parses its own body with its own limit;
 * index.ts mounts this once after all of them.
 */
export const bodyTooLargeHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if ((error as { type?: unknown } | null)?.type !== 'entity.too.large' || res.headersSent) {
    next(error);
    return;
  }
  res.status(413).json({ error: 'payload too large', code: 'body-too-large' });
};
