import { describe, expect, it } from 'vitest';
import {
  SMART_PREVIEW_HALF_SIZE_MAX_PX,
  SMART_PREVIEW_MAX_PX,
  isCurrentSmartPreviewSlot,
  parseSmartPreviewFileName,
  smartPreviewFileName,
  smartPreviewVersion,
} from './smart-preview';

describe('smart-preview slot names (F038)', () => {
  it('keeps v6 up to the half-size limit and v7 above it', () => {
    expect(smartPreviewVersion(1200)).toBe('v6');
    expect(smartPreviewVersion(SMART_PREVIEW_HALF_SIZE_MAX_PX)).toBe('v6');
    expect(smartPreviewVersion(SMART_PREVIEW_HALF_SIZE_MAX_PX + 1)).toBe('v7');
    expect(smartPreviewVersion(8000)).toBe('v7');
  });

  it('names a slot key_size_version.ext', () => {
    expect(smartPreviewFileName('k', 1200, 'tiff')).toBe('k_1200_v6.tiff');
    expect(smartPreviewFileName('k', 1800, 'jpg')).toBe('k_1800_v6.jpg');
    expect(smartPreviewFileName('k_native', 8000, 'tiff')).toBe('k_native_8000_v7.tiff');
  });

  it('parses its own names back, including keys with underscores and digits', () => {
    const key = 'src_1_IMG_0042_abc12';
    expect(parseSmartPreviewFileName(smartPreviewFileName(key, 2540, 'tiff')))
      .toEqual({ key, size: 2540, version: 'v6', ext: 'tiff' });
    expect(parseSmartPreviewFileName('thumb.jpg')).toBeNull();
    expect(parseSmartPreviewFileName('k_1200_v6.tiff.crswap')).toBeNull();
  });

  it.each([
    ['k_1200_v5.tiff', false],
    ['k_1200_v6.tiff', true],
    ['k_1200_v6.jpg', true],
    ['k_native_8000_v6.tiff', false],
    ['k_native_8000_v7.tiff', true],
  ])('treats %s as current: %s', (name, current) => {
    expect(isCurrentSmartPreviewSlot(parseSmartPreviewFileName(name)!)).toBe(current);
  });
});

/**
 * The backend clamps every `size=` to this and the export asks for exactly it
 * when it wants native pixels. Both used to spell 8000 for themselves, so the
 * frontend's "bigger than any realistic camera" could drift away from the
 * server's answer without anything noticing. The absolute number is the point
 * of the assertion.
 */
describe('SMART_PREVIEW_MAX_PX', () => {
  it('is the 8000 px ceiling both sides have to mean', () => {
    expect(SMART_PREVIEW_MAX_PX).toBe(8000);
  });

  it('sits above the half-size limit, so a native request decodes at full size', () => {
    expect(SMART_PREVIEW_MAX_PX).toBeGreaterThan(SMART_PREVIEW_HALF_SIZE_MAX_PX);
    expect(smartPreviewVersion(SMART_PREVIEW_MAX_PX)).toBe('v7');
  });
});
