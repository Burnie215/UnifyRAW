import dns from 'node:dns';
import http, { type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

export type NetworkAddressKind = 'public' | 'private' | 'forbidden';

export interface NetworkTargetPolicy {
  allowPrivate: boolean;
  /**
   * Exact, canonical DNS hostnames that may resolve to RFC1918 or IPv6 ULA
   * addresses. IP literals, wildcards and forbidden address classes are never
   * enabled by this list.
   */
  allowedPrivateHosts?: ReadonlySet<string>;
}

export interface NetworkRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | Uint8Array;
  signal?: AbortSignal;
  timeoutMs: number;
  policy: NetworkTargetPolicy;
}

export interface BufferedNetworkResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export class NetworkTargetError extends Error {}
export class NetworkResponseTooLargeError extends Error {}

const BLOCKED_HOSTNAMES = new Set([
  'instance-data',
  'metadata.google.internal',
  'metadata.goog',
  'metadata.azure.internal',
]);

/**
 * Parse a comma-separated private-target allowlist from configuration.
 *
 * Entries are exact hostnames only. Invalid entries fail closed during
 * startup instead of being silently ignored, while duplicate/case variants
 * collapse to one canonical name.
 */
export function parsePrivateHostAllowlist(rawValue: string | undefined): ReadonlySet<string> {
  const hosts = new Set<string>();
  if (!rawValue?.trim()) return hosts;

  for (const entry of rawValue.split(',')) {
    const value = entry.trim();
    if (!value) continue;

    const hostname = parseConfiguredHostname(value);
    hosts.add(hostname);
  }

  return hosts;
}

/** Validate syntax and hostname before DNS. Redirects are intentionally absent. */
export function parseNetworkTarget(rawUrl: string, policy: NetworkTargetPolicy): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new NetworkTargetError('Invalid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NetworkTargetError('Only http(s) targets are allowed');
  }
  if (url.username || url.password) {
    throw new NetworkTargetError('Credentials must be sent as headers, not in the URL');
  }

  const hostname = normalizeHostname(url.hostname);
  if (isBlockedHostname(hostname)) {
    throw new NetworkTargetError('Target host is not allowed');
  }

  if (isIP(hostname) && !isAddressAllowed(hostname, policy)) {
    throw new NetworkTargetError('Target IP address is not allowed');
  }
  return url;
}

/**
 * Open an HTTP(S) response with DNS validation performed by the same lookup
 * callback used for the actual connection. This closes the hostname and DNS
 * rebinding gap caused by validating first and resolving again in fetch().
 */
export function openNetworkResponse(
  rawUrl: string,
  options: NetworkRequestOptions,
): Promise<IncomingMessage> {
  const url = parseNetworkTarget(rawUrl, options.policy);
  const client = url.protocol === 'https:' ? https : http;

  return new Promise<IncomingMessage>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(abortReason(options.signal));
      return;
    }

    let response: IncomingMessage | undefined;
    const removeAbortListener = () => {
      options.signal?.removeEventListener('abort', abortUpstream);
    };
    const abortUpstream = () => {
      const error = abortReason(options.signal);
      response?.destroy(error);
      request.destroy(error);
    };
    const request = client.request(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      lookup: createValidatedLookup(options.policy),
    }, (upstreamResponse) => {
      response = upstreamResponse;
      upstreamResponse.once('close', removeAbortListener);
      resolve(upstreamResponse);
    });

    request.setTimeout(options.timeoutMs, () => {
      request.destroy(new Error(`Upstream request timed out after ${options.timeoutMs} ms`));
    });
    request.on('error', (error) => {
      if (!response) removeAbortListener();
      reject(error);
    });
    options.signal?.addEventListener('abort', abortUpstream, { once: true });
    request.end(options.body);
  });
}

export async function requestNetworkBuffer(
  rawUrl: string,
  options: NetworkRequestOptions & { maxResponseBytes: number },
): Promise<BufferedNetworkResponse> {
  const response = await openNetworkResponse(rawUrl, options);
  const declaredLength = parseContentLength(response.headers['content-length']);
  if (declaredLength !== null && declaredLength > options.maxResponseBytes) {
    response.destroy();
    throw new NetworkResponseTooLargeError(
      `Upstream response exceeds ${options.maxResponseBytes} bytes`,
    );
  }

  const chunks: Buffer[] = [];
  let received = 0;
  try {
    for await (const chunk of response) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      received += buffer.length;
      if (received > options.maxResponseBytes) {
        response.destroy();
        throw new NetworkResponseTooLargeError(
          `Upstream response exceeds ${options.maxResponseBytes} bytes`,
        );
      }
      chunks.push(buffer);
    }
  } catch (error) {
    response.destroy();
    throw error;
  }

  return {
    status: response.statusCode ?? 502,
    headers: response.headers,
    body: Buffer.concat(chunks, received),
  };
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

export function isAddressAllowed(
  address: string,
  policy: NetworkTargetPolicy,
  targetHostname?: string,
): boolean {
  const kind = classifyNetworkAddress(address);
  if (kind === 'public') return true;
  if (kind !== 'private') return false;
  if (policy.allowPrivate) return true;
  if (!targetHostname || isIP(normalizeHostname(targetHostname))) return false;
  return policy.allowedPrivateHosts?.has(normalizeHostname(targetHostname)) === true;
}

/** All DNS answers must satisfy the policy; one unsafe answer rejects the target. */
export function areResolvedAddressesAllowed(
  addresses: readonly string[],
  policy: NetworkTargetPolicy,
  targetHostname: string,
): boolean {
  return addresses.length > 0
    && addresses.every((address) => isAddressAllowed(address, policy, targetHostname));
}

export function classifyNetworkAddress(address: string): NetworkAddressKind {
  const version = isIP(address);
  if (version === 4) return classifyIpv4(address);
  if (version === 6) return classifyIpv6(address);
  return 'forbidden';
}

function createValidatedLookup(policy: NetworkTargetPolicy): LookupFunction {
  return ((hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
    const family = typeof options === 'object' ? options.family : 0;
    dns.lookup(hostname, { all: true, verbatim: true, family }, (error, addresses) => {
      if (error) {
        callback(error);
        return;
      }
      if (addresses.length === 0) {
        callback(new NetworkTargetError('Target hostname did not resolve'));
        return;
      }
      if (!areResolvedAddressesAllowed(
        addresses.map(({ address }) => address),
        policy,
        hostname,
      )) {
        callback(new NetworkTargetError('Target hostname resolves to a disallowed address'));
        return;
      }

      if (typeof options === 'object' && options.all) {
        callback(null, addresses);
      } else {
        callback(null, addresses[0].address, addresses[0].family);
      }
    });
  }) as LookupFunction;
}

function classifyIpv4(address: string): NetworkAddressKind {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return 'forbidden';
  }
  const [a, b, c] = octets;

  if (
    a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
  ) return 'private';

  if (
    a === 0
    || a === 127
    || (a === 169 && b === 254)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224
  ) return 'forbidden';

  return 'public';
}

function classifyIpv6(address: string): NetworkAddressKind {
  const bytes = ipv6Bytes(address);
  if (!bytes) return 'forbidden';

  const isUnspecified = bytes.every((value) => value === 0);
  const isLoopback = bytes.slice(0, 15).every((value) => value === 0) && bytes[15] === 1;
  if (isUnspecified || isLoopback) return 'forbidden';

  const ipv4Mapped = bytes.slice(0, 10).every((value) => value === 0)
    && bytes[10] === 0xff
    && bytes[11] === 0xff;
  if (ipv4Mapped) {
    return classifyIpv4(bytes.slice(12).join('.'));
  }

  if ((bytes[0] & 0xfe) === 0xfc) return 'private'; // fc00::/7 ULA
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return 'forbidden'; // fe80::/10
  if (bytes[0] === 0xff) return 'forbidden'; // multicast
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) {
    return 'forbidden'; // documentation prefix
  }

  // Only globally routable unicast (2000::/3) is accepted as public.
  return (bytes[0] & 0xe0) === 0x20 ? 'public' : 'forbidden';
}

function ipv6Bytes(address: string): number[] | null {
  let normalized = normalizeHostname(address);
  const zoneIndex = normalized.indexOf('%');
  if (zoneIndex >= 0) normalized = normalized.slice(0, zoneIndex);

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = parseIpv6Section(halves[0]);
  const right = halves.length === 2 ? parseIpv6Section(halves[1]) : [];
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const words = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  if (words.length !== 8) return null;
  return words.flatMap((word) => [word >> 8, word & 0xff]);
}

function parseIpv6Section(section: string): number[] | null {
  if (!section) return [];
  const parts = section.split(':');
  const words: number[] = [];
  for (const part of parts) {
    if (part.includes('.')) {
      const octets = part.split('.').map(Number);
      if (octets.length !== 4 || octets.some((value) => value < 0 || value > 255)) return null;
      words.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    words.push(Number.parseInt(part, 16));
  }
  return words;
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function parseConfiguredHostname(value: string): string {
  if (
    /[/?#@:*\\\s]/u.test(value)
    || value.includes('[')
    || value.includes(']')
  ) {
    throw new NetworkTargetError(`Invalid private-target hostname: ${value}`);
  }

  let hostname: string;
  try {
    // WHATWG URL parsing canonicalizes Unicode hostnames to their ASCII form
    // and catches non-standard numeric IP representations.
    hostname = normalizeHostname(new URL(`http://${value}`).hostname);
  } catch {
    throw new NetworkTargetError(`Invalid private-target hostname: ${value}`);
  }

  if (
    !isValidDnsHostname(hostname)
    || isIP(hostname)
    || isBlockedHostname(hostname)
  ) {
    throw new NetworkTargetError(`Invalid private-target hostname: ${value}`);
  }

  return hostname;
}

function isValidDnsHostname(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > 253) return false;
  return hostname.split('.').every((label) => (
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)
  ));
}

function isBlockedHostname(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || BLOCKED_HOSTNAMES.has(hostname);
}

function parseContentLength(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
