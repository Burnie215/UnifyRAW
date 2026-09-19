import type { RequestHandler } from 'express';

/** Words that mean "no proxy in front of me". They all disable it. */
const OFF_WORDS = new Set(['', '0', 'false', 'off', 'no']);

/**
 * Words that mean "yes, there is a proxy" — but not how many. Express reads a
 * boolean true as "trust the whole X-Forwarded-For chain", which lets any
 * client claim any address and would quietly break the per-address login
 * limit. Measured with express 5.2.1: app.set('trust proxy', 'true') throws
 * `invalid IP address: true` from deep inside proxy-addr, so the string was
 * never usable either. Refuse it here, where the message can say what to write.
 */
const AMBIGUOUS_ON_WORDS = new Set(['true', 'on', 'yes', 'enabled']);

/**
 * TRUST_PROXY as Express understands it. An integer is the number of reverse
 * proxies in front of Node (1 = Traefik, 2 = Cloudflare tunnel + Traefik);
 * '', '0', 'false', 'off' and 'no' switch it off; anything else ('loopback', a
 * CIDR list) goes to Express unchanged. Throws for a boolean-sounding "on".
 */
export function parseTrustProxy(value: string | undefined): boolean | number | string {
  const trimmed = (value ?? '').trim();
  const normalized = trimmed.toLowerCase();
  if (OFF_WORDS.has(normalized)) return false;
  if (AMBIGUOUS_ON_WORDS.has(normalized)) {
    throw new Error(
      `TRUST_PROXY=${trimmed} does not say how many reverse proxies are in front of this `
      + 'server, and trusting all of them would let any client forge its address. Set the hop '
      + 'count instead: 1 for a single Traefik or nginx, 2 for a Cloudflare tunnel plus '
      + 'Traefik, 0 for direct connections.',
    );
  }
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

/**
 * Without trust proxy every client behind a proxy has the proxy's address, so
 * all of them share one login rate limit. Says so once instead of per request.
 */
export function warnForwardedWithoutTrustProxy(): RequestHandler {
  let warned = false;
  return (req, _res, next) => {
    if (!warned && req.headers['x-forwarded-for'] !== undefined && !req.app.get('trust proxy')) {
      warned = true;
      console.warn(
        '[trust-proxy] Requests carry X-Forwarded-For but TRUST_PROXY is off: every client '
        + 'shares the address of the proxy and with it one login rate limit. Set TRUST_PROXY '
        + 'to the number of reverse proxies in front of this server.',
      );
    }
    next();
  };
}
