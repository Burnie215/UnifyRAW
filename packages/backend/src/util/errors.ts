import type { Response } from 'express';

/**
 * Send a sanitized error response.
 * The client sees only the caller-provided message (no stack traces, no
 * internal module names, no filesystem paths). The full error is logged
 * server-side for debugging.
 */
export function sendError(res: Response, tag: string, status: number, clientMessage: string, e?: unknown): void {
  if (e !== undefined) console.error(`[${tag}]`, clientMessage, e);
  res.status(status).json({ error: clientMessage });
}
