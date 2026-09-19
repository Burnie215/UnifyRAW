/**
 * Report, not a gate: locale keys that no source file references, literally
 * or through a template prefix, grouped by top-level namespace. Template keys
 * built at runtime make false positives likely, which is why locales.test.ts
 * only gates "undefined" and "duplicate".
 *
 * Run with: npm run i18n:unused
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTranslationKeys, flattenKeys } from '../src/i18n/i18nCatalog';
import { mergeLocaleModules, type LocaleTree } from '../src/i18n/mergeLocales';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const LOCALES = path.join(SRC, 'i18n', 'locales');

const modules: Record<string, { default: LocaleTree }> = {};
for (const entry of readdirSync(LOCALES)) {
  const full = path.join(LOCALES, entry);
  if (statSync(full).isDirectory()) {
    for (const file of readdirSync(full)) {
      if (file.endsWith('.json')) modules[`./locales/${entry}/${file}`] = { default: JSON.parse(readFileSync(path.join(full, file), 'utf8')) };
    }
  } else if (entry.endsWith('.json')) {
    modules[`./locales/${entry}`] = { default: JSON.parse(readFileSync(full, 'utf8')) };
  }
}
const catalog = flattenKeys(mergeLocaleModules(modules, ['de']).de.translation);

const literal = new Set<string>();
const prefixes = new Set<string>();
const walk = (dir: string) => {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'locales') walk(full);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.|\.d\.ts$/.test(entry)) {
      const found = extractTranslationKeys(readFileSync(full, 'utf8'));
      found.literal.forEach((k) => literal.add(k));
      found.prefixes.forEach((p) => prefixes.add(p));
    }
  }
};
walk(SRC);

const referenced = (key: string) => {
  const base = key.replace(/_(zero|one|two|few|many|other)$/, '');
  if (literal.has(key) || literal.has(base)) return true;
  for (const lit of literal) if (key.startsWith(`${lit}.`)) return true;
  for (const prefix of prefixes) if (key.startsWith(prefix)) return true;
  return false;
};

const unused = [...catalog.keys()].filter((key) => !referenced(key)).sort();
const byNamespace = new Map<string, string[]>();
for (const key of unused) {
  const ns = key.split('.')[0];
  byNamespace.set(ns, [...(byNamespace.get(ns) ?? []), key]);
}
for (const [ns, keys] of [...byNamespace].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${ns} (${keys.length})`);
  for (const key of keys) console.log(`  ${key}`);
}
console.log(`\n${unused.length} of ${catalog.size} keys without a reference`);
