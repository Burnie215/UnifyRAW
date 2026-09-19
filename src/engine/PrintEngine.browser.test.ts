/**
 * What the print page draws — finished frames, and a gap where one is missing.
 *
 * The bug this measures: the page loaded display URLs through `new Image()`
 * (F071), so it drew the untouched original and a rejected load took the whole
 * page with it. It now composes `RenderedFrame`s from the same render stage the
 * export uses, and a photo that could not be rendered gets a placeholder cell
 * instead of an exception.
 *
 * Browser-mode-only: renderPrintPage needs a real canvas.
 * Run with: npx vitest run --project browser PrintEngine
 */
import { describe, expect, it } from 'vitest';

import {
  renderPrintPage, calculateCells, mmToPx, paginatePrintImages,
  DEFAULT_PRINT_SETTINGS, PRINT_LAYOUTS, PLACEHOLDER_FILL,
  type PrintImage, type PrintSettings,
} from './PrintEngine';
import type { RenderedFrame } from './Exporter';

const GREY = 128;

function greyFrame(width = 40, height = 40, value = GREY): RenderedFrame {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = value;
    pixels[i * 4 + 1] = value;
    pixels[i * 4 + 2] = value;
    pixels[i * 4 + 3] = 255;
  }
  return { width, height, pixels, colorSpace: 'srgb' };
}

/** 2x2 at screen resolution, with the DEFAULT sharpening left on: the unsharp
 *  mask used to lift flat areas, so "is the cell the frame's colour" measures
 *  the sharpener too, on a real canvas and a whole page. */
const SETTINGS: PrintSettings = {
  ...DEFAULT_PRINT_SETTINGS,
  layout: PRINT_LAYOUTS.find((l) => l.id === 'grid-2x2')!,
  dpi: 72,
};

function pixelAt(canvas: HTMLCanvasElement, x: number, y: number): [number, number, number] {
  const d = canvas.getContext('2d')!.getImageData(Math.round(x), Math.round(y), 1, 1).data;
  return [d[0], d[1], d[2]];
}

/** The point in a cell, as a fraction of its height from the top. */
function cellPoint(settings: PrintSettings, index: number, fracY: number): [number, number] {
  const cell = calculateCells(settings)[index];
  return [
    mmToPx(cell.x + cell.width / 2, settings.dpi),
    mmToPx(cell.y + cell.height * fracY, settings.dpi),
  ];
}

function hex(fill: string): [number, number, number] {
  return [
    parseInt(fill.slice(1, 3), 16),
    parseInt(fill.slice(3, 5), 16),
    parseInt(fill.slice(5, 7), 16),
  ];
}

describe('renderPrintPage', () => {
  it('draws the frame it is given and a placeholder where there is none', () => {
    const images = [
      { name: 'edited.jpg', frame: greyFrame() },
      { name: 'broken.raf', frame: null },
    ];

    let canvas!: HTMLCanvasElement;
    expect(() => { canvas = renderPrintPage(images, SETTINGS); }).not.toThrow();

    const [fx, fy] = cellPoint(SETTINGS, 0, 0.5);
    expect(pixelAt(canvas, fx, fy)).toEqual([GREY, GREY, GREY]);

    // Above the placeholder's caption, which sits on the cell's centre line.
    const [px, py] = cellPoint(SETTINGS, 1, 0.25);
    expect(pixelAt(canvas, px, py)).toEqual(hex(PLACEHOLDER_FILL));
  });

  it('re-lays-out the same frames when the settings change', () => {
    const frame = greyFrame();
    const images = [{ name: 'edited.jpg', frame }, { name: 'broken.raf', frame: null }];

    const a4 = renderPrintPage(images, SETTINGS);
    const a3 = renderPrintPage(images, { ...SETTINGS, dpi: 150 });

    // Different page, same frame object - nothing was re-rendered or consumed.
    expect(a3.width).toBeGreaterThan(a4.width);
    expect(frame.pixels.byteLength).toBe(40 * 40 * 4);
    expect(frame.pixels[0]).toBe(GREY);

    const [fx, fy] = cellPoint({ ...SETTINGS, dpi: 150 }, 0, 0.5);
    expect(pixelAt(a3, fx, fy)).toEqual([GREY, GREY, GREY]);
  });
});

describe('paginatePrintImages', () => {
  const images: PrintImage[] = Array.from({ length: 35 }, (_, i) => ({
    name: `photo-${i}.jpg`, frame: null,
  }));

  it('gives every photo a page instead of dropping all but the first cellful', () => {
    const pages = paginatePrintImages(images, SETTINGS);

    // 35 photos, four cells to a sheet: nine sheets, the last one part-full.
    expect(pages.length).toBe(9);
    expect(pages.at(-1)!.length).toBe(3);
    expect(pages.flat().map((image) => image.name)).toEqual(images.map((image) => image.name));
  });

  it('counts the cells of the layout in front of it', () => {
    const contact = PRINT_LAYOUTS.find((l) => l.id === 'contact-sheet')!;
    expect(paginatePrintImages(images, { ...SETTINGS, layout: contact }).length).toBe(1);
    expect(paginatePrintImages(images, { ...SETTINGS, layout: PRINT_LAYOUTS[0] }).length).toBe(35);
  });

  it('draws a part-full last page without spilling into the empty cells', () => {
    const grey = greyFrame();
    const last = paginatePrintImages(
      [{ name: 'a.jpg', frame: grey }, { name: 'b.jpg', frame: grey }, { name: 'c.jpg', frame: grey }],
      SETTINGS,
    ).at(-1)!;
    expect(last.length).toBe(3);

    const canvas = renderPrintPage(last, SETTINGS);
    const [fx, fy] = cellPoint(SETTINGS, 2, 0.5);
    expect(pixelAt(canvas, fx, fy)).toEqual([GREY, GREY, GREY]);
    // The fourth cell has no photo and no placeholder - it is paper.
    const [ex, ey] = cellPoint(SETTINGS, 3, 0.5);
    expect(pixelAt(canvas, ex, ey)).toEqual([255, 255, 255]);
  });
});
