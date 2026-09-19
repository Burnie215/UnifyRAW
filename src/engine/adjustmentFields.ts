import type { Adjustments } from '../types';

/** The single ownership table for editor panels, resets and partial presets. */
export const ADJUSTMENT_PANEL_FIELDS = {
  basic: ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'],
  whitebalance: ['temperature', 'tint'],
  presence: ['texture', 'clarity', 'dehaze', 'vibrance', 'saturation'],
  tonecurve: ['toneCurve', 'toneCurveSpace'],
  levels: ['levels'],
  hsl: [
    'hsl', 'hslSpace', 'colorEditorMode', 'advancedSectors',
    'skinToneSector', 'skinToneSectors', 'skinToneUniformity',
  ],
  colorgrading: ['colorGrading', 'colorGradingSpace'],
  bw: ['bwEnabled', 'bwMix'],
  detail: [
    'sharpness', 'sharpenRadius', 'sharpenMasking', 'noiseReduction',
    'denoiseLuma', 'denoiseChroma', 'denoiseDetail',
    'aiDenoiseEnabled', 'aiDenoiseStrength', 'aiDenoiseModelId',
  ],
  effects: ['vignette', 'vignetteFeather', 'grain', 'grainSize'],
  transform: [
    'rotation', 'perspectiveV', 'perspectiveH', 'distortion',
    'cropAspect', 'flipH', 'flipV',
    'lensCorrection', 'lensCorrectionProfile', 'lensCorrectionStrength',
  ],
} as const satisfies Record<string, readonly (keyof Adjustments)[]>;

export type AdjustmentPanelId = keyof typeof ADJUSTMENT_PANEL_FIELDS;

/** Select the fields owned by the requested panels when saving a partial preset. */
export function adjustmentsForPanels(
  adjustments: Adjustments,
  panels?: readonly string[],
): Partial<Adjustments> {
  if (!panels || panels.length === Object.keys(ADJUSTMENT_PANEL_FIELDS).length) return adjustments;
  const selected: Partial<Adjustments> = {};
  for (const panel of panels) {
    for (const field of ADJUSTMENT_PANEL_FIELDS[panel as AdjustmentPanelId] ?? []) {
      (selected as Record<string, unknown>)[field] = adjustments[field];
    }
  }
  return selected;
}
