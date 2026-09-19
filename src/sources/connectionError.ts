import {
  DirectSourceFetchError,
  directOriginHeaderLine,
  type SourceTransportMode,
} from '../platform/sourceTransport';

export type SourceConnectionErrorCode =
  | 'backend-auth-required'
  | 'backend-admin-required'
  | 'proxy-target-blocked'
  | 'proxy-upstream-failed'
  | 'proxy-response-too-large'
  | 'proxy-unreachable'
  | 'browser-network-error'
  | 'browser-cors-blocked'
  | 'browser-invalid-url'
  | 'browser-https-required'
  | 'source-invalid-response'
  | 'source-http-error';

interface SourceConnectionErrorOptions {
  sourceName: string;
  status?: number;
  /** The header line the user has to add on their own server, for CORS failures. */
  headerLine?: string;
}

/**
 * A safe, structured connection failure that can be localized by the UI.
 *
 * The raw response body and thrown network error are intentionally not kept:
 * upstream services and browsers may include credentials, hostnames, or other
 * implementation details in those values.
 */
export class SourceConnectionError extends Error {
  readonly name = 'SourceConnectionError';
  readonly code: SourceConnectionErrorCode;
  readonly sourceName: string;
  readonly status?: number;
  readonly headerLine?: string;

  constructor(
    code: SourceConnectionErrorCode,
    { sourceName, status, headerLine }: SourceConnectionErrorOptions,
  ) {
    super(code);
    this.code = code;
    this.sourceName = sourceName;
    this.status = status;
    this.headerLine = headerLine;
  }
}

const BACKEND_AUTH_ERRORS = new Set([
  'Unauthorized',
  'Invalid or expired token',
  'Token revoked',
]);

// Keep this list in sync with NetworkTargetError messages emitted by the
// backend proxy. Exact matching prevents an arbitrary upstream 403 body from
// being displayed as a PhotoLib security decision in normal cases.
const NETWORK_TARGET_ERRORS = new Set([
  'Invalid URL',
  'Only http(s) targets are allowed',
  'Credentials must be sent as headers, not in the URL',
  'Target host is not allowed',
  'Target IP address is not allowed',
  'Target hostname did not resolve',
  'Target hostname resolves to a disallowed address',
]);

/** Classify an unsuccessful source response without exposing its body. */
export async function classifySourceConnectionResponse(
  response: Response,
  transport: SourceTransportMode,
  sourceName: string,
): Promise<SourceConnectionError> {
  if (transport === 'server-proxy') {
    const backendError = await readExactBackendError(response);

    if (response.status === 401 && backendError && BACKEND_AUTH_ERRORS.has(backendError)) {
      return create('backend-auth-required');
    }
    if (response.status === 403 && backendError === 'Administrator access required') {
      return create('backend-admin-required');
    }
    if (response.status === 403 && backendError && NETWORK_TARGET_ERRORS.has(backendError)) {
      return create('proxy-target-blocked');
    }
    if (response.status === 502 && backendError === 'Upstream request failed') {
      return create('proxy-upstream-failed');
    }
    if (response.status === 502 && backendError === 'Upstream response is too large') {
      return create('proxy-response-too-large');
    }
  }

  return create('source-http-error');

  function create(code: SourceConnectionErrorCode): SourceConnectionError {
    return new SourceConnectionError(code, { sourceName, status: response.status });
  }
}

/** Classify failures where no HTTP response was available. */
export function classifySourceConnectionFailure(
  cause: unknown,
  transport: SourceTransportMode,
  sourceName: string,
): SourceConnectionError {
  if (transport === 'browser-direct') {
    if (cause instanceof DirectSourceFetchError) {
      return new SourceConnectionError(
        cause.code === 'invalid-url' ? 'browser-invalid-url' : 'browser-https-required',
        { sourceName },
      );
    }
    // Browsers deliberately do not reveal whether fetch failed because of
    // DNS, TLS, CORS, local-network permission, or an offline target — so we
    // cannot detect CORS, only rank it. On a direct connection it is by far
    // the most common cause, and the only one the user fixes on their own
    // server, so the message leads with the header line instead of listing
    // six candidates (§P4).
    return new SourceConnectionError('browser-cors-blocked', {
      sourceName,
      headerLine: directOriginHeaderLine(),
    });
  }

  // A server-proxy request that throws did not produce a proxy HTTP response;
  // this normally means the PhotoLib backend itself could not be reached.
  return new SourceConnectionError('proxy-unreachable', { sourceName });
}

function readExactBackendError(response: Response): Promise<string | null> {
  return response.clone().json().then((payload: unknown) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const record = payload as Record<string, unknown>;
    if (Object.keys(record).length !== 1 || typeof record.error !== 'string') return null;
    return record.error;
  }).catch(() => null);
}
