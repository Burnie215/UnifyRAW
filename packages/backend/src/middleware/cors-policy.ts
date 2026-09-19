import type { CorsOptions } from 'cors';

/** Exact browser origins allowed to call the API cross-origin. Empty is safest. */
export function parseAllowedCorsOrigins(
  raw = process.env.CORS_ALLOWED_ORIGINS ?? '',
): ReadonlySet<string> {
  const origins = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (origins.includes('*')) {
    throw new Error('CORS_ALLOWED_ORIGINS must list exact origins; wildcard "*" is not allowed');
  }
  return new Set(origins.map(stripTrailingSlash));
}

export function createCorsOptions(
  allowedOrigins = parseAllowedCorsOrigins(),
): CorsOptions {
  if (allowedOrigins.size === 0) {
    // No CORS response headers. Same-origin browser requests continue to work.
    return { origin: false };
  }

  return {
    origin(origin, callback) {
      // Requests without Origin are server-to-server, CLI, or same-origin
      // navigations and do not participate in browser CORS enforcement.
      if (!origin || allowedOrigins.has(stripTrailingSlash(origin))) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Authorization', 'Content-Type', 'Accept-Language',
      'X-Proxy-Url', 'X-Proxy-Method', 'X-Proxy-Headers',
    ],
    maxAge: 600,
  };
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
