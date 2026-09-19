import { describe, expect, it } from 'vitest';
import type { PhotoView } from '../storage/repos';
import { needsExifBackfill } from './exifBackfillPolicy';

const NOTHING_SCANNED: ReadonlySet<number> = new Set();

function photo(metadata: Partial<PhotoView> = {}): PhotoView {
  return {
    id: 7,
    camera: null,
    lens: null,
    iso: null,
    aperture: null,
    shutterSpeed: null,
    focalLength: null,
    ...metadata,
  } as PhotoView;
}

describe('needsExifBackfill', () => {
  it('selects new local photos whose metadata columns are null', () => {
    expect(needsExifBackfill(photo(), NOTHING_SCANNED)).toBe(true);
  });

  it('does not reprocess photos that already have capture metadata', () => {
    expect(needsExifBackfill(photo({ iso: 400 }), NOTHING_SCANNED)).toBe(false);
    expect(needsExifBackfill(photo({ aperture: 2.8 }), NOTHING_SCANNED)).toBe(false);
  });

  it('does not read a file this device has already scanned, empty as its columns are', () => {
    expect(needsExifBackfill(photo(), new Set([7]))).toBe(false);
    expect(needsExifBackfill(photo(), new Set([8]))).toBe(true);
  });
});
