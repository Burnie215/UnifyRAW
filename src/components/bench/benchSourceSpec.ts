import type { BuilderAdjustments, BuilderSourceSpec } from '../../engine/graph';
import type { LensCoefficients } from '../../engine/lensProfile';
import { getOutputColorSpace } from '../../engine/outputColorSpaces';

export type BenchSourceKind = 'imageBitmap' | 'raw16';

/** Camera calibration a raw16 source needs to reach the right colours. */
export interface BenchCalibration {
  asShotNeutral: [number, number, number] | null;
  colorMatrix: number[] | null;
}

/** What a bound bench source is, over and above its pixels. */
export interface BenchSourceShape {
  kind: BenchSourceKind;
  width: number;
  height: number;
  channels?: 3 | 4;
  calibration?: BenchCalibration;
  /** The camera's base development, or null when this photo has no profile. */
  baseAdjustments?: BuilderAdjustments | null;
  /** The lens correction in force, or null. */
  lensProfile?: LensCoefficients | null;
}

/**
 * The graph source spec for a bound bench source.
 *
 * A RAW must describe itself as `raw16` here, not as a bitmap. The two take
 * different chains - raw16 gets the white-balance and colour-matrix prefix
 * and its own linear block - so calling a RAW a bitmap would render it
 * through the JPEG chain and quietly produce the wrong colours.
 */
export function benchSourceSpec(shape: BenchSourceShape): BuilderSourceSpec {
  const geometry = { width: shape.width, height: shape.height, pixelRatio: 1 };
  const outputColorSpaceId = getOutputColorSpace();
  if (shape.kind === 'raw16') {
    return {
      kind: 'raw16',
      geometry,
      channels: shape.channels ?? 3,
      calibration: shape.calibration ?? { asShotNeutral: null, colorMatrix: null },
      baseAdjustments: shape.baseAdjustments ?? null,
      lensProfile: shape.lensProfile ?? null,
      outputColorSpaceId,
    };
  }
  return { kind: 'imageBitmap', geometry, outputColorSpaceId };
}
