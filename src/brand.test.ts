import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'photolib.brand.override';

let values: Map<string, string>;

function installStorage(seed?: Record<string, string>): void {
  values = new Map(Object.entries(seed ?? {}));
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
    clear: vi.fn(() => values.clear()),
    key: vi.fn((index: number) => [...values.keys()][index] ?? null),
    get length() { return values.size; },
  } satisfies Storage);
}

// brand.ts reads localStorage at module load, so every case needs a fresh copy.
async function loadBrand() {
  vi.resetModules();
  return import('./brand');
}

function stored(): unknown {
  const raw = values.get(KEY);
  return raw === undefined ? undefined : JSON.parse(raw);
}

beforeEach(() => { installStorage(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('brand override as a diff against the default', () => {
  it('stores exactly the one field that was changed', async () => {
    const { updateBrandField, getBrandOverride } = await loadBrand();

    updateBrandField('name', 'X');

    expect(stored()).toEqual({ name: 'X' });
    expect(getBrandOverride()).toEqual({ name: 'X' });
  });

  it('keeps earlier fields when a second one changes', async () => {
    const { updateBrandField } = await loadBrand();

    updateBrandField('name', 'X');
    updateBrandField('tagline', 'Y');

    expect(stored()).toEqual({ name: 'X', tagline: 'Y' });
  });

  it('normalises a legacy full-brand object to nothing on load', async () => {
    installStorage({
      [KEY]: JSON.stringify({
        name: 'UnifyRAW',
        shortName: 'UnifyRAW',
        tagline: 'Foto-Bibliothek und RAW-Editor',
        faviconPath: '/favicon.svg',
        wordmarkPath: '/wordmark.svg',
        themeColor: '#1a1a1a',
        copyright: 'UnifyRAW',
        vendorId: 'PhotoLib',
      }),
    });

    const { getBrandOverride, getBrand, getDefaultBrand } = await loadBrand();

    expect(getBrandOverride()).toBeNull();
    expect(getBrand()).toEqual(getDefaultBrand());
  });

  it('keeps only the differing field of a legacy full-brand object', async () => {
    installStorage({
      [KEY]: JSON.stringify({
        name: 'Acme Photos',
        shortName: 'UnifyRAW',
        tagline: 'Foto-Bibliothek und RAW-Editor',
        faviconPath: '/favicon.svg',
        wordmarkPath: '/wordmark.svg',
        themeColor: '#1a1a1a',
        copyright: 'UnifyRAW',
        vendorId: 'PhotoLib',
      }),
    });

    const { getBrandOverride, getBrand } = await loadBrand();

    expect(getBrandOverride()).toEqual({ name: 'Acme Photos' });
    expect(getBrand().tagline).toBe('Foto-Bibliothek und RAW-Editor');
  });

  it('drops the key again when a field is set back to its default', async () => {
    const { updateBrandField, getBrandOverride, getDefaultBrand, getBrand } = await loadBrand();

    updateBrandField('name', 'X');
    updateBrandField('name', getDefaultBrand().name);

    expect(values.has(KEY)).toBe(false);
    expect(getBrandOverride()).toBeNull();
    expect(getBrand()).toEqual(getDefaultBrand());
  });

  it('treats a null wordmark as a real override, not as absent', async () => {
    const { updateBrandField, getBrandOverride } = await loadBrand();

    updateBrandField('wordmarkPath', null);

    expect(stored()).toEqual({ wordmarkPath: null });
    expect(getBrandOverride()).toEqual({ wordmarkPath: null });
  });
});

describe('default brand assets', () => {
  // public/ carried three more wordmarks that nothing referenced; this is the
  // guard that keeps the two survivors referenced and shipped (F114).
  const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

  it('names files that public/ actually ships', async () => {
    const { getDefaultBrand } = await loadBrand();
    const brand = getDefaultBrand();

    for (const assetPath of [brand.faviconPath, brand.wordmarkPath]) {
      expect(assetPath).toMatch(/^\/[\w.-]+$/);
      expect(existsSync(path.join(PUBLIC_DIR, assetPath!.slice(1))), assetPath!).toBe(true);
    }
  });
});
