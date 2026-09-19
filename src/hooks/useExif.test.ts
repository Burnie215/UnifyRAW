import { describe, expect, it } from 'vitest';
import { exifFromCatalog, normalizeExifTags } from './useExif';
import type { PhotoView } from '../storage/repos';

describe('normalizeExifTags', () => {
  it('normalizes APEX shutter and aperture values', () => {
    const tags = normalizeExifTags({ ShutterSpeedValue: 8, ApertureValue: 5 });
    expect(tags?.ExposureTime).toBeCloseTo(1 / 256, 6);
    expect(tags?.FNumber).toBeCloseTo(5.657, 3);
  });

  it('uses modern ISO and 35mm focal-length fallbacks', () => {
    const tags = normalizeExifTags({ ISOSpeed: 640, FocalLengthIn35mmFormat: 50 });
    expect(tags?.ISO).toBe(640);
    expect(tags?.FocalLength).toBe(50);
  });

  it('prefers the canonical capture tags when both forms exist', () => {
    const tags = normalizeExifTags({
      ExposureTime: 1 / 125,
      ShutterSpeedValue: 8,
      FNumber: 2.8,
      ApertureValue: 5,
      ISO: 200,
      ISOSpeed: 640,
    });
    expect(tags?.ExposureTime).toBe(1 / 125);
    expect(tags?.FNumber).toBe(2.8);
    expect(tags?.ISO).toBe(200);
  });
});

function catalogRow(overrides: Partial<PhotoView> = {}): PhotoView {
  return {
    id: 7, sourceId: 'immich-1', sourcePhotoId: 'asset-7', contentHash: null,
    name: 'DSCF1234.RAF', mimeType: 'image/x-fuji-raf', sizeBytes: 42_000_000,
    dateTaken: 1_700_000_000_000, dateModified: null, sourcePath: null,
    availability: 'online', sourceRevision: 0, indexedAt: 0, updatedAt: 0, deletedAt: null,
    width: 6240, height: 4160, sourceBits: null, camera: 'FUJIFILM X-T4', lens: 'XF23mmF1.4 R',
    iso: 640, focalLength: 23, aperture: 1.4, shutterSpeed: '1/250',
    latitude: 48.1, longitude: 11.6, blurHash: null, stackId: null, stackPosition: null,
    rating: null, flag: null, colorLabel: null, keywords: ['Reise'],
    ...overrides,
  };
}

describe('exifFromCatalog', () => {
  it('maps the catalogue columns onto the metadata panel fields', () => {
    const exif = exifFromCatalog(catalogRow());
    expect(exif.fileName).toBe('DSCF1234.RAF');
    expect(exif.fileSize).toBe(42_000_000);
    expect(exif.dimensions).toEqual({ width: 6240, height: 4160 });
    expect(exif.mimeType).toBe('image/x-fuji-raf');
    expect(exif.model).toBe('FUJIFILM X-T4');
    expect(exif.lens).toBe('XF23mmF1.4 R');
    expect(exif.iso).toBe(640);
    expect(exif.focalLength).toBe(23);
    expect(exif.fNumber).toBe(1.4);
    expect(exif.exposureTime).toBe('1/250');
    expect(exif.dateTime?.getTime()).toBe(1_700_000_000_000);
    expect(exif.latitude).toBe(48.1);
    expect(exif.longitude).toBe(11.6);
    expect(exif.keywords).toEqual(['Reise']);
  });

  it('leaves columns the scan never filled undefined instead of guessing', () => {
    const exif = exifFromCatalog(catalogRow({
      camera: null, lens: null, iso: null, focalLength: null, aperture: null,
      shutterSpeed: null, dateTaken: null, latitude: null, longitude: null,
      keywords: [], sizeBytes: null, width: null, height: null, mimeType: null,
    }));
    expect(exif.model).toBeUndefined();
    expect(exif.lens).toBeUndefined();
    expect(exif.iso).toBeUndefined();
    expect(exif.fNumber).toBeUndefined();
    expect(exif.exposureTime).toBeUndefined();
    expect(exif.dateTime).toBeUndefined();
    expect(exif.keywords).toBeUndefined();
    // The panel still needs these three, so they fall back rather than vanish.
    expect(exif.fileSize).toBe(0);
    expect(exif.dimensions).toEqual({ width: 0, height: 0 });
    expect(exif.mimeType).toBe('unknown');
  });
});
