import { readdirSync, readFileSync } from 'fs';
import { describe, it, expect } from 'vitest';
import { BUNDLED_COMPONENTS, LICENCE_TEXT_URLS, bundledLicences } from './thirdParty';

/**
 * Packages that are declared dependencies but never reach a browser, with the
 * reason. Anything else in `dependencies` has to appear in the notice list —
 * that is what keeps this from drifting the way the hand-written list did.
 */
const NOT_IN_WEB_BUNDLE: Record<string, string> = {
  '@capacitor/core': 'native shell only, no import in src/',
  '@capacitor/android': 'native shell only',
  '@capacitor/ios': 'native shell only',
  '@capacitor/filesystem': 'native shell only',
  '@capacitor/preferences': 'native shell only',
  '@capacitor/share': 'native shell only',
};

/** Package name -> the name shown in the dialog, where they differ. */
const DISPLAY_NAME: Record<string, string> = {
  react: 'React',
  'react-dom': 'React DOM',
  utif: 'UTIF.js',
};

/**
 * Our own workspace packages, read from their manifests rather than named here.
 * The shared package is being renamed from @photolib to @unifyraw; a hardcoded
 * name made this test pass on one side of the rename and fail on the other.
 */
function workspacePackageNames(): Set<string> {
  const names = new Set<string>();
  for (const dir of readdirSync('packages')) {
    try {
      names.add(JSON.parse(readFileSync(`packages/${dir}/package.json`, 'utf8')).name);
    } catch { /* not a package directory */ }
  }
  return names;
}

function declaredDependencies(): string[] {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  return Object.keys(pkg.dependencies ?? {});
}

describe('third-party notices', () => {
  it('names every dependency that reaches the browser', () => {
    const listed = new Set(BUNDLED_COMPONENTS.map((c) => c.name));
    const workspace = workspacePackageNames();
    const missing = declaredDependencies()
      .filter((d) => !workspace.has(d))
      .filter((d) => !(d in NOT_IN_WEB_BUNDLE))
      .filter((d) => !listed.has(DISPLAY_NAME[d] ?? d));
    expect(missing).toEqual([]);
  });

  it('does not list build tooling, which never reaches a browser', () => {
    const names = BUNDLED_COMPONENTS.map((c) => c.name.toLowerCase());
    for (const tool of ['vite', 'typescript', 'rollup', 'vitest']) {
      expect(names).not.toContain(tool);
    }
  });

  it('spells out the obligation where a licence asks for more than a notice', () => {
    for (const c of BUNDLED_COMPONENTS) {
      if (c.licence === 'LGPL-3.0' || c.name === 'libraw-wasm') {
        expect(c.hasNote, `${c.name} needs a source note`).toBe(true);
      }
    }
  });

  it('has translated prose for every entry, in both languages', () => {
    for (const loc of ['de', 'en']) {
      const about = JSON.parse(
        readFileSync(`src/i18n/locales/${loc}/shell.json`, 'utf8'),
      ).about as Record<string, string>;
      for (const c of BUNDLED_COMPONENTS) {
        expect(about[`licPurpose_${c.id}`], `${loc}: purpose for ${c.id}`).toBeTruthy();
        if (c.hasNote) {
          expect(about[`licNote_${c.id}`], `${loc}: note for ${c.id}`).toBeTruthy();
        }
      }
    }
  });

  it('keeps ids unique, or two entries would share one translation', () => {
    const ids = BUNDLED_COMPONENTS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('carries the copyleft component the old hand-written list omitted', () => {
    const heif = BUNDLED_COMPONENTS.find((c) => c.name === 'libheif-js');
    expect(heif?.licence).toBe('LGPL-3.0');
    expect(heif?.url).toContain('github.com');
  });

  it('points libraw-wasm at its real upstream, not the wrong fork', () => {
    const libraw = BUNDLED_COMPONENTS.find((c) => c.name === 'libraw-wasm');
    expect(libraw?.url).toContain('ybouane');
  });

  it('gives every entry something a reader can act on', () => {
    for (const c of BUNDLED_COMPONENTS) {
      expect(c.url, `${c.name} without url`).toMatch(/^https:\/\//);
      expect(c.id, `${c.name} without id`).toBeTruthy();
      expect(c.version, `${c.name} without version`).toBeTruthy();
    }
  });

  it('can point at the full text of every licence it uses', () => {
    for (const id of bundledLicences()) {
      expect(LICENCE_TEXT_URLS[id], `no text url for ${id}`).toMatch(/^https:\/\//);
    }
  });
});
