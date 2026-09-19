/**
 * The one thing the bench must not get wrong about a RAW.
 *
 * raw16 and imageBitmap take different chains: raw16 gets the WhiteBalanceRaw
 * + ColorMatrix prefix and skips the additive SDR white balance, because its
 * temperature and tint are multiplicative sensor gains. Describing a RAW as a
 * bitmap compiles and renders perfectly happily - and produces the wrong
 * colours, silently. So the spec a bound source hands to the graph builder is
 * asserted here rather than left to the eye.
 */
import { describe, expect, it } from 'vitest';
import { benchSourceSpec } from './benchSourceSpec';
import { chainKindsForSource } from '../../engine/graph';

const CALIBRATION = {
  asShotNeutral: [2.1, 1, 1.6] as [number, number, number],
  colorMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
};

describe('benchSourceSpec', () => {
  it('describes a RAW tile as raw16 and carries its calibration', () => {
    const spec = benchSourceSpec({
      kind: 'raw16', width: 500, height: 333, channels: 3, calibration: CALIBRATION,
    });

    expect(spec.kind).toBe('raw16');
    expect(spec.geometry).toEqual({ width: 500, height: 333, pixelRatio: 1 });
    if (spec.kind !== 'raw16') throw new Error('unreachable');
    expect(spec.channels).toBe(3);
    expect(spec.calibration).toEqual(CALIBRATION);
  });

  it('puts a RAW through the sensor chain and a JPEG through the display one', () => {
    const raw = chainKindsForSource(benchSourceSpec({
      kind: 'raw16', width: 500, height: 333, channels: 3, calibration: CALIBRATION,
    }));
    const jpeg = chainKindsForSource(benchSourceSpec({
      kind: 'imageBitmap', width: 500, height: 333,
    }));

    expect(raw).toContain('whiteBalanceRaw');
    expect(raw).toContain('colorMatrix');
    expect(jpeg).not.toContain('whiteBalanceRaw');
    expect(jpeg).not.toContain('colorMatrix');
    // The additive SDR white balance would apply the tint a second time.
    expect(raw).not.toContain('whiteBalance');
    expect(jpeg).toContain('whiteBalance');
  });

  it('falls back to neutral calibration rather than dropping the raw16 kind', () => {
    const spec = benchSourceSpec({ kind: 'raw16', width: 10, height: 10 });
    expect(spec.kind).toBe('raw16');
    if (spec.kind !== 'raw16') throw new Error('unreachable');
    expect(spec.channels).toBe(3);
    expect(spec.calibration).toEqual({ asShotNeutral: null, colorMatrix: null });
  });
});
