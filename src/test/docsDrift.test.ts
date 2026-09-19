import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

// CLAUDE.md is the private onboarding file and is not part of the published
// source tree, so the guards that read it run only where it exists.
const hasClaude = existsSync(path.join(ROOT, 'CLAUDE.md'));
const claude = hasClaude ? read('CLAUDE.md') : '';
const readme = read('README.md');
const DEAD_PIPELINE_TAB = ['Pipeline', 'Tab'].join('');
const DEAD_LENS_LOOKUP = ['findLens', 'Profile'].join('');

describe('root documentation drift guards', () => {
  it('does not reintroduce dead names, stale architecture or volatile counts', () => {
    const rootDocs = `${claude}\n${readme}`;
    const forbidden: RegExp[] = [
      /\buseSyncClient\b/,
      /src\/db\/schema\.ts/,
      /\/api\/catalog\b/,
      /\bxxhash\b/i,
      /__PHOTOLIB_SELFHOSTED__\s*=\s*true/,
      /\b\d+\s+LOC\b/,
      /\(\d+\s+Files\)/,
      /\b\d+\s+Source-Provider(?:n|-Plugins)?\b/i,
      /\b(?:nur|only) string-Bodies\b/i,
      /2026-05-17/,
      /RenderPipeline \(HDR\)/,
      /\bacht Tabellen-Spezifikationen\b/i,
      /Docker build context[\s\S]{0,240}\b\d+\s+MB\b/i,
    ];

    for (const pattern of forbidden) expect(rootDocs, String(pattern)).not.toMatch(pattern);
  });

  it.skipIf(!hasClaude)('names the production architecture at its central entry points in CLAUDE.md', () => {
    for (const fact of [
      'src/sources/capabilities.ts',
      'src/sources/SourceManager.ts',
      'src/engine/graph/documentGraph.ts',
      'src/engine/graph/DefaultGraphBuilder.ts',
      'src/storage/SyncedStorage.ts',
      'src/contexts/StorageContext.tsx',
      'src/platform/config.ts',
      '/api/proxy',
      '/api/files',
      '/api/raw',
      '/api/libraries',
      '/api/sync',
      '/api/auth',
    ]) {
      expect(claude, fact).toContain(fact);
    }
  });

  it('describes the catalog layout in the README', () => {
    expect(readme).toContain('packages/shared/src/catalog-schema.sql');
    expect(readme).toContain('[uint32-BE length][encoded-image-bytes…]');
    expect(readme).toMatch(/Source-supplied blobs retain their format and dimensions/);
    expect(readme).not.toMatch(/(?:generated|edit) thumbnails?[^.\n]*\b300\s*px/i);
    expect(readme).toContain('documentGraph');
  });

  it.skipIf(!hasClaude)('keeps concrete source and package links in CLAUDE.md resolvable', () => {
    const links = [...claude.matchAll(/\]\(([^)]+)\)/g)]
      .map((match) => match[1].split('#')[0])
      .filter((target) => /^(?:src|packages)\//.test(target))
      .filter((target) => !target.includes('<'));

    expect(links.length).toBeGreaterThan(20);
    for (const target of links) {
      expect(existsSync(path.join(ROOT, target)), target).toBe(true);
    }
  });
});

describe('removed architecture surfaces', () => {
  it('keeps the static pipeline settings tab deleted', () => {
    expect(existsSync(path.join(ROOT, `src/components/settings/${DEAD_PIPELINE_TAB}.tsx`))).toBe(false);
    expect(existsSync(path.join(ROOT, `src/components/settings/${DEAD_PIPELINE_TAB}.css`))).toBe(false);

    const settings = read('src/components/SettingsDialog.tsx');
    expect(settings).not.toContain(['settings-tab', 'pipeline'].join('-'));
    expect(settings).not.toContain(['settings.tabs', 'pipeline'].join('.'));

    for (const locale of ['de', 'en']) {
      const messages = JSON.parse(read(`src/i18n/locales/${locale}/shell.json`)) as {
        settings: { tabs: Record<string, unknown> };
      };
      expect(messages.settings.tabs).not.toHaveProperty('pipeline');
    }
  });

  it('keeps the unused public lens lookup removed while documenting the live resolver', () => {
    expect(read('src/engine/LensCorrection.ts')).not.toContain(DEAD_LENS_LOOKUP);
    const resolver = read('src/engine/lensProfile.ts');
    expect(resolver).not.toContain(DEAD_LENS_LOOKUP);
    expect(resolver).toContain('resolveLensCoefficients');
    expect(resolver).toContain('findBuiltinLensProfile');
  });

  it('keeps the appearance reset label scoped to the fields it actually resets', () => {
    const labels = ['de', 'en'].map((locale) => {
      const messages = JSON.parse(read(`src/i18n/locales/${locale}/shell.json`)) as {
        settings: { appearance: { resetLook: string } };
      };
      return messages.settings.appearance.resetLook;
    });

    expect(labels[0]).toMatch(/Schrift.*Akzent.*Theme.*Dichte.*Seitenleiste/i);
    expect(labels[1]).toMatch(/font.*accent.*theme.*density.*sidebar/i);
  });
});

describe('inline architecture comments', () => {
  it('keeps build, catalog and graph ownership comments aligned with production', () => {
    expect(read('vite.config.ts')).toMatch(/build:selfhost[\s\S]*VITE_MODE=hosted[\s\S]*build:online[\s\S]*VITE_MODE=online/);
    expect(read('src/platform/config.ts')).toMatch(/in memory, OPFS or a chosen folder[\s\S]*IndexedDB only persists directory[\s\S]*handles/);
    expect(read('packages/shared/src/catalog-schema.sql')).toContain('SHA-256(first 64 KiB + size)');
    expect(read('packages/shared/src/catalog-schema.ts')).toContain('catalog-schema.test.ts');

    const documentModel = read('src/engine/DocumentModel.ts');
    expect(documentModel).toContain('documentGraph.isGraphLed');
    expect(documentModel).toContain('graphPersistence.ts');
    expect(documentModel).toContain('chainRules.ts');
    expect(documentModel).not.toContain('Nothing READS this as the truth yet');
  });
});
