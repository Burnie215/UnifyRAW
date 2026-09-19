import { describe, it, expect } from 'vitest';
import {
  CORS_SERVER_KINDS, corsRequirement, corsSnippet, type CorsServerKind,
} from './corsSnippets';

const ORIGIN = 'https://app.unifyraw.com';
const KINDS = CORS_SERVER_KINDS.map((k) => k.kind);

describe('corsRequirement', () => {
  it('asks for the header Immich authenticates with', () => {
    expect(corsRequirement('immich').headers).toContain('X-Api-Key');
    expect(corsRequirement('immich-v3').headers).toContain('X-Api-Key');
  });

  it('lets range requests be read back, or thumbnails stall', () => {
    expect(corsRequirement('immich').expose).toContain('Content-Range');
  });

  it("includes WebDAV's own verbs, which the usual four would miss", () => {
    const webdav = corsRequirement('webdav');
    expect(webdav.methods).toContain('PROPFIND');
    expect(webdav.methods).toContain('MKCOL');
    expect(webdav.headers).toContain('Depth');
  });

  it('falls back to something usable for an unknown source', () => {
    const generic = corsRequirement('something-else');
    expect(generic.methods).toContain('GET');
    expect(generic.methods).toContain('OPTIONS');
  });
});

describe('corsSnippet', () => {
  it.each(KINDS)('%s names the exact origin, never a wildcard', (kind) => {
    const out = corsSnippet(kind as CorsServerKind, 'immich', ORIGIN);
    expect(out).toContain(ORIGIN);
    expect(out).not.toContain('Allow-Origin "*"');
    expect(out).not.toContain('AllowOriginList=*');
  });

  it.each(KINDS)('%s carries every method and header the source needs', (kind) => {
    const out = corsSnippet(kind as CorsServerKind, 'webdav', ORIGIN);
    for (const m of corsRequirement('webdav').methods) expect(out).toContain(m);
    for (const h of corsRequirement('webdav').headers) expect(out).toContain(h);
  });

  it('answers the preflight before auth where the server needs telling', () => {
    expect(corsSnippet('nginx', 'immich', ORIGIN)).toContain('return 204');
    expect(corsSnippet('caddy', 'immich', ORIGIN)).toContain('respond @preflight 204');
  });

  it('omits the expose line when a source has nothing to expose', () => {
    expect(corsSnippet('nginx', 'lychee', ORIGIN)).not.toContain('Expose-Headers');
    expect(corsSnippet('nginx', 'immich', ORIGIN)).toContain('Expose-Headers');
  });

  it('stays usable when the origin cannot be read from the page', () => {
    expect(corsSnippet('nginx', 'immich', '')).toContain('https://app.unifyraw.com');
  });
});
