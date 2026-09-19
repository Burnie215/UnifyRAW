import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PANEL_LAYOUT_VERSION,
  floatingIdsForSide,
  loadLayout,
  sanitizeLayout,
  saveLayout,
} from './usePanelLayout';
import { DEFAULT_LAYOUT } from './panelRegistry';
import { STORAGE_KEYS } from '../platform/storageKeys';
import type { PanelLayout } from './panelTypes';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'locales' && entry !== '__screenshots__') out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.d\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function layout(partial: Partial<PanelLayout> = {}): PanelLayout {
  return { ...DEFAULT_LAYOUT, ...partial };
}

describe('sanitizeLayout', () => {
  it('drops ids the registry does not know', () => {
    const clean = sanitizeLayout({ ...DEFAULT_LAYOUT, right: ['basic', 'publish', 'not-a-panel', 'detail'] });
    expect(clean.right).not.toContain('publish');
    expect(clean.right).not.toContain('not-a-panel');
    expect(clean.right.indexOf('basic')).toBeLessThan(clean.right.indexOf('detail'));
  });

  it('drops retired ids out of collapsed and pinned as well', () => {
    const clean = sanitizeLayout({
      ...DEFAULT_LAYOUT,
      collapsed: ['detail', 'publish'],
      pinned: ['histogram', 'publish'],
    });
    expect(clean.collapsed).toEqual(['detail']);
    expect(clean.pinned).toEqual(['histogram']);
  });

  it('keeps a panel in the first zone that claims it', () => {
    const clean = sanitizeLayout({ ...DEFAULT_LAYOUT, left: ['basic', 'navigator'], right: ['basic', 'detail'] });
    expect(clean.left).toContain('basic');
    expect(clean.right).not.toContain('basic');
  });

  it('removes a duplicate inside one zone', () => {
    const clean = sanitizeLayout({ ...DEFAULT_LAYOUT, left: ['navigator', 'presets', 'navigator'] });
    expect(clean.left.filter((id) => id === 'navigator')).toHaveLength(1);
  });

  it('does not float and dock the same panel at once', () => {
    const clean = sanitizeLayout({
      ...DEFAULT_LAYOUT,
      right: ['basic', 'detail'],
      floating: [{ id: 'detail', x: 10, y: 20, width: 300, height: 400 }],
    });
    expect(clean.right).toContain('detail');
    expect(clean.floating).toEqual([]);
  });

  it('keeps a valid floating entry with its origin and repairs a broken one', () => {
    const clean = sanitizeLayout({
      ...DEFAULT_LAYOUT,
      left: [],
      right: [],
      floating: [
        { id: 'basic', x: 10, y: 20, width: 320, height: 410, origin: 'right' },
        { id: 'navigator', x: 'nope', y: null, origin: 'nowhere' },
      ],
    });
    expect(clean.floating).toEqual([
      { id: 'basic', x: 10, y: 20, width: 320, height: 410, origin: 'right' },
      { id: 'navigator', x: 0, y: 0, width: 300, height: 400 },
    ]);
  });

  it('adds panels that shipped after the layout was stored, behind their default neighbour', () => {
    const stored = { ...DEFAULT_LAYOUT, right: DEFAULT_LAYOUT.right.filter((id) => id !== 'levels') };
    const clean = sanitizeLayout(stored);
    expect(clean.right).toEqual(DEFAULT_LAYOUT.right);
  });

  it('falls back to the default layout for anything that is not an object', () => {
    expect(sanitizeLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(sanitizeLayout('[]')).toEqual(DEFAULT_LAYOUT);
  });
});

describe('floatingIdsForSide', () => {
  it('lists a floating panel with the zone it was floated out of', () => {
    const l = layout({
      floating: [
        { id: 'navigator', x: 0, y: 0, width: 300, height: 400, origin: 'left' },
        { id: 'basic', x: 0, y: 0, width: 300, height: 400, origin: 'right' },
      ],
    });
    expect(floatingIdsForSide(l, 'left')).toEqual(['navigator']);
    expect(floatingIdsForSide(l, 'right')).toEqual(['basic']);
  });

  it('sends bottom and unknown origins to the right, so nothing is hidden', () => {
    const l = layout({
      floating: [
        { id: 'filmstrip', x: 0, y: 0, width: 300, height: 400, origin: 'bottom' },
        { id: 'detail', x: 0, y: 0, width: 300, height: 400 },
      ],
    });
    expect(floatingIdsForSide(l, 'left')).toEqual([]);
    expect(floatingIdsForSide(l, 'right')).toEqual(['filmstrip', 'detail']);
  });
});

describe('stored layout', () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage');
  });

  it('stamps the version it was written with', () => {
    saveLayout(layout());
    expect(JSON.parse(store.get(STORAGE_KEYS.panelLayout) as string).version).toBe(PANEL_LAYOUT_VERSION);
  });

  it('cleans a version-1 layout on the way in and never returns the version field', () => {
    store.set(STORAGE_KEYS.panelLayout, JSON.stringify({
      ...DEFAULT_LAYOUT,
      right: ['basic', 'publish', 'basic'],
    }));
    const loaded = loadLayout();
    expect(loaded.right).not.toContain('publish');
    expect(loaded.right.filter((id) => id === 'basic')).toHaveLength(1);
    expect(Object.keys(loaded)).not.toContain('version');

    // Cleaned once and written back, so storage stops carrying the retired id.
    const written = JSON.parse(store.get(STORAGE_KEYS.panelLayout) as string);
    expect(written.version).toBe(PANEL_LAYOUT_VERSION);
    expect(written.right).toEqual(loaded.right);
  });

  it('leaves a current layout in storage untouched', () => {
    const current = JSON.stringify({ ...DEFAULT_LAYOUT, version: PANEL_LAYOUT_VERSION });
    store.set(STORAGE_KEYS.panelLayout, current);
    loadLayout();
    expect(store.get(STORAGE_KEYS.panelLayout)).toBe(current);
  });

  it('falls back to the default layout for unreadable storage', () => {
    store.set(STORAGE_KEYS.panelLayout, '{not json');
    expect(loadLayout()).toEqual(DEFAULT_LAYOUT);
  });
});

/**
 * The layout is one localStorage key. Two hook instances each write it from
 * their own mount snapshot, so whoever renders last wins - which is how panel
 * order and collapse state used to depend on the order of clicks (the editor
 * shell remounts with every photo). The provider is the only owner allowed.
 */
describe('one owner', () => {
  it('calls usePanelLayout in exactly one place', () => {
    const callers = sourceFiles(SRC_DIR)
      .map((file) => path.relative(SRC_DIR, file))
      // The hook's own module declares it; tests may call it freely.
      .filter((rel) => rel !== path.join('ui', 'usePanelLayout.ts') && !/\.test\.tsx?$/.test(rel))
      .filter((rel) => /\busePanelLayout\s*\(/.test(readFileSync(path.join(SRC_DIR, rel), 'utf8')));
    expect(callers).toEqual(['contexts/PanelLayoutContext.tsx']);
  });
});
