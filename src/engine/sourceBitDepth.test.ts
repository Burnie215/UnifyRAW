import { describe, expect, it } from 'vitest';
import { canExportAllAt16Bit, maxExportDepth, needsSourceBitsProbe } from './sourceBitDepth';

describe('maxExportDepth', () => {
  it.each(['photo.CR3', 'negative.dng', 'scan.RAF'])('%s is 16-bit through the RAW classifier', (name) => {
    expect(maxExportDepth({ name })).toBe(16);
  });

  it.each(['photo.jpg', 'photo.JPEG', 'photo.png', 'photo.webp'])('%s remains 8-bit', (name) => {
    expect(maxExportDepth({ name })).toBe(8);
    expect(maxExportDepth({ name, sourceBits: 12 })).toBe(8);
  });

  it('uses the conservative HEIF-family fallback only before a probe', () => {
    expect(maxExportDepth({ name: 'photo.heic', sourceBits: null })).toBe(16);
    expect(maxExportDepth({ name: 'photo.HEIF' })).toBe(16);
    expect(maxExportDepth({ name: 'sony.HIF' })).toBe(16);
    expect(maxExportDepth({ name: 'arbitrary.tif' })).toBe(8);
  });

  it.each([1, 8])('locks a probed %i-bit HEIF to 8-bit export', (sourceBits) => {
    expect(maxExportDepth({ name: 'photo.heic', sourceBits })).toBe(8);
  });

  it.each([10, 12, 16])('allows a probed %i-bit HEIF to export at 16 bits', (sourceBits) => {
    expect(maxExportDepth({ name: 'photo.heif', sourceBits })).toBe(16);
  });

  it('safe-defaults invalid precision and unknown file types', () => {
    expect(maxExportDepth({ name: 'photo.bin', sourceBits: 0 })).toBe(8);
    expect(maxExportDepth({ name: 'photo.bin', sourceBits: 17 })).toBe(8);
    expect(maxExportDepth({ name: 'photo.bin' })).toBe(8);
  });
});

describe('canExportAllAt16Bit', () => {
  it('requires every batch source to support 16-bit output', () => {
    expect(canExportAllAt16Bit([{ name: 'a.nef' }, { name: 'b.heic', sourceBits: 10 }])).toBe(true);
    expect(canExportAllAt16Bit([{ name: 'a.nef' }, { name: 'b.jpg' }])).toBe(false);
    expect(canExportAllAt16Bit([])).toBe(false);
  });
});

describe('needsSourceBitsProbe', () => {
  it.each(['photo.heic', 'photo.HEIF', 'sony.hif'])('%s is worth one read while unprobed', (name) => {
    expect(needsSourceBitsProbe({ name })).toBe(true);
    expect(needsSourceBitsProbe({ name, sourceBits: null })).toBe(true);
  });

  it('stops asking once a read recorded something, 0 included', () => {
    expect(needsSourceBitsProbe({ name: 'photo.heic', sourceBits: 10 })).toBe(false);
    // 0 is the mark of a read that came back empty. Without it the same file
    // would be fetched again on every pass and every editor open.
    expect(needsSourceBitsProbe({ name: 'photo.heic', sourceBits: 0 })).toBe(false);
  });

  it.each(['photo.jpg', 'photo.CR3', 'photo.png'])('never reads %s for its depth', (name) => {
    expect(needsSourceBitsProbe({ name })).toBe(false);
  });
});

describe('the export gate a mixed selection gets', () => {
  it('withholds 16 bit as soon as one probed 8-bit HEIC is in the batch', () => {
    const eightBitHeic = { name: 'b.heic', sourceBits: 8 };
    expect(maxExportDepth(eightBitHeic)).toBe(8);
    expect(canExportAllAt16Bit([{ name: 'a.heic', sourceBits: 12 }, eightBitHeic])).toBe(false);
  });
});
