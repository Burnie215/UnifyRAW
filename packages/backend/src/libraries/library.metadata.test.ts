import { describe, expect, it } from 'vitest';
import { metadataFromExifToolRecord } from './library.scanner.js';

describe('library EXIF metadata normalization', () => {
  it('maps regular capture settings', () => {
    expect(metadataFromExifToolRecord({
      Make: 'FUJIFILM', Model: 'X-T5', LensModel: 'XF33mmF1.4 R LM WR',
      ISO: 800, FNumber: 2.8, ExposureTime: 1 / 250, FocalLength: 33,
    })).toEqual({
      camera: 'FUJIFILM X-T5', lens: 'XF33mmF1.4 R LM WR', iso: 800,
      focalLength: 33, aperture: 2.8, shutterSpeed: '1/250',
    });
  });

  it('supports APEX and modern ISO fallback tags', () => {
    const metadata = metadataFromExifToolRecord({
      Model: 'Camera', ISOSpeed: 640, ApertureValue: 5, ShutterSpeedValue: 8,
      FocalLengthIn35mmFormat: 50,
    });
    expect(metadata.iso).toBe(640);
    expect(metadata.aperture).toBe(5.7);
    expect(metadata.shutterSpeed).toBe('1/256');
    expect(metadata.focalLength).toBe(50);
  });
});
