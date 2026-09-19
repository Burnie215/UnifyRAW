import { describe, expect, it } from 'vitest';
import {
  diffKeySets,
  extractTranslationKeys,
  findDuplicateLeaves,
  flattenKeys,
  resolveKey,
  resolvePrefix,
} from './i18nCatalog';

describe('extractTranslationKeys', () => {
  it('reads single, double and plain template keys as literals', () => {
    const { literal, prefixes } = extractTranslationKeys(
      "t('a.one'); t(\"a.two\"); t(`a.three`); i18n.t('a.four');",
    );
    expect(literal.sort()).toEqual(['a.four', 'a.one', 'a.three', 'a.two']);
    expect(prefixes).toEqual([]);
  });

  it('treats a template key as a prefix up to its first placeholder', () => {
    const { literal, prefixes } = extractTranslationKeys('t(`gridToolbar.sort.${key}`)');
    expect(literal).toEqual([]);
    expect(prefixes).toEqual(['gridToolbar.sort.']);
  });

  it('keeps the key of a call with a defaultValue and reads titleKey', () => {
    const { literal } = extractTranslationKeys(
      "t('panels.x', { defaultValue: 'X' }); const p = { titleKey: 'uiShell.panels.y' };",
    );
    expect(literal.sort()).toEqual(['panels.x', 'uiShell.panels.y']);
  });

  it('does not mistake other calls ending in t( for translations', () => {
    expect(extractTranslationKeys("split('a.b'); setT('c.d'); format('e')").literal).toEqual([]);
  });
});

describe('catalog lookups', () => {
  const catalog = flattenKeys({ a: { b: 'x', count_one: '1 item', count_other: '{{count}} items' } });

  it('flattens nested trees into dotted leaves', () => {
    expect([...catalog.keys()].sort()).toEqual(['a.b', 'a.count_one', 'a.count_other']);
  });

  it('resolves leaves, plural families and subtrees, nothing else', () => {
    expect(resolveKey(catalog, 'a.b')).toBe(true);
    expect(resolveKey(catalog, 'a.count')).toBe(true);
    expect(resolveKey(catalog, 'a')).toBe(true);
    expect(resolveKey(catalog, 'a.c')).toBe(false);
    expect(resolvePrefix(catalog, 'a.co')).toBe(true);
    expect(resolvePrefix(catalog, 'b.')).toBe(false);
  });

  it('names a leaf that lives in two files', () => {
    expect(findDuplicateLeaves([
      { name: 'de.json', data: { a: { b: 'x', c: 'y' } } },
      { name: 'de/shell.json', data: { a: { b: 'z' } } },
    ])).toEqual([{ key: 'a.b', files: ['de.json', 'de/shell.json'] }]);
  });

  it('lists the keys each side lacks', () => {
    expect(diffKeySets(new Set(['a', 'b']), new Set(['b', 'c']))).toEqual({ onlyA: ['a'], onlyB: ['c'] });
  });
});
