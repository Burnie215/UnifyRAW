/**
 * What the export dialog may offer, decided away from JSX.
 *
 * Three constraints overlap - the write-back target's allowed formats, the
 * measured depth of the originals, and which container can hold 16 bit - and
 * the interesting cases are the ones where two of them disagree. Those are
 * cheap to enumerate here and expensive to see in a rendered dialog.
 */
import { describe, expect, it } from 'vitest';
import {
  estimateExportBytes,
  formatEstimatedBytes,
  planExportChoices,
  type ExportChoiceRequest,
} from './exportChoices';

const download: ExportChoiceRequest = {
  destination: 'download',
  format: 'jpeg',
  bitDepth: 8,
  sourceCanExport16Bit: true,
};

const lock16 = (request: ExportChoiceRequest) =>
  planExportChoices(request).depths.find((choice) => choice.depth === 16);

describe('planExportChoices - depth lock', () => {
  it('keeps 16 visible but locked with the source as the reason', () => {
    expect(lock16({ ...download, sourceCanExport16Bit: false }))
      .toEqual({ depth: 16, enabled: false, reason: 'source8bit' });
  });

  it('unlocks 16 without a reason once every original carries more than 8 bit', () => {
    expect(lock16(download)).toEqual({ depth: 16, enabled: true });
  });

  it('blames the destination when the target accepts no 16-bit container', () => {
    expect(lock16({
      ...download, destination: 'source', allowedSourceFormats: ['jpg'],
    })).toEqual({ depth: 16, enabled: false, reason: 'destination' });
  });

  it('prefers the source reason when both the source and the target say no', () => {
    expect(lock16({
      ...download,
      sourceCanExport16Bit: false,
      destination: 'source',
      allowedSourceFormats: ['jpg'],
    })).toEqual({ depth: 16, enabled: false, reason: 'source8bit' });
  });

  it('always shows both depths, never a shortened list', () => {
    expect(planExportChoices({ ...download, sourceCanExport16Bit: false }).depths)
      .toHaveLength(2);
  });

  it('writes 8 bit when 16 was asked for but is locked', () => {
    expect(planExportChoices({ ...download, bitDepth: 16, sourceCanExport16Bit: false }).bitDepth)
      .toBe(8);
  });
});

describe('planExportChoices - format coupling', () => {
  it('offers the four 8-bit formats for a download, and not DNG', () => {
    // DNG is half-float only - `exportPhoto` refuses it at 8 bit, so a button
    // for it here would promise a file nothing can write.
    expect(planExportChoices(download).formats).toEqual(['jpeg', 'png', 'webp', 'tiff']);
  });

  it('narrows to the three 16-bit containers when 16 bit is chosen', () => {
    expect(planExportChoices({ ...download, bitDepth: 16 }).formats)
      .toEqual(['png', 'tiff', 'dng']);
  });

  it('keeps a chosen DNG through the 16-bit narrowing', () => {
    const plan = planExportChoices({ ...download, format: 'dng', bitDepth: 16 });
    expect(plan.format).toBe('dng');
    expect(plan.bitDepth).toBe(16);
  });

  it('drops a chosen DNG back to TIFF when the depth falls to 8', () => {
    // Not to JPEG: at 8 bit the depth switch is the thing that moved, and the
    // nearest honest container is the other lossless one.
    const plan = planExportChoices({
      ...download, format: 'dng', bitDepth: 16, sourceCanExport16Bit: false,
    });
    expect(plan.bitDepth).toBe(8);
    expect(plan.format).toBe('tiff');
    expect(plan.formats).not.toContain('dng');
  });

  it('never lands on DNG by silent correction', () => {
    // A correction happens without a word. Landing on a linear negative that
    // most viewers cannot open is not something to hand out unasked, so DNG
    // is in neither fallback order.
    const plan = planExportChoices({
      ...download,
      format: 'jpeg',
      bitDepth: 16,
      destination: 'source',
      allowedSourceFormats: ['jpg', 'png', 'dng'],
    });
    expect(plan.formats).toEqual(['png', 'dng']);
    expect(plan.format).toBe('png');
  });

  it('offers DNG to a source only when that source declared it', () => {
    const immich = planExportChoices({
      ...download, bitDepth: 16, destination: 'source',
      allowedSourceFormats: ['jpg', 'tif', 'png', 'dng'],
    });
    expect(immich.formats).toEqual(['png', 'tiff', 'dng']);

    const lychee = planExportChoices({
      ...download, bitDepth: 16, destination: 'source', allowedSourceFormats: ['jpg', 'png'],
    });
    expect(lychee.formats).toEqual(['png']);
  });

  it('never grants DNG to a source that declared nothing', () => {
    // The default list reproduces the old hard-coded "anything but WebP". A
    // target that never said it takes a .dng must not get one by omission.
    expect(planExportChoices({ ...download, bitDepth: 16, destination: 'source' }).formats)
      .toEqual(['png', 'tiff']);
  });

  it('corrects JPEG to TIFF in silence when the depth switches to 16', () => {
    expect(planExportChoices({ ...download, format: 'jpeg', bitDepth: 16 }).format).toBe('tiff');
  });

  it('leaves a format alone that already carries 16 bit', () => {
    expect(planExportChoices({ ...download, format: 'png', bitDepth: 16 }).format).toBe('png');
  });

  it('still corrects WebP to JPEG when the destination is a source', () => {
    const plan = planExportChoices({ ...download, format: 'webp', destination: 'source' });
    expect(plan.format).toBe('jpeg');
    expect(plan.formats).not.toContain('webp');
  });

  it('keeps allowedFormats authoritative at destination source', () => {
    expect(planExportChoices({
      ...download, destination: 'source', allowedSourceFormats: ['jpg', 'png'],
    }).formats).toEqual(['jpeg', 'png']);
  });

  it('leaves only the allowed 16-bit container when the target refuses TIFF', () => {
    const plan = planExportChoices({
      ...download,
      format: 'tiff',
      bitDepth: 16,
      destination: 'source',
      allowedSourceFormats: ['jpg', 'png'],
    });
    expect(plan.formats).toEqual(['png']);
    expect(plan.format).toBe('png');
    expect(plan.bitDepth).toBe(16);
  });

  it('ignores allowedFormats for a download', () => {
    expect(planExportChoices({
      ...download, destination: 'download', allowedSourceFormats: ['jpg'],
    }).formats).toEqual(['jpeg', 'png', 'webp', 'tiff']);
  });

  it('falls back to everything but WebP when a source declares no formats', () => {
    expect(planExportChoices({ ...download, destination: 'source' }).formats)
      .toEqual(['jpeg', 'png', 'tiff']);
  });
});

describe('planExportChoices - dependent controls', () => {
  it('shows compression for the two TIFF containers only', () => {
    expect(planExportChoices({ ...download, format: 'tiff' }).showCompression).toBe(true);
    // DNG is a TIFF and takes the same pair of choices; an uncompressed one is
    // the only kind a reader without zlib can open.
    expect(planExportChoices({ ...download, format: 'dng', bitDepth: 16 }).showCompression)
      .toBe(true);
    expect(planExportChoices({ ...download, format: 'png' }).showCompression).toBe(false);
  });

  it('follows the corrected format, not the requested one', () => {
    // PNG has no uncompressed mode, so a JPEG corrected to PNG must not
    // inherit JPEG's quality slider or gain a compression switch.
    const plan = planExportChoices({
      ...download,
      format: 'jpeg',
      bitDepth: 16,
      destination: 'source',
      allowedSourceFormats: ['jpg', 'png'],
    });
    expect(plan.format).toBe('png');
    expect(plan.showCompression).toBe(false);
    expect(plan.showQuality).toBe(false);
  });

  it('shows quality for the lossy formats only', () => {
    expect(planExportChoices({ ...download, format: 'jpeg' }).showQuality).toBe(true);
    expect(planExportChoices({ ...download, format: 'webp' }).showQuality).toBe(true);
    expect(planExportChoices({ ...download, format: 'tiff' }).showQuality).toBe(false);
    expect(planExportChoices({ ...download, format: 'dng', bitDepth: 16 }).showQuality)
      .toBe(false);
  });
});

const estimate = {
  targets: [{ width: 6000, height: 4000 }],
  format: 'tiff' as const,
  bitDepth: 8 as const,
  tiffCompression: 'none' as const,
  quality: 92,
};

describe('estimateExportBytes', () => {
  it('counts three uncompressed bytes per pixel at 8 bit', () => {
    const bytes = estimateExportBytes(estimate)!;
    expect(bytes).toBeGreaterThan(6000 * 4000 * 3);
    expect(bytes).toBeLessThan(6000 * 4000 * 3 * 1.01);
  });

  it('doubles for 16 bit', () => {
    const eight = estimateExportBytes(estimate)!;
    const sixteen = estimateExportBytes({ ...estimate, bitDepth: 16 })!;
    expect(sixteen / eight).toBeGreaterThan(1.99);
    expect(sixteen / eight).toBeLessThan(2.01);
  });

  it('quarters the file when the long edge is halved - the point of the hint', () => {
    const full = estimateExportBytes({ ...estimate, bitDepth: 16 })!;
    const half = estimateExportBytes({ ...estimate, bitDepth: 16, maxWidth: 3000 })!;
    expect(half / full).toBeGreaterThan(0.24);
    expect(half / full).toBeLessThan(0.26);
  });

  it('never enlarges a source that is already smaller than the limit', () => {
    expect(estimateExportBytes({ ...estimate, maxWidth: 99_000 }))
      .toBe(estimateExportBytes(estimate));
  });

  it('makes Deflate smaller than uncompressed TIFF', () => {
    expect(estimateExportBytes({ ...estimate, tiffCompression: 'deflate' })!)
      .toBeLessThan(estimateExportBytes(estimate)!);
  });

  it('sizes DNG exactly like a 16-bit TIFF, because that is what it is', () => {
    const dng = estimateExportBytes({ ...estimate, format: 'dng', bitDepth: 16 })!;
    const tiff = estimateExportBytes({ ...estimate, format: 'tiff', bitDepth: 16 })!;
    expect(dng).toBe(tiff);
    expect(estimateExportBytes({
      ...estimate, format: 'dng', bitDepth: 16, tiffCompression: 'deflate',
    })!).toBeLessThan(tiff);
  });

  it('ignores the compression choice for PNG, which is always deflated', () => {
    const asNone = estimateExportBytes({ ...estimate, format: 'png' })!;
    const asDeflate = estimateExportBytes({ ...estimate, format: 'png', tiffCompression: 'deflate' })!;
    expect(asNone).toBe(asDeflate);
    expect(asNone).toBeLessThan(estimateExportBytes(estimate)!);
  });

  it('grows with JPEG quality and stays far below an uncompressed TIFF', () => {
    const low = estimateExportBytes({ ...estimate, format: 'jpeg', quality: 40 })!;
    const high = estimateExportBytes({ ...estimate, format: 'jpeg', quality: 95 })!;
    expect(high).toBeGreaterThan(low);
    expect(high).toBeLessThan(estimateExportBytes(estimate)! / 2);
  });

  it('puts WebP below JPEG at the same quality', () => {
    const jpeg = estimateExportBytes({ ...estimate, format: 'jpeg' })!;
    const webp = estimateExportBytes({ ...estimate, format: 'webp' })!;
    expect(webp).toBeLessThan(jpeg);
  });

  it('adds up a batch', () => {
    const one = estimateExportBytes(estimate)!;
    const three = estimateExportBytes({
      ...estimate,
      targets: [{ width: 6000, height: 4000 }, { width: 6000, height: 4000 }, { width: 6000, height: 4000 }],
    })!;
    expect(three).toBe(one * 3);
  });

  it('returns null rather than a made-up number when no size is known', () => {
    expect(estimateExportBytes({ ...estimate, targets: [] })).toBeNull();
    expect(estimateExportBytes({ ...estimate, targets: [{ width: null, height: null }] })).toBeNull();
  });

  it('skips the targets it has no dimensions for', () => {
    const one = estimateExportBytes(estimate)!;
    expect(estimateExportBytes({
      ...estimate, targets: [{ width: 6000, height: 4000 }, { width: null, height: 4000 }],
    })).toBe(one);
  });
});

describe('formatEstimatedBytes', () => {
  it('stays in MB for a single 16-bit frame and reaches GB for a batch', () => {
    expect(formatEstimatedBytes(estimateExportBytes({ ...estimate, bitDepth: 16 })!))
      .toMatch(/^\d+\.\d MB$/);
    expect(formatEstimatedBytes(estimateExportBytes({
      ...estimate,
      bitDepth: 16,
      targets: Array.from({ length: 10 }, () => ({ width: 6000, height: 4000 })),
    })!)).toMatch(/^\d+\.\d{2} GB$/);
  });

  it('keeps the small units readable', () => {
    expect(formatEstimatedBytes(512)).toBe('512 B');
    expect(formatEstimatedBytes(4096)).toBe('4 KB');
  });
});
