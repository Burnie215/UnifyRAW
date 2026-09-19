import { readdirSync, readFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * The lower layers must not reach up into React code. Type-only imports count
 * too: they cost nothing at runtime, but the direction is the same rule, and
 * the one runtime case (useWebGLRenderer -> components/SoftProofing) started
 * as exactly such a convenience import.
 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOWER = ['engine', 'export', 'storage', 'sources', 'image', 'data', 'platform', 'cache'];
const UPPER = new Set(['hooks', 'components', 'ui', 'contexts']);

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function upwardImports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(SPECIFIER)]
    .map((match) => match[1])
    .filter((spec) => spec.startsWith('.'))
    .filter((spec) => {
      const top = relative(SRC, resolve(dirname(file), spec)).split(/[\\/]/)[0];
      return UPPER.has(top);
    })
    .map((spec) => `${relative(SRC, file)} -> ${spec}`);
}

function graphBarrelBypasses(file: string): string[] {
  if (/\.test\.tsx?$/.test(file)) return [];
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(SPECIFIER)]
    .map((match) => match[1])
    .filter((spec) => /\/engine\/graph\//.test(spec))
    .map((spec) => `${relative(SRC, file)} -> ${spec}`);
}

describe('import direction', () => {
  it('keeps engine, export, storage, sources, image, data, platform and cache free of hooks, components, ui and contexts', () => {
    const files = LOWER.flatMap((layer) => sourceFiles(join(SRC, layer)));
    expect(files.length).toBeGreaterThan(100);
    expect(files.flatMap(upwardImports)).toEqual([]);
  });

  it('keeps components and hooks behind the graph barrel', () => {
    const files = ['components', 'hooks'].flatMap((layer) => sourceFiles(join(SRC, layer)));
    expect(files.flatMap(graphBarrelBypasses)).toEqual([]);
  });
});
