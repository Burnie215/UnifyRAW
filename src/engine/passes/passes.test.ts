import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * A shader pass without a graph consumer is dead code that still looks like
 * part of the renderer. The classic pipeline that ran every pass is gone
 * (tag attic/pre-deadcode-2026-09), and four passes only it used went with it;
 * this keeps the next one from lying around unnoticed.
 */
const PASSES = dirname(fileURLToPath(import.meta.url));
const barrel = readFileSync(join(PASSES, 'index.ts'), 'utf8');
const passKinds = readFileSync(join(PASSES, '..', 'graph', 'passKinds.ts'), 'utf8');

/** export name -> module file (without .ts) */
const barrelExports = new Map(
  [...barrel.matchAll(/export\s*\{\s*(\w+)\s*\}\s*from\s*'\.\/(\w+)'/g)].map((m) => [m[1], m[2]]),
);

function namesIn(list: string): string[] {
  return list.split(',').map((s) => s.replace(/^\s*type\s+/, '').trim()).filter(Boolean);
}

const importedFromBarrel = [...passKinds.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\.\/passes'/g)]
  .flatMap((m) => namesIn(m[1]));
const importedDirectly = [...passKinds.matchAll(/from\s*'\.\.\/passes\/(\w+)'/g)].map((m) => m[1]);

describe('shader passes', () => {
  it('exports from the barrel only passes that passKinds imports', () => {
    expect(barrelExports.size).toBeGreaterThan(10);
    expect([...barrelExports.keys()].filter((name) => !importedFromBarrel.includes(name))).toEqual([]);
  });

  it('has a graph consumer for every pass file', () => {
    const reached = new Set([
      ...importedDirectly,
      ...importedFromBarrel.map((name) => barrelExports.get(name)).filter((m): m is string => !!m),
    ]);
    const files = readdirSync(PASSES)
      .filter((f) => /Pass\.ts$/.test(f) && f !== 'RenderPass.ts')
      .map((f) => f.slice(0, -'.ts'.length));
    expect(files.length).toBeGreaterThan(10);
    expect(files.filter((m) => !reached.has(m))).toEqual([]);
  });
});
