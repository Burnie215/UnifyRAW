import { describe, expect, it } from 'vitest';
import { mergeLocaleModules } from './mergeLocales';

describe('mergeLocaleModules', () => {
  it('leaves the source modules untouched', () => {
    const legacy = { autoOptimize: { title: 'Auto' } };
    const namespace = { autoOptimize: { failed: 'Fehlgeschlagen' } };
    mergeLocaleModules({
      './locales/de.json': { default: legacy },
      './locales/de/editor.json': { default: namespace },
    }, ['de']);
    expect(legacy).toEqual({ autoOptimize: { title: 'Auto' } });
    expect(namespace).toEqual({ autoOptimize: { failed: 'Fehlgeschlagen' } });
  });
});
