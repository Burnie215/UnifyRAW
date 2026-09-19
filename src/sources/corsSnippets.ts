/**
 * corsSnippets — ready-made CORS configuration for the user's own server.
 *
 * The browser, not this application, requires it: a page on our origin may
 * not read a response from someone else's host unless that host says so.
 * Nothing on the client can waive that, so the only thing we can improve is
 * how much guesswork it costs the user — and a bare header line costs a lot,
 * because a working configuration also needs the right methods, the right
 * request headers, and a preflight that answers before authentication.
 *
 * The values below are not guessed. They are the ones running against
 * Immich 2.x/3.x, Lychee and Nextcloud/WebDAV on the project's own test
 * instances, lifted from their reverse-proxy configuration.
 */

import type { SourceType } from './capabilities';

export type CorsServerKind = 'nginx' | 'caddy' | 'traefik' | 'apache';

export interface CorsRequirement {
  methods: string[];
  headers: string[];
  /** Response headers the browser must be allowed to read (range requests). */
  expose: string[];
}

const IMMICH: CorsRequirement = {
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  headers: ['Accept', 'Content-Type', 'Range', 'X-Api-Key', 'X-Immich-Checksum'],
  expose: ['Content-Length', 'Content-Range'],
};

const LYCHEE: CorsRequirement = {
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  headers: ['Accept', 'Authorization', 'Content-Type'],
  expose: [],
};

const WEBDAV: CorsRequirement = {
  // PROPFIND and MKCOL are WebDAV's own verbs; a proxy that only lists the
  // usual four will pass the preflight and then fail on the first listing.
  methods: ['GET', 'PROPFIND', 'PUT', 'MKCOL', 'OPTIONS'],
  headers: ['Accept', 'Authorization', 'Content-Type', 'Depth'],
  expose: [],
};

const GENERIC: CorsRequirement = {
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  headers: ['Accept', 'Authorization', 'Content-Type'],
  expose: [],
};

export function corsRequirement(sourceType: SourceType | string): CorsRequirement {
  switch (sourceType) {
    case 'immich':
    case 'immich-v3': return IMMICH;
    case 'lychee': return LYCHEE;
    case 'webdav': return WEBDAV;
    default: return GENERIC;
  }
}

export const CORS_SERVER_KINDS: ReadonlyArray<{ kind: CorsServerKind; label: string }> = [
  { kind: 'nginx', label: 'nginx' },
  { kind: 'caddy', label: 'Caddy' },
  { kind: 'traefik', label: 'Traefik' },
  { kind: 'apache', label: 'Apache' },
];

/**
 * `origin` is inserted verbatim rather than as a wildcard. `*` would work for
 * the read, but it is incompatible with credentialed requests and it opens the
 * server to every page the user ever visits — the opposite of why the browser
 * asks in the first place.
 */
export function corsSnippet(
  kind: CorsServerKind,
  sourceType: SourceType | string,
  origin: string,
): string {
  const req = corsRequirement(sourceType);
  const methods = req.methods.join(', ');
  const headers = req.headers.join(', ');
  const o = origin || 'https://app.unifyraw.com';

  switch (kind) {
    case 'nginx':
      return [
        'location / {',
        `  add_header Access-Control-Allow-Origin "${o}" always;`,
        `  add_header Access-Control-Allow-Methods "${methods}" always;`,
        `  add_header Access-Control-Allow-Headers "${headers}" always;`,
        ...(req.expose.length
          ? [`  add_header Access-Control-Expose-Headers "${req.expose.join(', ')}" always;`]
          : []),
        '  add_header Vary "Origin" always;',
        '',
        '  # Preflight must be answered before any auth check.',
        '  if ($request_method = OPTIONS) { return 204; }',
        '',
        '  proxy_pass http://127.0.0.1:2283;   # your server',
        '}',
      ].join('\n');

    case 'caddy':
      return [
        'your-server.example.com {',
        '  header {',
        `    Access-Control-Allow-Origin "${o}"`,
        `    Access-Control-Allow-Methods "${methods}"`,
        `    Access-Control-Allow-Headers "${headers}"`,
        ...(req.expose.length
          ? [`    Access-Control-Expose-Headers "${req.expose.join(', ')}"`]
          : []),
        '    Vary Origin',
        '  }',
        '',
        '  @preflight method OPTIONS',
        '  respond @preflight 204',
        '',
        '  reverse_proxy 127.0.0.1:2283   # your server',
        '}',
      ].join('\n');

    case 'traefik':
      return [
        '# docker-compose labels on the source container',
        'labels:',
        '  - "traefik.http.middlewares.photo-cors.headers.accessControlAllowOriginList='
          + `${o}"`,
        '  - "traefik.http.middlewares.photo-cors.headers.accessControlAllowMethods='
          + `${req.methods.join(',')}"`,
        '  - "traefik.http.middlewares.photo-cors.headers.accessControlAllowHeaders='
          + `${req.headers.join(',')}"`,
        ...(req.expose.length
          ? ['  - "traefik.http.middlewares.photo-cors.headers.accessControlExposeHeaders='
              + `${req.expose.join(',')}"`]
          : []),
        '  - "traefik.http.middlewares.photo-cors.headers.addVaryHeader=true"',
        '  - "traefik.http.routers.<your-router>.middlewares=photo-cors"',
      ].join('\n');

    case 'apache':
      return [
        '<IfModule mod_headers.c>',
        `  Header always set Access-Control-Allow-Origin "${o}"`,
        `  Header always set Access-Control-Allow-Methods "${methods}"`,
        `  Header always set Access-Control-Allow-Headers "${headers}"`,
        ...(req.expose.length
          ? [`  Header always set Access-Control-Expose-Headers "${req.expose.join(', ')}"`]
          : []),
        '  Header always append Vary Origin',
        '</IfModule>',
        '',
        '# Preflight must be answered before any auth check.',
        'RewriteEngine On',
        'RewriteCond %{REQUEST_METHOD} OPTIONS',
        'RewriteRule ^(.*)$ $1 [R=204,L]',
      ].join('\n');
  }
}
