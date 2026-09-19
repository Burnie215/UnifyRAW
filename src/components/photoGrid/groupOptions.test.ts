/**
 * The group selector used to offer all four groupings to tiles, list AND
 * timeline, and three of them did nothing outside the tiles. The options are
 * now one table, so the absolute list per view is what this pins down.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GridMode } from '../../types';
import { GROUP_LABEL_KEYS, effectiveGroupMode, groupOptionsFor } from './groupOptions';

const GRID_MODES: GridMode[] = ['tiles', 'list', 'gallery', 'timeline'];

describe('which groupings a view offers', () => {
  it('offers all four only in the tiles, which are the only view that draws them', () => {
    expect(groupOptionsFor('tiles')).toEqual(['none', 'folder', 'folder-grid', 'folder-stack']);
  });

  it('offers the list its folder sections and nothing else', () => {
    expect(groupOptionsFor('list')).toEqual(['none', 'folder']);
  });

  it('leaves timeline and gallery with no choice to make', () => {
    expect(groupOptionsFor('timeline')).toEqual(['none']);
    expect(groupOptionsFor('gallery')).toEqual(['none']);
  });

  it('names every grouping it offers', () => {
    for (const mode of GRID_MODES) {
      for (const group of groupOptionsFor(mode)) {
        expect(GROUP_LABEL_KEYS[group]).toBeTruthy();
      }
    }
  });
});

describe('the grouping a view really applies', () => {
  it('keeps a grouping the view honours', () => {
    expect(effectiveGroupMode('tiles', 'folder-stack')).toBe('folder-stack');
    expect(effectiveGroupMode('list', 'folder')).toBe('folder');
  });

  it('reads as none where the view would drop it silently', () => {
    expect(effectiveGroupMode('list', 'folder-grid')).toBe('none');
    expect(effectiveGroupMode('list', 'folder-stack')).toBe('none');
    expect(effectiveGroupMode('timeline', 'folder')).toBe('none');
    expect(effectiveGroupMode('gallery', 'folder-stack')).toBe('none');
  });

  it('always answers with something the view offers', () => {
    for (const mode of GRID_MODES) {
      for (const group of ['none', 'folder', 'folder-grid', 'folder-stack'] as const) {
        expect(groupOptionsFor(mode)).toContain(effectiveGroupMode(mode, group));
      }
    }
  });
});

/**
 * Both selectors used to spell the four options out. A literal option list is
 * how they drifted from what the views do, so it stays gone.
 */
describe('the selectors render from the table', () => {
  const COMPONENTS = ['GridToolbar.tsx', 'AdaptiveNavigation.tsx'];
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  it.each(COMPONENTS)('%s spells out no grouping of its own', (file) => {
    const source = readFileSync(path.join(dir, file), 'utf8');
    expect(source).not.toMatch(/<option value="folder/);
    expect(source).toContain('groupOptionsFor');
  });
});
