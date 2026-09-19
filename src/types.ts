export interface Adjustments {
  // Basic
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;

  // Impact ('Wirkung'): micro-contrast and colour intensity together. The
  // group is not split because dehaze and brilliance move both.
  clarity: number;
  texture: number;
  dehaze: number;
  vibrance: number;
  saturation: number;

  // White Balance
  temperature: number;
  tint: number;

  // Tone Curve — per channel, flexible control points (x,y) normalized 0..1
  toneCurve: ToneCurveAdjustment;

  // Levels (Tonwerte) — per channel or RGB
  levels: LevelsAdjustment;

  // HSL — per channel (-100..100)
  hsl: HSLAdjustments;

  // Color Editor — Advanced sectors + Skin Tone data
  colorEditorMode: 'basic' | 'advanced' | 'skin-tone';
  advancedSectors: ColorEditorSector[];
  skinToneSector: ColorEditorSector;
  skinToneSectors: ColorEditorSector[];
  skinToneUniformity: { hue: number; saturation: number; luminance: number };

  // Color Grading
  colorGrading: ColorGrading;

  // Detail
  sharpness: number;
  sharpenRadius: number;
  sharpenMasking: number;
  noiseReduction: number;
  // Denoise (YCbCr bilateral; phase 1 of DENOISE_PLAN)
  denoiseLuma: number;     // 0..100
  denoiseChroma: number;   // 0..100
  denoiseDetail: number;   // 0..100 — edge-preservation in luma (higher = preserve more)
  // AI denoise (phase 3 of DENOISE_PLAN). Mixes a pre-computed clean
  // preview (uploaded to the pipeline via setCleanPreview) with the
  // original source as the FIRST pipeline pass. Strength 0 or no
  // uploaded clean preview = pass is skipped.
  aiDenoiseEnabled: boolean;
  aiDenoiseStrength: number;   // 0..100 (mix amount)
  aiDenoiseModelId: string;    // registry key, e.g. 'scunet-psnr'

  // Black & White
  bwEnabled: boolean;
  bwMix: {
    red: number; orange: number; yellow: number; green: number;
    aqua: number; blue: number; purple: number; magenta: number;
  };

  // Effects
  vignette: number;
  vignetteFeather: number;
  grain: number;
  grainSize: number;

  // Lens Correction
  lensCorrection: boolean;
  lensCorrectionProfile: string | null;  // profile ID or null for manual
  lensCorrectionStrength: number;        // 0-100, default 100

  // Transform
  rotation: number;
  perspectiveV: number;    // Vertical perspective -100..100
  perspectiveH: number;    // Horizontal perspective -100..100
  distortion: number;      // Barrel/pincushion -100..100
  cropAspect: CropAspect;
  flipH: boolean;
  flipV: boolean;

  // Phase 3 per-pass color-space overrides. `undefined` = use the kind's
  // graph default (Phase 2 = linear). Setting to 'gamma' makes the pass
  // run in display-encoded space — a common artistic choice for ToneCurve
  // (crushed-blacks aesthetic) and ColorGrading (Resolve-style gamma look).
  toneCurveSpace?: 'linear' | 'gamma';
  colorGradingSpace?: 'linear' | 'gamma';
  hslSpace?: 'linear' | 'gamma';
}

/**
 * Lens CORRECTION describes the glass in front of the sensor, not a look, so
 * it never travels in a preset: it is neither captured from the photo a preset
 * was made on nor pushed onto the photo it is applied to. Its designerly
 * neighbours (`distortion`, `vignette`, `vignetteFeather`) are a look and do
 * travel - expressly so a distortion or vignette can be set on purpose that
 * the correction has just taken out.
 */
export const LENS_CORRECTION_FIELDS = [
  'lensCorrection', 'lensCorrectionProfile', 'lensCorrectionStrength',
] as const;

/** A copy without the glass correction. Partial on the way out: the three
 *  fields are gone, so the caller may not go on treating them as present. */
export function withoutLensCorrection(adjustments: Partial<Adjustments>): Partial<Adjustments> {
  const out: Partial<Adjustments> = { ...adjustments };
  for (const field of LENS_CORRECTION_FIELDS) {
    delete (out as Record<string, unknown>)[field];
  }
  return out;
}

export interface CurvePoint {
  x: number;
  y: number;
}

export interface CurvePoints {
  shadows: CurvePoint;
  darks: CurvePoint;
  lights: CurvePoint;
  highlights: CurvePoint;
}

export type ToneCurveChannel = 'rgb' | 'luma' | 'red' | 'green' | 'blue';

export interface ToneCurveAdjustment {
  rgb: CurvePoint[];
  luma: CurvePoint[];
  red: CurvePoint[];
  green: CurvePoint[];
  blue: CurvePoint[];
}

/** Levels for a single channel */
export interface ChannelLevels {
  inBlack: number;   // 0-255, input black point
  inWhite: number;   // 0-255, input white point
  gamma: number;     // 0.1-10, midtone gamma (1 = neutral)
  outBlack: number;  // 0-255, output black point
  outWhite: number;  // 0-255, output white point
}

/** Color Editor sector (shared between Advanced and Skin Tone modes) */
export interface ColorEditorSector {
  id: string;
  hueCenter: number;
  hueHalfWidth: number;
  satMin: number;
  satMax: number;
  feather: number;
  pickRelHue: number;
  pickRelSat: number;
  selLightness: number;
  dH: number;
  dS: number;
  dL: number;
  enabled: boolean;
}

export type LevelsChannel = 'rgb' | 'red' | 'green' | 'blue';

export interface LevelsAdjustment {
  rgb: ChannelLevels;
  red: ChannelLevels;
  green: ChannelLevels;
  blue: ChannelLevels;
}

export type HSLChannel = 'red' | 'orange' | 'yellow' | 'green' | 'aqua' | 'blue' | 'purple' | 'magenta';

export type HSLAdjustments = {
  [K in HSLChannel]: { hue: number; saturation: number; luminance: number };
};

/** Advanced Color Editor — custom color range (2D: Hue × Saturation) */
export interface ColorRange {
  id: string;
  hueCenter: number;       // 0-360
  hueWidth: number;         // degrees half-width at outer edge
  hueWidthInner: number;    // degrees half-width at inner edge (narrower = trapezoid)
  satMin: number;           // 0-100, inner boundary (distance from center)
  satMax: number;           // 0-100, outer boundary
  feather: number;          // 1-30 (smoothness/falloff at boundaries)
  hue: number;              // ΔH shift
  saturation: number;       // ΔS shift
  luminance: number;        // ΔL shift
  enabled: boolean;
}

/** Skin Tone uniformity values */
export interface SkinToneUniformity {
  hue: number;              // 0-100
  saturation: number;       // 0-100
  luminance: number;        // 0-100
}

export interface ColorGradingZone {
  hue: number;
  saturation: number;
  /** Arc slider: zone saturation adjustment (-100..100) */
  satAdj: number;
  /** Arc slider: zone lightness adjustment (-100..100) */
  lumAdj: number;
}

export interface ColorGrading {
  shadows: ColorGradingZone;
  midtones: ColorGradingZone;
  highlights: ColorGradingZone;
  blending: number;
  balance: number;
}

export type CropAspect = 'free' | '1:1' | '4:3' | '3:2' | '16:9' | '5:4';

const defaultHSLChannel = { hue: 0, saturation: 0, luminance: 0 };
const defaultColorZone: ColorGradingZone = { hue: 0, saturation: 0, satAdj: 0, lumAdj: 0 };
const defaultChannelLevels: ChannelLevels = { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 };

export const defaultAdjustments: Adjustments = {
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,

  clarity: 0,
  texture: 0,
  dehaze: 0,
  vibrance: 0,
  saturation: 0,

  temperature: 0,
  tint: 0,

  toneCurve: {
    rgb:   [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    luma:  [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    red:   [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    green: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    blue:  [{ x: 0, y: 0 }, { x: 1, y: 1 }],
  },

  levels: {
    rgb: { ...defaultChannelLevels },
    red: { ...defaultChannelLevels },
    green: { ...defaultChannelLevels },
    blue: { ...defaultChannelLevels },
  },

  hsl: {
    red: { ...defaultHSLChannel },
    orange: { ...defaultHSLChannel },
    yellow: { ...defaultHSLChannel },
    green: { ...defaultHSLChannel },
    aqua: { ...defaultHSLChannel },
    blue: { ...defaultHSLChannel },
    purple: { ...defaultHSLChannel },
    magenta: { ...defaultHSLChannel },
  },

  colorEditorMode: 'basic',
  advancedSectors: [],
  skinToneSector: {
    id: 'skin-default', hueCenter: 25, hueHalfWidth: 20,
    satMin: 20, satMax: 60, feather: 12,
    pickRelHue: 0.5, pickRelSat: 0.5, selLightness: 0,
    dH: 0, dS: 0, dL: 0, enabled: true,
  },
  skinToneSectors: [],
  skinToneUniformity: { hue: 0, saturation: 0, luminance: 0 },

  colorGrading: {
    shadows: { ...defaultColorZone },
    midtones: { ...defaultColorZone },
    highlights: { ...defaultColorZone },
    blending: 50,
    balance: 0,
  },

  sharpness: 0,
  sharpenRadius: 1.0,
  sharpenMasking: 0,
  noiseReduction: 0,
  denoiseLuma: 0,
  denoiseChroma: 0,
  denoiseDetail: 50,
  aiDenoiseEnabled: false,
  aiDenoiseStrength: 100,
  aiDenoiseModelId: 'scunet-psnr',

  bwEnabled: false,
  bwMix: { red: 0, orange: 0, yellow: 0, green: 0, aqua: 0, blue: 0, purple: 0, magenta: 0 },

  vignette: 0,
  vignetteFeather: 50,
  grain: 0,
  grainSize: 25,

  lensCorrection: false,
  lensCorrectionProfile: null,
  lensCorrectionStrength: 100,

  rotation: 0,
  perspectiveV: 0,
  perspectiveH: 0,
  distortion: 0,
  cropAspect: 'free',
  flipH: false,
  flipV: false,
};

export type ViewMode = 'grid' | 'editor';

export type LibraryViewMode = 'grid' | 'loupe' | 'compare' | 'survey';

export type GridMode = 'tiles' | 'list' | 'gallery' | 'timeline';

export type GroupMode = 'none' | 'folder' | 'folder-grid' | 'folder-stack';

/**
 * How the tile grid uses the width it has.
 * - `left`   columns at their exact size, leftover space collects on the right
 * - `center` same columns, leftover space split evenly on both sides
 * - `fill`   columns stretched to consume the width, so the size steps between
 *            whole column counts instead of moving continuously
 */
export type GridFlow = 'left' | 'center' | 'fill';

export type SortOption =
  | 'name-asc' | 'name-desc'
  | 'date-newest' | 'date-oldest'
  | 'rating-highest' | 'rating-lowest'
  | 'size-largest' | 'size-smallest';

export type HistogramStyle = 'filled' | 'lines' | 'hybrid';
