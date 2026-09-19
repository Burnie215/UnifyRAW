/**
 * Which caller-supplied headers this server may send to a user-configured
 * upstream. Both routes that forward such headers use this one rule:
 * `/api/proxy` (JSON and binary) and `/api/raw/smart-preview-from-url`.
 *
 * They used to disagree. The proxy allowed the whole `x-` namespace, so
 * X-Forwarded-For, X-Real-IP and this server's own X-Proxy-* headers reached
 * a third-party server, while the RAW route already refused exactly those.
 * The refusing rule wins: the address of the person using the app is not the
 * upstream's business, and a forwarded chain the upstream trusts is a way to
 * make it see a foreign client address.
 */
const FORWARDABLE_PREFIXES = [
  'authorization',
  'content-type',
  'accept',
  'x-',
  'depth',
  'destination',
  'overwrite',
  'dropbox-api-arg',
];

/** Hop-by-hop headers, credentials for the hop itself, and the client address. */
const NEVER_FORWARDED = [
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'x-real-ip',
];

/** X-Forwarded-*: the client address. X-Proxy-*: this server's own routing. */
const NEVER_FORWARDED_PREFIXES = ['x-forwarded-', 'x-proxy-'];

export function isForwardableUpstreamHeader(name: string, value: string): boolean {
  if (name.length > 128 || value.length > 16_384) return false;
  const normalized = name.toLowerCase();
  if (NEVER_FORWARDED.includes(normalized)) return false;
  if (NEVER_FORWARDED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return false;
  return FORWARDABLE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
