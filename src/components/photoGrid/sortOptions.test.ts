import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SORT_LABEL_KEYS, sortOptions } from './sortOptions';

describe('shared library sort options', () => {
  it('offers and names every supported sort order', () => {
    expect(sortOptions()).toEqual([
      'name-asc', 'name-desc', 'date-newest', 'date-oldest',
      'rating-highest', 'rating-lowest', 'size-largest', 'size-smallest',
    ]);
    for (const option of sortOptions()) expect(SORT_LABEL_KEYS[option]).toBeTruthy();
  });

  it.each(['GridToolbar.tsx', 'AdaptiveNavigation.tsx'])('%s renders from the shared options', (file) => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const source = readFileSync(path.join(dir, file), 'utf8');
    expect(source).not.toMatch(/const SORT_KEYS\b/);
    expect(source).toContain('sortOptions()');
  });
});
