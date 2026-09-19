/**
 * A sharpening does nothing in a flat area. That is what sharpening MEANS, and
 * it is the one thing the print unsharp mask did not do: it added the whole
 * sharpened VALUE instead of the difference to the blur, so at "standard" a
 * flat 128 came out as 144 and the more sky a print had, the more it was
 * lifted and flattened.
 *
 * Node project on purpose, so `npm run verify` holds it: the function reads one
 * ImageData off a 2D context and writes it back, so a stand-in context measures
 * exactly the arithmetic. The same property is measured through a real canvas
 * and a real page in PrintEngine.browser.test.ts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyPrintSharpening, PRINT_LAYOUTS } from './PrintEngine';

const LEVELS = ['none', 'low', 'standard', 'high'];

/** A greyscale RGBA field behind a 2D-context stand-in; writes land in `data`. */
function field(width: number, height: number, valueAt: (x: number, y: number) => number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const v = valueAt(x, y);
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  const ctx = {
    getImageData: () => ({ data, width, height, colorSpace: 'srgb' }),
    putImageData: () => {},
  } as unknown as CanvasRenderingContext2D;
  return { ctx, data, at: (x: number, y: number) => data[(y * width + x) * 4] };
}

describe('applyPrintSharpening', () => {
  it('leaves a flat field byte-identical at every level', () => {
    for (const level of LEVELS) {
      for (const value of [30, 128, 200]) {
        const { ctx, data } = field(8, 8, () => value);
        const before = Array.from(data);
        applyPrintSharpening(ctx, 8, 8, level);
        expect(Array.from(data), `${level} @ ${value}`).toEqual(before);
      }
    }
  });

  it('still works on an edge, so the flat field is not bought with a zero', () => {
    const { ctx, at } = field(8, 8, (x) => (x < 4 ? 100 : 160));
    applyPrintSharpening(ctx, 8, 8, 'standard');

    // The dark side of the edge gets darker, the light side lighter.
    expect(at(3, 4)).toBeLessThan(100);
    expect(at(4, 4)).toBeGreaterThan(160);
    // Two pixels away the field is flat again and must not have moved.
    expect(at(1, 4)).toBe(100);
    expect(at(6, 4)).toBe(160);
  });

  it('sharpens harder the higher the level, and not at all at none', () => {
    const lift = (level: string) => {
      const { ctx, at } = field(8, 8, (x) => (x < 4 ? 100 : 160));
      applyPrintSharpening(ctx, 8, 8, level);
      return at(4, 4) - 160;
    };
    expect(lift('none')).toBe(0);
    expect(lift('low')).toBeGreaterThan(0);
    expect(lift('standard')).toBeGreaterThan(lift('low'));
    expect(lift('high')).toBeGreaterThan(lift('standard'));
  });
});

/**
 * The layout names used to be German literals in PRINT_LAYOUTS, and the dialog
 * rendered them unchanged - so the English UI offered "Einzelbild" and
 * "Kontaktbogen". The engine names a key now and the dialog translates it.
 */
function printStrings(lang: 'de' | 'en'): Record<string, string> {
  const file = new URL(`../i18n/locales/${lang}/editor.json`, import.meta.url);
  return (JSON.parse(readFileSync(file, 'utf8')) as {
    dialogs: { print: Record<string, string> };
  }).dialogs.print;
}

const leafOf = (id: string) => PRINT_LAYOUTS.find((l) => l.id === id)!.labelKey.split('.').pop()!;

describe('PRINT_LAYOUTS names', () => {
  it('points every layout at a print string both locales define', () => {
    const de = printStrings('de');
    const en = printStrings('en');
    expect(PRINT_LAYOUTS.length).toBeGreaterThan(0);
    for (const layout of PRINT_LAYOUTS) {
      expect(layout.labelKey, layout.id).toMatch(/^dialogs\.print\.layout/);
      const leaf = layout.labelKey.split('.').pop()!;
      expect(de[leaf], `de ${layout.id}`).toBeTypeOf('string');
      expect(en[leaf], `en ${layout.id}`).toBeTypeOf('string');
    }
  });

  it('says the layouts that are words differently in English than in German', () => {
    const de = printStrings('de');
    const en = printStrings('en');
    for (const id of ['single', 'contact-sheet']) {
      const leaf = leafOf(id);
      expect(en[leaf], id).not.toBe(de[leaf]);
    }
  });
});
