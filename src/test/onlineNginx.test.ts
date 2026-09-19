import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const conf = readFileSync(path.join(ROOT, 'docker/online/nginx.conf'), 'utf8');

/** The body of the first `location <pattern> { ... }` block, nested blocks included. */
function locationBlock(pattern: string): string {
  const start = conf.indexOf(`location ${pattern} {`);
  if (start < 0) throw new Error(`nginx.conf has no location ${pattern}`);
  let depth = 0;
  for (let i = conf.indexOf('{', start); i < conf.length; i++) {
    if (conf[i] === '{') depth++;
    if (conf[i] === '}' && --depth === 0) return conf.slice(start, i + 1);
  }
  throw new Error(`location ${pattern} is not closed`);
}

// The bundle ships ES modules as .mjs (libheif for HEIC, onnxruntime for the
// AI denoise). nginx's own mime.types does not know the extension and serves
// application/octet-stream, which the browser refuses for a module script -
// both features then failed in the online build without a word.
describe('online build nginx', () => {
  it('serves .mjs assets as JavaScript', () => {
    const mjs = locationBlock('~ \\.mjs$');
    expect(locationBlock('/assets/')).toContain(mjs);
    expect(mjs).toMatch(/types\s*\{\s*\}/);
    expect(mjs).toMatch(/default_type\s+(text|application)\/javascript;/);
  });

  it('keeps the security headers and the cache policy on .mjs assets', () => {
    // add_header does not inherit into a location that sets its own.
    const mjs = locationBlock('~ \\.mjs$');
    expect(mjs).toContain('include /etc/nginx/conf.d/security-headers.conf;');
    expect(mjs).toContain('add_header Cache-Control "public, max-age=31536000, immutable" always;');
  });

  it('compresses the JavaScript type the .mjs assets are sent with', () => {
    expect(conf).toMatch(/gzip_types[^;]*\btext\/javascript\b/);
  });
});
