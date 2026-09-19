/**
 * The locale gate: every leaf key lives in exactly one file, de and en carry
 * the same keys, and every key the source asks for exists. Runs in the node
 * project, so it is part of `npm run verify`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  diffKeySets,
  extractTranslationKeys,
  findDuplicateLeaves,
  flattenKeys,
  resolveKey,
  resolvePrefix,
} from './i18nCatalog';
import { localeMergeOrder, mergeLocaleModules, type LocaleTree } from './mergeLocales';

const I18N_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(I18N_DIR, '..');
const LANGUAGES = ['de', 'en'] as const;

/**
 * Keys the source may use before a locale defines them. Keep this empty: an
 * entry loosens the gate for a while, and the test fails as soon as the key
 * exists, so the list cannot fill up silently.
 */
const KNOWN_MISSING: string[] = [];

function localeModules(): Record<string, { default: LocaleTree }> {
  const modules: Record<string, { default: LocaleTree }> = {};
  const read = (rel: string) => {
    modules[`./locales/${rel}`] = { default: JSON.parse(readFileSync(path.join(I18N_DIR, 'locales', rel), 'utf8')) };
  };
  for (const lang of LANGUAGES) {
    read(`${lang}.json`);
    for (const file of readdirSync(path.join(I18N_DIR, 'locales', lang))) {
      if (file.endsWith('.json')) read(`${lang}/${file}`);
    }
  }
  return modules;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'locales' && entry !== '__screenshots__') out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.|\.d\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const modules = localeModules();
const resources = mergeLocaleModules(modules, LANGUAGES);

describe('locale files', () => {
  for (const lang of LANGUAGES) {
    it(`keeps every ${lang} leaf key in one file`, () => {
      const files = Object.entries(modules)
        .filter(([p]) => p.startsWith(`./locales/${lang}.`) || p.startsWith(`./locales/${lang}/`))
        .map(([name, mod]) => ({ name, data: mod.default }));
      expect(findDuplicateLeaves(files)).toEqual([]);
    });
  }

  it('gives de and en the same keys', () => {
    const de = new Set(flattenKeys(resources.de.translation).keys());
    const en = new Set(flattenKeys(resources.en.translation).keys());
    expect(diffKeySets(de, en)).toEqual({ onlyA: [], onlyB: [] });
  });

  it('defines every key the source asks for', () => {
    const catalog = flattenKeys(resources.de.translation);
    const missing = new Set<string>();
    for (const file of sourceFiles(SRC_DIR)) {
      const { literal, prefixes } = extractTranslationKeys(readFileSync(file, 'utf8'));
      const rel = path.relative(SRC_DIR, file);
      for (const key of literal) if (!resolveKey(catalog, key)) missing.add(`${key} (${rel})`);
      for (const prefix of prefixes) if (!resolvePrefix(catalog, prefix)) missing.add(`${prefix}* (${rel})`);
    }
    const unexplained = [...missing].filter((m) => !KNOWN_MISSING.some((k) => m.startsWith(`${k} `)));
    expect(unexplained.sort()).toEqual([]);
    const stale = KNOWN_MISSING.filter((k) => resolveKey(catalog, k));
    expect(stale, 'KNOWN_MISSING lists keys that exist now; remove them').toEqual([]);
  });

  it('does not retain the retired legacy print dialog keys', () => {
    const retired = ['title', 'printer', 'paperSize', 'copies', 'printButton'];
    for (const lang of LANGUAGES) {
      const catalog = flattenKeys(resources[lang].translation);
      for (const leaf of retired) expect(catalog.has(`dialogs.print.${leaf}`)).toBe(false);
    }
  });

  it('does not retain the retired add-source dialog keys', () => {
    const retired = [
      'title', 'type', 'name', 'url', 'username',
      'password', 'test', 'testing', 'testOk', 'testFailed',
    ];
    for (const lang of LANGUAGES) {
      const catalog = flattenKeys(resources[lang].translation);
      for (const leaf of retired) expect(catalog.has(`dialogs.addSource.${leaf}`)).toBe(false);
    }
  });

  it('describes skipped sync rows without assuming they came from a push', () => {
    const expected = {
      de: '{{count}} Zeilen übersprungen (zu groß oder ungültig)',
      en: '{{count}} rows skipped (too large or invalid)',
    };
    for (const lang of LANGUAGES) {
      const storage = resources[lang].translation.storage as Record<string, unknown>;
      expect(storage.syncSkipped).toBe(expected[lang]);
    }
  });

  it('states where source credentials remain and when they are plaintext', () => {
    const notes = {
      de: resources.de.translation.sources as Record<string, unknown>,
      en: resources.en.translation.sources as Record<string, unknown>,
    };
    expect(notes.de.credentialsNote).toContain('Katalog');
    expect(notes.de.credentialsNote).toContain('Synchronisieren');
    expect(notes.de.credentialsNote).toContain('Klartext');
    expect(notes.en.credentialsNote).toContain('catalog');
    expect(notes.en.credentialsNote).toContain('synchronization');
    expect(notes.en.credentialsNote).toContain('plain text');
  });
});

describe('locale merge order', () => {
  it('puts the legacy file before the namespace files, whatever the input order', () => {
    expect(localeMergeOrder([
      './locales/de/shell.json', './locales/en.json', './locales/de/adjustments.json', './locales/de.json',
    ])).toEqual([
      './locales/de.json', './locales/de/adjustments.json', './locales/de/shell.json', './locales/en.json',
    ]);
  });

  it('lets a namespace file win over the legacy file for the same key', () => {
    const merged = mergeLocaleModules({
      './locales/de/panels-extra.json': { default: { panels: { presets: { save: '+ Speichern' } } } },
      './locales/de.json': { default: { panels: { presets: { save: 'Als Preset speichern', load: 'Laden' } } } },
    }, ['de']);
    expect(merged.de.translation).toEqual({ panels: { presets: { save: '+ Speichern', load: 'Laden' } } });
  });
});
