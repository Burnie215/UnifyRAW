/**
 * The one scale table between UnifyRAW's `Adjustments` and Adobe's `crs:`
 * attributes. The XMP export (xmp.ts) and the Lightroom preset import
 * (lightroomPreset.ts) both take their numbers from here; no transfer factor
 * lives anywhere else.
 *
 * The factors come from the import calibration run, not from Adobe
 * documentation: the round trip through this table is exact, the look in
 * Lightroom stays an approximation.
 */

import type { Adjustments } from '../types';

/** Adobe writes at most two decimals and the import has always rounded to two.
 * One rounding rule on both sides is what keeps the round trip exact. */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value * 100) / 100));
}

export const HSL_SCALE = 0.8;
export const COLOR_GRADE_SCALE = { saturation: 0.75, lumAdj: 0.6 } as const;
export const CURVE_CALIBRATION = 0.72;

/** Lightroom stores absolute Kelvin, UnifyRAW's slider is relative to the
 * decoded camera white balance. This bounded affine approximation preserves
 * the intended warm/cool direction without pretending the models are equal. */
const KELVIN_BASE = 5500;
const KELVIN_PER_STEP = 35;
const KELVIN_MIN = 2000;
const KELVIN_MAX = 50000;

export interface CrsField {
  key: keyof Adjustments;
  crs: string;
  /** Adjustments value -> crs attribute value */
  toCrs(value: number): number;
  /** crs attribute value -> Adjustments value */
  fromCrs(value: number): number;
  crsMin: number;
  crsMax: number;
}

function scaled(
  key: keyof Adjustments,
  crs: string,
  factor: number,
  min: number,
  max: number,
): CrsField {
  return {
    key,
    crs,
    toCrs: (value) => clamp(value / factor, min / factor, max / factor),
    fromCrs: (value) => clamp(value * factor, min, max),
    crsMin: min / factor,
    crsMax: max / factor,
  };
}

export const CRS_FIELDS: readonly CrsField[] = [
  scaled('exposure', 'Exposure2012', 50, -100, 100),
  // Adobe and PhotoLib use different tone operators. These empirically safe
  // transfer factors retain the look without multiplying Lightroom's slider
  // values into clipped shadows/highlights in PhotoLib's linear pipeline.
  scaled('contrast', 'Contrast2012', 0.65, -100, 100),
  scaled('highlights', 'Highlights2012', 0.65, -100, 100),
  scaled('shadows', 'Shadows2012', 0.65, -100, 100),
  scaled('whites', 'Whites2012', 0.55, -100, 100),
  scaled('blacks', 'Blacks2012', 0.55, -100, 100),
  scaled('clarity', 'Clarity2012', 0.7, -100, 100),
  scaled('texture', 'Texture', 0.7, -100, 100),
  scaled('dehaze', 'Dehaze', 0.7, -100, 100),
  scaled('vibrance', 'Vibrance', 0.8, -100, 100),
  scaled('saturation', 'Saturation', 0.8, -100, 100),
  {
    key: 'temperature',
    crs: 'Temperature',
    toCrs: (value) => clamp(Math.round(KELVIN_BASE + KELVIN_PER_STEP * value), KELVIN_MIN, KELVIN_MAX),
    fromCrs: (value) => clamp((value - KELVIN_BASE) / KELVIN_PER_STEP, -100, 100),
    crsMin: KELVIN_MIN,
    crsMax: KELVIN_MAX,
  },
  scaled('tint', 'Tint', 1, -100, 100),
  scaled('sharpness', 'Sharpness', 1, 0, 100),
  scaled('sharpenRadius', 'SharpenRadius', 1, 0.5, 3),
  scaled('sharpenMasking', 'SharpenEdgeMasking', 1, 0, 100),
  scaled('noiseReduction', 'LuminanceSmoothing', 1, 0, 100),
  scaled('vignette', 'PostCropVignetteAmount', 0.75, -100, 100),
  scaled('vignetteFeather', 'PostCropVignetteFeather', 1, 0, 100),
  scaled('grain', 'GrainAmount', 0.8, 0, 100),
  scaled('grainSize', 'GrainSize', 1, 1, 100),
  scaled('rotation', 'CropAngle', 1, -45, 45),
];

/** Exactly the fields the one-time repair for pre-calibration imports
 * rescales (`calibrateLegacyLightroomAdjustments`). Exposure is not among
 * them: it carried a factor before the calibration run. */
export const LEGACY_CALIBRATION_KEYS: readonly (keyof Adjustments)[] = [
  'contrast', 'highlights', 'shadows',
  'whites', 'blacks',
  'clarity', 'texture', 'dehaze',
  'vibrance', 'saturation',
  'vignette', 'grain',
];
