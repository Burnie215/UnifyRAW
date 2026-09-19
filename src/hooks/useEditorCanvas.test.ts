import { describe, expect, it } from 'vitest';
import { sameRaw16Load, takesRaw16Path, type Raw16Load } from './useEditorCanvas';
import type { RawPixelData } from '../engine/raw/RawDecoderStrategy';
import type { BuilderAdjustments } from '../engine/graph';
import type { LensCoefficients } from '../engine/lensProfile';

const pixels = (bits: 8 | 16): RawPixelData => ({
  data: bits === 16 ? new Uint16Array(3) : new Uint8Array(3), width: 1, height: 1, channels: 3, bits,
});
const base = () => ({}) as BuilderAdjustments;
const lens = () => ({ k1: 0, k2: 0, k3: 0, v1: 0, v2: 0, v3: 0, caR: 0, caB: 0 }) as LensCoefficients;

describe('takesRaw16Path', () => {
  it('takes 16-bit pixels on an HDR-capable pipeline, nothing else', () => {
    expect(takesRaw16Path(pixels(16), true)).toBe(true);
    expect(takesRaw16Path(pixels(16), false)).toBe(false);
    expect(takesRaw16Path(pixels(8), true)).toBe(false);
    expect(takesRaw16Path(null, true)).toBe(false);
    expect(takesRaw16Path(undefined, true)).toBe(false);
  });
});

describe('sameRaw16Load', () => {
  const loaded: Raw16Load = { pixels: pixels(16), base: base(), lens: lens(), photoId: 7 };

  it('is the same load only when pixels, base, lens and photo are all the same objects', () => {
    expect(sameRaw16Load(loaded, { ...loaded })).toBe(true);
    expect(sameRaw16Load(null, loaded)).toBe(false);
    expect(sameRaw16Load(loaded, { ...loaded, pixels: pixels(16) })).toBe(false);
    expect(sameRaw16Load(loaded, { ...loaded, base: base() })).toBe(false);
    expect(sameRaw16Load(loaded, { ...loaded, base: null })).toBe(false);
    expect(sameRaw16Load(loaded, { ...loaded, lens: lens() })).toBe(false);
    expect(sameRaw16Load(loaded, { ...loaded, photoId: 8 })).toBe(false);
  });
});
