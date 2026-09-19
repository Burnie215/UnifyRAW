import { proxyFetch } from './api';
import { hasBackend } from './config';
import { sourceCapability } from '../sources/capabilities';

export type SourceTransportMode = 'server-proxy' | 'browser-direct';

export interface SourceTransportConfig {
  /** Defaults to the PhotoLib backend proxy for backwards compatibility. */
  transport?: SourceTransportMode;
}

export interface SourceFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Blob | FormData | ArrayBuffer | Uint8Array;
  redirect?: RequestRedirect;
  signal?: AbortSignal;
}

export type SourceFetch = (url: string, options?: SourceFetchOptions) => Promise<Response>;

export type DirectSourceFetchErrorCode = 'invalid-url' | 'https-required';

/** A local validation failure raised before browser credentials are sent. */
export class DirectSourceFetchError extends Error {
  readonly name = 'DirectSourceFetchError';
  readonly code: DirectSourceFetchErrorCode;

  constructor(code: DirectSourceFetchErrorCode) {
    super(code === 'invalid-url'
      ? 'Direct source access requires an absolute HTTPS URL'
      : 'Direct source access requires HTTPS');
    this.code = code;
  }
}

/**
 * A stored preference always wins. Without one the proxy used to be the
 * answer — but in a build without a backend the proxy does not exist, so a
 * source that can go direct has to (§P4). The user's own server still needs
 * to allow our origin; `directOriginHeaderLine()` spells that out.
 */
export function resolveSourceTransportMode(
  value: unknown,
  sourceType?: string,
): SourceTransportMode {
  if (value === 'browser-direct') return 'browser-direct';
  if (value === 'server-proxy') return 'server-proxy';
  if (!hasBackend() && supportsBrowserDirectTransport(sourceType ?? '')) return 'browser-direct';
  return 'server-proxy';
}

/** The origin a user has to allow on their own server for a direct connection. */
export function directConnectionOrigin(): string {
  return typeof window !== 'undefined' ? window.location.origin : '';
}

/** The exact header line to paste, so nobody has to guess the syntax. */
export function directOriginHeaderLine(): string {
  return `Access-Control-Allow-Origin: ${directConnectionOrigin()}`;
}

export function supportsBrowserDirectTransport(sourceType: string): boolean {
  return sourceCapability(sourceType)?.transport === 'browser-direct';
}

export function createSourceFetch(mode: SourceTransportMode | undefined): SourceFetch {
  return resolveSourceTransportMode(mode) === 'browser-direct'
    ? directSourceFetch
    : proxyFetch;
}

/**
 * Connect to a source from the user's browser. This intentionally permits
 * HTTPS only: an HTTPS PhotoLib page cannot reliably fetch an HTTP source,
 * and browser-specific local-network exceptions are not portable enough for
 * a persisted source configuration.
 */
export async function directSourceFetch(
  url: string,
  options?: SourceFetchOptions,
): Promise<Response> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new DirectSourceFetchError('invalid-url');
  }

  if (target.protocol !== 'https:') {
    throw new DirectSourceFetchError('https-required');
  }

  return fetch(target.toString(), {
    method: options?.method ?? 'GET',
    headers: options?.headers,
    body: options?.body as BodyInit | undefined,
    redirect: options?.redirect ?? 'follow',
    mode: 'cors',
    credentials: 'omit',
    signal: options?.signal,
  });
}
