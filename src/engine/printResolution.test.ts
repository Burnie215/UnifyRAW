import { describe, expect, it } from 'vitest';
import {
  PRINT_RENDER_STEP,
  capRenderLongEdge,
  estimatePrintMemory,
  formatPrintBytes,
  mmToPx,
  printRenderLongEdge,
  renderedFrameBytes,
  deliveredNativeLongEdge,
  deliveredNativePixels,
} from './printResolution';

/**
 * The A4 contact sheet the card is about: 210x297 mm, 10 mm margins,
 * 5 mm spacing, 5 columns x 7 rows. calculateCells derives
 * cellW = (190 - 4*5) / 5 = 34 mm and cellH = (277 - 6*5) / 7 = 35.2857 mm.
 * Kept as literals so a change in PrintEngine cannot silently move the
 * expected pixel counts with it.
 */
const CONTACT_SHEET_CELL = { width: 34, height: 247 / 7 };
/** The same paper with a single image: printable area minus the margins. */
const SINGLE_CELL = { width: 190, height: 277 };

describe('mmToPx', () => {
  it('converts at the DPI it is given', () => {
    expect(mmToPx(25.4, 300)).toBe(300);
    expect(mmToPx(190, 300)).toBe(2244);
    expect(mmToPx(277, 300)).toBe(3272);
    expect(mmToPx(277, 600)).toBe(6543);
  });
});

describe('printRenderLongEdge', () => {
  it('asks for the contact-sheet cell, stepped up, at each DPI', () => {
    // 35.2857 mm at 150/300/600 DPI = 208 / 417 / 834 px on the long edge.
    expect(printRenderLongEdge('cell', CONTACT_SHEET_CELL, 150)).toBe(256);
    expect(printRenderLongEdge('cell', CONTACT_SHEET_CELL, 300)).toBe(512);
    expect(printRenderLongEdge('cell', CONTACT_SHEET_CELL, 600)).toBe(1024);
  });

  it('asks for a full-page cell at the size the page can show', () => {
    // 277 mm at 300 DPI = 3272 px, stepped up to the next 256.
    expect(printRenderLongEdge('cell', SINGLE_CELL, 300)).toBe(3328);
    expect(printRenderLongEdge('cell', SINGLE_CELL, 600)).toBe(6656);
  });

  it('takes the long edge of the cell, whichever side that is', () => {
    expect(printRenderLongEdge('cell', { width: 277, height: 190 }, 300)).toBe(3328);
  });

  it('never asks for less than one step', () => {
    expect(printRenderLongEdge('cell', { width: 4, height: 4 }, 150)).toBe(PRINT_RENDER_STEP);
  });

  it('absorbs a one-millimetre margin nudge instead of re-rendering', () => {
    const nudged = { width: 33.8, height: 247 / 7 - 0.2857 };
    expect(printRenderLongEdge('cell', nudged, 300))
      .toBe(printRenderLongEdge('cell', CONTACT_SHEET_CELL, 300));
  });

  it('bounds nothing in native mode', () => {
    expect(printRenderLongEdge('native', CONTACT_SHEET_CELL, 300)).toBeNull();
    expect(printRenderLongEdge('native', SINGLE_CELL, 600)).toBeNull();
  });
});

describe('capRenderLongEdge', () => {
  it('caps a request at the pixels the file actually has', () => {
    expect(capRenderLongEdge(3328, 2048, 1365)).toBe(2048);
    expect(capRenderLongEdge(3328, 1365, 2048)).toBe(2048);
  });

  it('leaves a request below native alone', () => {
    expect(capRenderLongEdge(512, 9504, 6336)).toBe(512);
  });

  it('keeps the request when the catalogue has no dimensions', () => {
    expect(capRenderLongEdge(512, null, null)).toBe(512);
    expect(capRenderLongEdge(512, 0, 0)).toBe(512);
  });

  it('stays native when native was asked for', () => {
    expect(capRenderLongEdge(null, 9504, 6336)).toBeNull();
  });
});

describe('renderedFrameBytes', () => {
  it('weighs a 61-MP frame at its native resolution', () => {
    // 9504 x 6336 = 60.2 MP; RGBA8 = 240,869,376 bytes.
    expect(renderedFrameBytes(9504, 6336, null)).toBe(240_869_376);
  });

  it('weighs the same photo at a contact-sheet cell', () => {
    // 512 / 9504 scales 6336 to 341; 512 * 341 * 4 = 698,368 bytes.
    expect(renderedFrameBytes(9504, 6336, 512)).toBe(698_368);
  });

  it('does not enlarge a photo smaller than the cell', () => {
    expect(renderedFrameBytes(400, 300, 3328)).toBe(400 * 300 * 4);
  });

  it('knows nothing about a photo without dimensions', () => {
    expect(renderedFrameBytes(null, 6336, 512)).toBeNull();
    expect(renderedFrameBytes(9504, null, 512)).toBeNull();
  });
});

describe('estimatePrintMemory', () => {
  const sheet = Array.from({ length: 35 }, () => ({ width: 9504, height: 6336 }));

  it('counts the frame AND the canvas cached from it, at native resolution', () => {
    const estimate = estimatePrintMemory(sheet, null);
    expect(estimate.totalBytes).toBe(240_869_376 * 2 * 35);
    expect(estimate.largestBytes).toBe(240_869_376 * 2);
    expect(estimate.unknown).toBe(0);
  });

  it('adds up what the same sheet costs at the default', () => {
    const estimate = estimatePrintMemory(sheet, 512);
    expect(estimate.totalBytes).toBe(698_368 * 2 * 35);
    expect(estimate.largestBytes).toBe(698_368 * 2);
  });

  it('counts photos it cannot weigh instead of guessing', () => {
    const estimate = estimatePrintMemory(
      [{ width: 9504, height: 6336 }, { width: null, height: null }],
      512,
    );
    expect(estimate.totalBytes).toBe(698_368 * 2);
    expect(estimate.unknown).toBe(1);
  });
});

describe('formatPrintBytes', () => {
  it('names the sizes the hint has to show', () => {
    expect(formatPrintBytes(698_368)).toBe('682 KB');
    expect(formatPrintBytes(240_869_376)).toBe('230 MB');
    expect(formatPrintBytes(240_869_376 * 35)).toBe('7.9 GB');
    expect(formatPrintBytes(698_368 * 35)).toBe('23 MB');
  });
});

/**
 * "Native" is two different resolutions and nothing said so: only the
 * in-browser libraw path returns the sensor's pixels, a backend-decoded RAW is
 * clamped by /api/raw/smart-preview. The numbers are absolute on purpose - a
 * comparison against the same constant on both sides would move with it.
 */
describe('deliveredNativeLongEdge', () => {
  it('hands a locally decoded 60 MP file its own long edge', () => {
    expect(deliveredNativeLongEdge(9504, 6336, true)).toBe(9504);
  });

  it('caps a backend-decoded one at what the server will produce', () => {
    expect(deliveredNativeLongEdge(9504, 6336, false)).toBe(8000);
  });

  it('leaves a file below the cap alone either way', () => {
    expect(deliveredNativeLongEdge(6000, 4000, false)).toBe(6000);
    expect(deliveredNativeLongEdge(6000, 4000, true)).toBe(6000);
  });

  it('says nothing for a photo the catalogue has no dimensions for', () => {
    expect(deliveredNativeLongEdge(null, null, false)).toBeNull();
  });
});

describe('deliveredNativePixels', () => {
  it('keeps the aspect while naming what actually arrives', () => {
    expect(deliveredNativePixels({ width: 9504, height: 6336 }, false))
      .toEqual({ width: 8000, height: 5333 });
  });

  it('changes nothing for a local decode', () => {
    expect(deliveredNativePixels({ width: 9504, height: 6336 }, true))
      .toEqual({ width: 9504, height: 6336 });
  });

  it('is what the memory hint must count for a backend sheet', () => {
    const sheet = Array.from({ length: 35 }, () => deliveredNativePixels({ width: 9504, height: 6336 }, false));
    expect(estimatePrintMemory(sheet, null).largestBytes).toBe(8000 * 5333 * 4 * 2);
  });
});
