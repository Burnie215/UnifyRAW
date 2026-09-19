import type { RequestHandler } from 'express';
import helmet from 'helmet';

/**
 * The self-hosted backend serves the same bundle the online build serves
 * from nginx, so it gets the same policy. csp.test.ts holds this equal to
 * docker/online/security-headers.conf; a change to one side fails until the
 * other follows.
 */
export const SELFHOST_CSP_DIRECTIVES: Readonly<Record<string, readonly string[]>> = {
  'default-src': ["'self'"],
  'script-src': ["'self'", "'wasm-unsafe-eval'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'blob:', 'data:'],
  'media-src': ["'self'", 'blob:'],
  'font-src': ["'self'", 'data:'],
  'worker-src': ["'self'", 'blob:'],
  // blob: because the app fetch()es object URLs it created itself: preset
  // thumbnails, graph node previews, decoded RAW previews. Without it every
  // preset tile showed the unedited photo (measured 2026-09-11).
  'connect-src': ["'self'", 'https:', 'blob:'],
  'manifest-src': ["'self'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
  'frame-ancestors': ["'none'"],
  'object-src': ["'none'"],
};

export const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()';

export function selfhostSecurityHeaders(): RequestHandler[] {
  return [
    // useDefaults: false keeps helmet's upgrade-insecure-requests out; a
    // self-hosted install on http://localhost would otherwise lose its assets.
    //
    // hsts: false, because HSTS belongs to whoever terminates TLS - Caddy in
    // docker-compose.yml, the user's own proxy otherwise. helmet sends it by
    // default for a year with includeSubDomains. Under a host name with Caddy's
    // local root installed, the browser would then refuse any other certificate
    // for that year, without the option to click through: lose the caddy-data
    // volume, and every device is locked out of its own photo library.
    helmet({
      hsts: false,
      contentSecurityPolicy: { useDefaults: false, directives: SELFHOST_CSP_DIRECTIVES },
    }),
    (_req, res, next) => {
      res.set('Permissions-Policy', PERMISSIONS_POLICY);
      next();
    },
  ];
}
