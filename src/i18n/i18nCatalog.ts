/**
 * Pure helpers over already-loaded locale trees and source text, so the locale
 * gate (locales.test.ts) and the unused-key report read "a translation key"
 * the same way. No fs here; callers load the files.
 */
import type { LocaleTree } from './mergeLocales';

const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other'];

export function flattenKeys(tree: LocaleTree, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [leaf, value] of flattenKeys(v as LocaleTree, key)) out.set(leaf, value);
    } else {
      out.set(key, v);
    }
  }
  return out;
}

export function findDuplicateLeaves(
  files: ReadonlyArray<{ name: string; data: LocaleTree }>,
): Array<{ key: string; files: string[] }> {
  const owners = new Map<string, string[]>();
  for (const { name, data } of files) {
    for (const key of flattenKeys(data).keys()) {
      owners.set(key, [...(owners.get(key) ?? []), name]);
    }
  }
  return [...owners]
    .filter(([, names]) => names.length > 1)
    .map(([key, names]) => ({ key, files: names }));
}

export function diffKeySets(
  a: ReadonlySet<string>, b: ReadonlySet<string>,
): { onlyA: string[]; onlyB: string[] } {
  return {
    onlyA: [...a].filter((key) => !b.has(key)).sort(),
    onlyB: [...b].filter((key) => !a.has(key)).sort(),
  };
}

/**
 * Keys a source file asks for. A template key is only known up to its first
 * `${`, so it counts as a prefix. Keys built by concatenation (`'a.' + b`) are
 * invisible here — write them as templates so the prefix check sees them.
 */
export function extractTranslationKeys(source: string): { literal: string[]; prefixes: string[] } {
  const literal = new Set<string>();
  const prefixes = new Set<string>();

  for (const m of source.matchAll(/(?<![\w$])t\(\s*(['"])([^'"\n]+)\1/g)) literal.add(m[2]);
  for (const m of source.matchAll(/(?<![\w$])t\(\s*`([^`$\n]*)(\$\{)?/g)) {
    if (m[2]) {
      if (m[1]) prefixes.add(m[1]);
    } else if (m[1]) {
      literal.add(m[1]);
    }
  }
  for (const m of source.matchAll(/\b(?:i18nKey|titleKey|labelKey)\s*[:=]\s*\{?\s*(['"])([^'"\n]+)\1/g)) {
    literal.add(m[2]);
  }
  for (const m of source.matchAll(/(['"])(uiShell\.panelRegistry\.[\w.]+)\1/g)) literal.add(m[2]);

  return { literal: [...literal], prefixes: [...prefixes] };
}

/** A leaf, a plural family (`key_one`/`key_other`), or a subtree read with returnObjects. */
export function resolveKey(catalog: ReadonlyMap<string, unknown>, key: string): boolean {
  if (catalog.has(key)) return true;
  if (PLURAL_SUFFIXES.some((suffix) => catalog.has(key + suffix))) return true;
  const subtree = `${key}.`;
  for (const k of catalog.keys()) if (k.startsWith(subtree)) return true;
  return false;
}

export function resolvePrefix(catalog: ReadonlyMap<string, unknown>, prefix: string): boolean {
  for (const k of catalog.keys()) if (k.startsWith(prefix)) return true;
  return false;
}
