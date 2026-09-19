import path from 'path';
import { describe, expect, it } from 'vitest';
import { smartPreviewFileName } from '@photolib/shared';
import { isStalePreviewFile, smartPreviewPath } from './smartPreviewPaths';

describe('backend smart-preview slots (F015, F038)', () => {
  it('names its disk slot exactly like the browser names its OPFS copy', () => {
    for (const size of [1200, 1800, 2540, 8000]) {
      expect(path.basename(smartPreviewPath('k', size))).toBe(smartPreviewFileName('k', size, 'tiff'));
    }
  });

  it('keeps v6 for previews and moves full-size requests to v7', () => {
    expect(smartPreviewPath('k', 1200).endsWith('k_1200_v6.tiff')).toBe(true);
    expect(smartPreviewPath('k', 2540).endsWith('k_2540_v6.tiff')).toBe(true);
    expect(smartPreviewPath('k_native', 8000).endsWith('k_native_8000_v7.tiff')).toBe(true);
  });

  it.each([
    ['k_native_8000_v6.tiff', true],
    ['k_1200_v5.tiff', true],
    ['k_1200_v6.tiff', false],
    ['k_native_8000_v7.tiff', false],
    ['k_1200_v6.tiff.tmp', false],
    ['k_1200_v5.jpg', false],
    ['thumb.jpg', false],
  ])('treats %s as outdated: %s', (name, stale) => {
    expect(isStalePreviewFile(name)).toBe(stale);
  });
});
