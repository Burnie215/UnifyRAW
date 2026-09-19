import { config, hasBackend } from './config';
import { readSyncSettings } from '../storage/syncSettings';

/**
 * Raised instead of letting a backend call reach a build that has none. The
 * static host answers every unknown path with index.html, so the request would
 * otherwise succeed with HTML that the caller then parses as JSON — a
 * confusing failure instead of a clear one (ONLINE_MODE_PLAN §P5).
 */
export class NoBackendError extends Error {
  readonly name = 'NoBackendError';
  readonly path: string;

  constructor(path: string) {
    super(
      `No PhotoLib backend in this build: "${path}" would be served by the static host. `
      + 'The online version runs entirely in the browser; set a server URL under '
      + 'Settings → Data → Storage → Server (HTTPS only), or use the '
      + 'selfhost build.',
    );
    this.path = path;
  }
}

/**
 * §P9: a server URL set under Settings is a valid state in the online build,
 * so the guard only fires when there is none. An absolute URL to somebody
 * else's server is not our backend and passes through; one pointing back at
 * our own origin does not, because that is exactly the static host.
 */
function assertBackendAvailable(path: string): void {
  if (hasBackend()) return;
  if (/^https?:\/\//i.test(path) && !isAppOrigin(path)) return;
  throw new NoBackendError(path);
}

function isAppOrigin(requestUrl: string): boolean {
  const currentOrigin = typeof window !== 'undefined' ? window.location.origin : '';
  return currentOrigin !== '' && normalizeOrigin(requestUrl) === normalizeOrigin(currentOrigin);
}

/**
 * Fetch wrapper for backend API calls.
 * Automatically prepends the backend URL.
 */
export async function apiFetch(path: string, options?: RequestInit): Promise<Response> {
  assertBackendAvailable(path);
  const requestUrl = resolveApiUrl(path);
  const headers = new Headers(options?.headers);
  const isFormData = typeof FormData !== 'undefined' && options?.body instanceof FormData;
  if (options?.body !== undefined && !isFormData && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const token = readBackendToken();
  if (token && isBackendRequest(requestUrl) && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  return fetch(requestUrl, {
    ...options,
    headers,
  });
}

function resolveApiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${config.backendUrl || ''}${path}`;
}

function isBackendRequest(requestUrl: string): boolean {
  const currentOrigin = typeof window !== 'undefined' ? window.location.origin : '';
  const backendOrigin = normalizeOrigin(config.backendUrl || currentOrigin);
  return backendOrigin !== '' && normalizeOrigin(requestUrl) === backendOrigin;
}

function readBackendToken(): string | null {
  const settings = readSyncSettings();
  if (!settings?.token) return null;

  const currentOrigin = typeof window !== 'undefined' ? window.location.origin : '';
  const backend = normalizeOrigin(config.backendUrl || currentOrigin);
  return normalizeOrigin(settings.serverUrl) === backend ? settings.token : null;
}

function normalizeOrigin(value: string): string {
  try {
    const currentOrigin = typeof window !== 'undefined' ? window.location.origin : '';
    const url = currentOrigin ? new URL(value, currentOrigin) : new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : '';
  } catch {
    return '';
  }
}

/**
 * Proxy fetch — routes requests through the backend proxy.
 * Works in both modes (replaces the Vite dev proxy).
 *
 * String / no-body requests go through `POST /api/proxy` (JSON envelope).
 * Blob / FormData / ArrayBuffer bodies go through `POST /api/proxy/binary`
 * with the raw bytes as the request body and metadata in X-Proxy-* headers
 * (see packages/backend/src/routes/proxy.ts).
 */
export async function proxyFetch(
  url: string,
  options?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Blob | FormData | ArrayBuffer | Uint8Array;
    redirect?: RequestRedirect;
    signal?: AbortSignal;
  },
): Promise<Response> {
  const body = options?.body;
  const isBinary = body !== undefined && typeof body !== 'string';

  if (!isBinary) {
    return apiFetch('/api/proxy', {
      method: 'POST',
      body: JSON.stringify({
        url,
        method: options?.method ?? 'GET',
        headers: options?.headers,
        requestBody: typeof body === 'string' ? body : undefined,
      }),
      signal: options?.signal,
    });
  }

  // Binary path: stream raw bytes; upstream headers travel base64-encoded.
  const upstreamHeaders = options?.headers ?? {};

  // For FormData we must let the browser set Content-Type with its boundary.
  // We DO NOT pre-serialize FormData — the browser does it when we pass it
  // as `body` to fetch, and sets the multipart header. We then capture the
  // resulting Content-Type by sending FormData through a Request object.
  let payload: BodyInit;
  let contentTypeForUpstream: string | undefined = upstreamHeaders['Content-Type']
    ?? upstreamHeaders['content-type'];

  if (body instanceof FormData) {
    // Materialize via Request so the browser fills in the boundary.
    const tmp = new Request('https://x.invalid/', { method: 'POST', body });
    const blob = await tmp.blob();
    payload = blob;
    contentTypeForUpstream = tmp.headers.get('content-type') ?? 'multipart/form-data';
  } else if (body instanceof Blob) {
    payload = body;
    contentTypeForUpstream ??= body.type || 'application/octet-stream';
  } else {
    // ArrayBuffer / Uint8Array
    payload = body as unknown as BodyInit;
    contentTypeForUpstream ??= 'application/octet-stream';
  }

  const mergedHeaders: Record<string, string> = { ...upstreamHeaders };
  if (contentTypeForUpstream) mergedHeaders['Content-Type'] = contentTypeForUpstream;

  const headersB64 = btoa(unescape(encodeURIComponent(JSON.stringify(mergedHeaders))));

  return apiFetch('/api/proxy/binary', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Proxy-Url': url,
      'X-Proxy-Method': options?.method ?? 'POST',
      'X-Proxy-Headers': headersB64,
    },
    body: payload,
    signal: options?.signal,
  });
}
