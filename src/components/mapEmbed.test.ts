/**
 * The map view was deactivated on 2026-09-12 (F005): the embedded
 * openstreetmap.org frame handed the visitor's IP address and the bounding box
 * of every geotagged photo to a third party without being asked, while both
 * privacy texts promise that nothing is transmitted. The embed must not come
 * back through a copied component or a re-enabled route, and the CSP must not
 * keep a permission open for it.
 *
 * The metadata link is asserted alongside it on purpose: it is a click the
 * user makes, not a transfer the app performs, and it stays. Without that
 * assertion this file would also pass if every trace of OpenStreetMap were
 * deleted.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EMBED_URL = 'openstreetmap.org/export/embed';

/** Test files are skipped so this file's own needle is not a hit. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function read(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

describe('the OpenStreetMap embed', () => {
  it('is rendered by no source file', () => {
    const offenders = sourceFiles(path.join(REPO_ROOT, 'src'))
      .filter((file) => readFileSync(file, 'utf8').includes(EMBED_URL))
      .map((file) => path.relative(REPO_ROOT, file));
    expect(offenders).toEqual([]);
  });

  it('has no route left to reach it', () => {
    const viewMode = read('src/types.ts').match(/^export type ViewMode = .*$/m)?.[0];
    expect(viewMode, 'src/types.ts declares no ViewMode').toBeDefined();
    expect(viewMode).not.toContain("'map'");
  });

  it('is not allowed by either copy of the policy', () => {
    expect(read('docker/online/security-headers.conf')).not.toContain('frame-src');
    expect(read('packages/backend/src/security/csp.ts')).not.toContain('frame-src');
  });
});

describe('the in-app privacy tab', () => {
  it('no longer describes a map view that cannot load anything', () => {
    expect(read('src/components/AboutDialog.tsx')).not.toContain("section('Map')");
    for (const lang of ['de', 'en']) {
      expect(read(`src/i18n/locales/${lang}/shell.json`)).not.toContain('privacyMap');
    }
  });

  it('numbers its sections without a gap', () => {
    for (const lang of ['de', 'en']) {
      const shell = JSON.parse(read(`src/i18n/locales/${lang}/shell.json`)) as {
        about: Record<string, string>;
      };
      const numbers = Object.entries(shell.about)
        .filter(([key]) => /^privacy.*Title$/.test(key))
        .map(([, value]) => Number(value.match(/^(\d+)\./)?.[1]))
        .filter((n) => !Number.isNaN(n));
      expect(numbers).toEqual(numbers.map((_, i) => i + 1));
    }
  });
});

describe('the metadata panel', () => {
  it('still links the coordinates to openstreetmap.org in a new window', () => {
    const panel = read('src/components/MetadataPanel.tsx');
    expect(panel).toContain('https://www.openstreetmap.org/?mlat=');
    expect(panel).toContain('target="_blank"');
  });
});
