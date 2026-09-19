/**
 * Lens profile resolution.
 *
 * The pass this feeds has existed and never run: nine approximated foreign
 * lenses in a table nothing consults, behind a flag no UI sets. These tests
 * pin the two things that make it run at all - that a measured profile is
 * found for a photo, and that it beats the approximation.
 */
import { describe, expect, it } from 'vitest';
import {
  normaliseLensKey,
  resolveLensCoefficients,
  selectMeasuredLensProfile,
  type MeasuredLensProfile,
} from './lensProfile';

function profile(p: Partial<MeasuredLensProfile> & Pick<MeasuredLensProfile, 'key'>): MeasuredLensProfile {
  return {
    syncId: `${p.key}:${p.focalFrom ?? ''}`,
    name: 'p',
    focalFrom: null, focalTo: null,
    k1: -0.02, k2: 0.01, k3: 0, v1: 1, v2: -0.5, v3: 0.2, caR: 0.0002, caB: -0.0002,
    updatedAt: 1,
    ...p,
  };
}

describe('normaliseLensKey', () => {
  it('folds every way one lens gets written into one key', () => {
    const spellings = ['EF 24-70mm f/2.8L', 'EF24-70mm F2.8 L', 'ef 24-70 mm f2.8l'];
    const keys = new Set(spellings.map(normaliseLensKey));
    expect(keys.size).toBe(1);
  });

  it('keeps two different lenses apart', () => {
    expect(normaliseLensKey('XF 35mm F1.4 R')).not.toBe(normaliseLensKey('XF 56mm F1.2 R'));
  });

  it('treats a missing lens as no key', () => {
    expect(normaliseLensKey(null)).toBe('');
    expect(normaliseLensKey('  ')).toBe('');
  });
});

describe('selectMeasuredLensProfile', () => {
  // Keys always come out of the normaliser - writing one by hand is how a
  // profile ends up matching nothing.
  const KEY = normaliseLensKey('EF 24-70mm f/2.8L');
  const wide = profile({ key: KEY, focalFrom: 24, focalTo: 70, syncId: 'wide' });
  const at24 = profile({ key: KEY, focalFrom: 24, focalTo: 24, syncId: 'at24' });
  const subject = { lens: 'EF 24-70mm f/2.8L', focalLength: 24 };

  it('prefers the narrower band, because it says more about this frame', () => {
    expect(selectMeasuredLensProfile([wide, at24], subject)).toBe(at24);
    expect(selectMeasuredLensProfile([at24, wide], subject)).toBe(at24);
  });

  it('falls back to the wider band outside the narrow one', () => {
    expect(selectMeasuredLensProfile([wide, at24], { ...subject, focalLength: 50 })).toBe(wide);
  });

  it('does not reach past the band it was measured for', () => {
    expect(selectMeasuredLensProfile([at24], { ...subject, focalLength: 200 })).toBeNull();
  });

  it('needs a lens name at all', () => {
    expect(selectMeasuredLensProfile([wide], { lens: null, focalLength: 24 })).toBeNull();
  });

  it('applies an unbounded profile at any focal length, even an unknown one', () => {
    const any = profile({ key: normaliseLensKey('XF 35mm F1.4 R') });
    expect(selectMeasuredLensProfile([any], { lens: 'XF 35mm F1.4 R', focalLength: null })).toBe(any);
  });
});

describe('resolveLensCoefficients', () => {
  it('lets a measurement beat the built-in approximation', () => {
    const measured = profile({ key: normaliseLensKey('XF 35mm F1.4 R'), k1: -0.5 });
    const got = resolveLensCoefficients([measured], { lens: 'XF 35mm F1.4 R', focalLength: 35 });
    expect(got).toMatchObject({ source: 'measured' });
    expect(got!.coefficients.k1).toBe(-0.5);
  });

  it('still uses the built-in table when nothing was measured', () => {
    const got = resolveLensCoefficients([], { lens: 'XF 35mm F1.4 R', focalLength: 35 });
    expect(got).toMatchObject({ source: 'builtin' });
    expect(got!.coefficients.k1).toBeLessThan(0);
  });

  it('returns null for an unknown lens rather than a neutral correction', () => {
    // Null keeps the pass disabled; a neutral set would run a full resample
    // to change nothing.
    expect(resolveLensCoefficients([], { lens: 'Some Unknown 12mm', focalLength: 12 })).toBeNull();
    expect(resolveLensCoefficients([], { lens: null, focalLength: null })).toBeNull();
  });

  it('interpolates a built-in zoom entry instead of using one end of it', () => {
    const wideEnd = resolveLensCoefficients([], { lens: 'EF 24-70mm f/2.8L', focalLength: 24 });
    const teleEnd = resolveLensCoefficients([], { lens: 'EF 24-70mm f/2.8L', focalLength: 70 });
    expect(Math.abs(teleEnd!.coefficients.k1)).toBeLessThan(Math.abs(wideEnd!.coefficients.k1));
  });
});
