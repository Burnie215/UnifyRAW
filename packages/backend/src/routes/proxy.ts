import { Router, json as expressJson, raw as expressRaw } from 'express';
import type { Request, Response } from 'express';
import {
  NetworkResponseTooLargeError,
  NetworkTargetError,
  parsePrivateHostAllowlist,
} from '../security/network-target.js';
import { isForwardableUpstreamHeader } from '../security/upstream-headers.js';
import { requestNetworkBufferForClient } from './client-network.js';

export const proxyRouter = Router();

const MAX_BINARY_BODY_MB = positiveNumber(process.env.PROXY_MAX_BODY_MB, 100);
const MAX_RESPONSE_BYTES = positiveNumber(process.env.PROXY_MAX_RESPONSE_MB, 256) * 1024 * 1024;
const MAX_JSON_BODY_BYTES = positiveNumber(process.env.PROXY_MAX_JSON_BODY_MB, 16) * 1024 * 1024;
// The envelope has to carry a requestBody at that limit even after JSON escaping.
const MAX_JSON_ENVELOPE_BYTES = MAX_JSON_BODY_BYTES * 2 + 64 * 1024;
const REQUEST_TIMEOUT_MS = positiveNumber(process.env.PROXY_TIMEOUT_MS, 120_000);
const TARGET_POLICY = {
  allowPrivate: process.env.PROXY_ALLOW_PRIVATE_TARGETS === 'true',
  allowedPrivateHosts: parsePrivateHostAllowlist(process.env.PROXY_ALLOWED_PRIVATE_HOSTS),
};

/** Forward only a safe subset of headers — no cookies, no internal ones. */
function filterHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === 'string' && isForwardableUpstreamHeader(k, v)) out[k] = v;
  }
  return out;
}

/**
 * POST /api/proxy
 * Body: { url, method?, headers?, requestBody? }
 * Must be registered behind requireAdmin in index.ts because it can reach
 * server-side network targets on the caller's behalf.
 */
proxyRouter.post('/', expressJson({ limit: MAX_JSON_ENVELOPE_BYTES }), async (req: Request, res: Response) => {
  try {
    // Without a JSON body express leaves req.body undefined; that is a 400, not an upstream failure.
    const { url, method, headers, requestBody } = (req.body ?? {}) as {
      url?: unknown;
      method?: unknown;
      headers?: unknown;
      requestBody?: unknown;
    };

    if (typeof url !== 'string' || !url) {
      console.warn('[proxy] 400 Missing url. body-keys=', Object.keys(req.body ?? {}), 'method=', method, 'reqBodyType=', typeof req.body);
      res.status(400).json({ error: 'Missing url' });
      return;
    }

    const methodStr = typeof method === 'string' ? method.toUpperCase() : 'GET';
    const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'PROPFIND', 'PROPPATCH', 'MKCOL', 'COPY', 'MOVE', 'REPORT']);
    if (!ALLOWED_METHODS.has(methodStr)) {
      console.warn('[proxy] 400 Method not allowed. method=', method, 'methodStr=', methodStr, 'url=', url);
      res.status(400).json({ error: 'Method not allowed' });
      return;
    }

    const requestBodyString = typeof requestBody === 'string' ? requestBody : undefined;
    if (requestBodyString && Buffer.byteLength(requestBodyString) > MAX_JSON_BODY_BYTES) {
      res.status(413).json({ error: 'Proxy request body is too large' });
      return;
    }

    const headerObj = (headers && typeof headers === 'object') ? filterHeaders(headers as Record<string, string>) : {};

    const upstream = await requestNetworkBufferForClient(req, res, url, {
      method: methodStr,
      headers: headerObj,
      body: requestBodyString,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      policy: TARGET_POLICY,
    });

    const contentType = upstream.headers['content-type'] ?? 'application/octet-stream';
    res.status(upstream.status).set('Content-Type', contentType).send(upstream.body);
  } catch (e) {
    sendProxyFailure(res, e, '[proxy]');
  }
});

/**
 * POST /api/proxy/binary
 *
 * Binary pass-through for upload paths (multipart, raw PUT, chunked).
 * Required headers:
 *   X-Proxy-Url:     target absolute URL
 *   X-Proxy-Method:  HTTP method (default POST)
 *   X-Proxy-Headers: base64-encoded JSON object of upstream headers
 *                    (Authorization, Content-Type, Dropbox-Api-Arg, …)
 *
 * Request body is forwarded verbatim. Content-Type comes from
 * X-Proxy-Headers, NOT from the request's own Content-Type (which has
 * to be `application/octet-stream` so we accept the raw stream).
 *
 * Response is mirrored 1:1 (status, content-type, body bytes).
 */
proxyRouter.post(
  '/binary',
  expressRaw({ type: '*/*', limit: `${MAX_BINARY_BODY_MB}mb` }),
  async (req: Request, res: Response) => {
    try {
      const url = req.header('x-proxy-url');
      const methodHeader = req.header('x-proxy-method');
      const headersB64 = req.header('x-proxy-headers');

      if (!url) {
        res.status(400).json({ error: 'Missing X-Proxy-Url' });
        return;
      }
      const methodStr = (methodHeader ?? 'POST').toUpperCase();
      const ALLOWED_METHODS = new Set(['POST', 'PUT', 'PATCH']);
      if (!ALLOWED_METHODS.has(methodStr)) {
        res.status(400).json({ error: 'Method not allowed for binary proxy' });
        return;
      }

      let upstreamHeaders: Record<string, string> = {};
      if (headersB64) {
        try {
          const decoded = Buffer.from(headersB64, 'base64').toString('utf8');
          const parsed = JSON.parse(decoded) as unknown;
          if (parsed && typeof parsed === 'object') {
            upstreamHeaders = filterHeaders(parsed as Record<string, string>);
          }
        } catch {
          res.status(400).json({ error: 'Invalid X-Proxy-Headers (expect base64 JSON)' });
          return;
        }
      }

      // express.raw produces a Buffer; if missing, treat as empty body.
      const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

      const upstream = await requestNetworkBufferForClient(req, res, url, {
        method: methodStr,
        headers: upstreamHeaders,
        body: body.length > 0 ? body : undefined,
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        policy: TARGET_POLICY,
      });

      const contentType = upstream.headers['content-type'] ?? 'application/octet-stream';
      res.status(upstream.status).set('Content-Type', contentType).send(upstream.body);
    } catch (e) {
      sendProxyFailure(res, e, '[proxy/binary]');
    }
  },
);

function sendProxyFailure(res: Response, error: unknown, prefix: string): void {
  if (res.destroyed) return;
  if (error instanceof NetworkTargetError) {
    res.status(403).json({ error: error.message });
    return;
  }
  if (error instanceof NetworkResponseTooLargeError) {
    res.status(502).json({ error: 'Upstream response is too large' });
    return;
  }
  console.error(`${prefix} request failed`, error);
  res.status(502).json({ error: 'Upstream request failed' });
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
