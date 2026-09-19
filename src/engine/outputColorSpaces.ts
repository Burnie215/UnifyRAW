/**
 * Output color space definitions for the editor pipeline.
 *
 * Each entry provides the 3×3 matrix to convert from linear-sRGB working
 * space into the target's linear RGB, plus a gamma_type index that selects
 * the encode function in the outputColorSpace kind's shader (graph/passKinds.ts).
 */

import { STORAGE_KEYS } from '../platform/storageKeys';
import {
  ICC_ADOBE_RGB_BASE64,
  ICC_SRGB_BASE64,
  type OutputColorSpaceId,
} from './ColorSpace';
export type { OutputColorSpaceId } from './ColorSpace';

export interface OutputColorSpaceDef {
  id: OutputColorSpaceId;
  displayName: string;
  description: string;
  /** 3×3 row-major matrix: linear-sRGB → linear-target. */
  matrix: number[];
  /** Gamma type index — sRGB=0, gamma2.2=1, ProPhoto=2, Rec.2020=3. */
  gammaType: number;
  /** True = available without Pro license. */
  free: boolean;
}

const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export const OUTPUT_COLOR_SPACES: Record<OutputColorSpaceId, OutputColorSpaceDef> = {
  'srgb': {
    id: 'srgb',
    displayName: 'sRGB',
    description: 'Web-Standard. Funktioniert auf allen Displays und Browsern.',
    matrix: I,
    gammaType: 0,
    free: true,
  },
  'display-p3': {
    id: 'display-p3',
    displayName: 'Display-P3',
    description: 'Wide-gamut für moderne Apple-Geräte (iPhone 7+, MacBook Pro). ~25% größerer Farbraum als sRGB.',
    matrix: [
      0.8225, 0.1774, 0.0000,
      0.0331, 0.9669, 0.0000,
      0.0170, 0.0723, 0.9106,
    ],
    gammaType: 0,
    free: false,
  },
  'adobe-rgb': {
    id: 'adobe-rgb',
    displayName: 'Adobe RGB',
    description: 'Pro-Display-Standard. Größerer Cyan/Grün-Bereich als sRGB. Wird auf nicht-kalibrierten Displays falsch dargestellt.',
    matrix: [
      0.7152, 0.2848, 0.0000,
      0.0000, 1.0000, 0.0000,
      0.0000, 0.0412, 0.9588,
    ],
    gammaType: 1,
    free: false,
  },
  'prophoto': {
    id: 'prophoto',
    displayName: 'ProPhoto RGB',
    description: 'Print-Workflow. Sehr großer Farbraum (umfasst alle sichtbaren Farben). Braucht 16-bit Verarbeitung um Banding zu vermeiden.',
    matrix: [
      0.5295, 0.3290, 0.1415,
      0.0980, 0.8716, 0.0304,
      0.0167, 0.1187, 0.8646,
    ],
    gammaType: 2,
    free: false,
  },
  'rec2020': {
    id: 'rec2020',
    displayName: 'Rec.2020 (HDR)',
    description: 'UHDTV-Standard für HDR-Workflows. Sehr großer Farbraum.',
    matrix: [
      0.6274, 0.3293, 0.0433,
      0.0691, 0.9195, 0.0114,
      0.0164, 0.0880, 0.8956,
    ],
    gammaType: 3,
    free: false,
  },
};

const LS_KEY = STORAGE_KEYS.outputColorSpace;

export function getOutputColorSpace(): OutputColorSpaceId {
  try {
    const v = localStorage.getItem(LS_KEY);
    if (v && (v in OUTPUT_COLOR_SPACES)) return v as OutputColorSpaceId;
  } catch { /* */ }
  return 'srgb';
}

export function setOutputColorSpace(id: OutputColorSpaceId): void {
  try { localStorage.setItem(LS_KEY, id); } catch { /* */ }
}

/**
 * The ICC profile a space ships with, keyed by id. Two entries today, and the
 * gap is the point: an export tags the file with the space it rendered in, and
 * a space without a profile can only be written untagged - which every reader
 * then interprets as sRGB. Until 2026-09-12 a ProPhoto export was handed the
 * sRGB profile instead (Exporter.ts:195), so the file claimed a space it was
 * not in. The honest answer is to not offer the space; see
 * `exportableColorSpaces`.
 */
const ICC_BASE64: Partial<Record<OutputColorSpaceId, string>> = {
  'srgb': ICC_SRGB_BASE64,
  'adobe-rgb': ICC_ADOBE_RGB_BASE64,
};

/** The ICC blob to embed for `id`, or null when none is on file. */
export function iccProfileFor(id: OutputColorSpaceId): Uint8Array | null {
  const b64 = ICC_BASE64[id];
  if (!b64) return null;
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** The spaces an export may be offered in: exactly those with a profile. */
export function exportableColorSpaces(): OutputColorSpaceDef[] {
  return Object.values(OUTPUT_COLOR_SPACES).filter((cs) => iccProfileFor(cs.id) !== null);
}

/** The editor setting when it can be written as a tagged file, else sRGB. */
export function defaultExportColorSpace(): OutputColorSpaceId {
  const id = getOutputColorSpace();
  return iccProfileFor(id) ? id : 'srgb';
}

/**
 * The inverse of the `outputColorSpace` shader's `encode()`
 * ([graph/passKinds.ts](graph/passKinds.ts), `outputColorSpaceShader`).
 *
 * The graph's terminal is display-referred: the last node applies the
 * primaries matrix AND the space's transfer curve, and clamps to [0,1]. Every
 * 8-bit container wants exactly that. A linear DNG does not — it declares
 * `PhotometricInterpretation = LinearRaw` and hands the reader a
 * `ColorMatrix1` that maps XYZ to the space's *linear* RGB, so writing the
 * encoded numbers under that declaration is the silent kind of wrong: the
 * file opens, and every tone is off.
 *
 * These are the exact inverses of the four shader branches, thresholds
 * included — derived from the encode constants rather than quoted from the
 * standards, so that the pair stays a pair. The sRGB knee, for instance, sits
 * at 0.0031308 * 12.92 and not at the frequently quoted 0.04045.
 */
const SRGB_KNEE_LINEAR = 0.0031308;
const SRGB_SLOPE = 12.92;
const PROPHOTO_KNEE_LINEAR = 0.001953125;
const PROPHOTO_SLOPE = 16;
const REC2020_ALPHA = 1.09929682680944;
const REC2020_KNEE_LINEAR = 0.018053968510807;
const REC2020_SLOPE = 4.5;

export function decodeOutputTransfer(encoded: number, gammaType: number): number {
  const value = Math.min(1, Math.max(0, encoded));
  if (gammaType < 0.5) {
    return value <= SRGB_KNEE_LINEAR * SRGB_SLOPE
      ? value / SRGB_SLOPE
      : Math.pow((value + 0.055) / 1.055, 2.4);
  }
  if (gammaType < 1.5) return Math.pow(value, 2.2);
  if (gammaType < 2.5) {
    return value <= PROPHOTO_KNEE_LINEAR * PROPHOTO_SLOPE
      ? value / PROPHOTO_SLOPE
      : Math.pow(value, 1.8);
  }
  return value < REC2020_KNEE_LINEAR * REC2020_SLOPE
    ? value / REC2020_SLOPE
    : Math.pow((value + (REC2020_ALPHA - 1)) / REC2020_ALPHA, 1 / 0.45);
}
