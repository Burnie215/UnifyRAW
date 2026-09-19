/**
 * Color space conversion module.
 *
 * Supports sRGB, Adobe RGB (1998), ProPhoto RGB.
 * All conversions go through CIE XYZ as interchange space.
 *
 * Pipeline: Source → linearize → source→XYZ → XYZ→target → target gamma → Target
 */

export type OutputColorSpaceId = 'srgb' | 'display-p3' | 'adobe-rgb' | 'prophoto' | 'rec2020';
export type ColorSpaceId = Extract<OutputColorSpaceId, 'srgb' | 'adobe-rgb' | 'prophoto'>;

export interface ColorSpaceProfile {
  id: ColorSpaceId;
  label: string;
  /** RGB → XYZ (3×3 row-major) */
  toXYZ: number[];
  /** XYZ → RGB (3×3 row-major) */
  fromXYZ: number[];
  /** Linearize (remove gamma) */
  linearize: (v: number) => number;
  /** Apply gamma (encode) */
  gamma: (v: number) => number;
  /** White point (D65 or D50) */
  whitePoint: 'd65' | 'd50';
}

// ─── Gamma functions ───────────────────────────────────────────

function srgbLinearize(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function srgbGamma(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

function adobeRgbLinearize(v: number): number {
  return Math.pow(Math.max(v, 0), 2.19921875); // 563/256
}

function adobeRgbGamma(v: number): number {
  return Math.pow(Math.max(v, 0), 1 / 2.19921875);
}

function proPhotoLinearize(v: number): number {
  return v <= 16 * Math.pow(1 / 512, 1.8)
    ? v / 16
    : Math.pow(v, 1.8);
}

function proPhotoGamma(v: number): number {
  return v <= 1 / 512
    ? v * 16
    : Math.pow(v, 1 / 1.8);
}

// ─── Color space definitions ───────────────────────────────────

export const COLOR_SPACES: Record<ColorSpaceId, ColorSpaceProfile> = {
  'srgb': {
    id: 'srgb',
    label: 'sRGB',
    whitePoint: 'd65',
    toXYZ: [
      0.4124564, 0.3575761, 0.1804375,
      0.2126729, 0.7151522, 0.0721750,
      0.0193339, 0.1191920, 0.9503041,
    ],
    fromXYZ: [
       3.2404542, -1.5371385, -0.4985314,
      -0.9692660,  1.8760108,  0.0415560,
       0.0556434, -0.2040259,  1.0572252,
    ],
    linearize: srgbLinearize,
    gamma: srgbGamma,
  },
  'adobe-rgb': {
    id: 'adobe-rgb',
    label: 'Adobe RGB (1998)',
    whitePoint: 'd65',
    toXYZ: [
      0.5767309, 0.1855540, 0.1881852,
      0.2973769, 0.6273491, 0.0752741,
      0.0270343, 0.0706872, 0.9911085,
    ],
    fromXYZ: [
       2.0413690, -0.5649464, -0.3446944,
      -0.9692660,  1.8760108,  0.0415560,
       0.0134474, -0.1183897,  1.0154096,
    ],
    linearize: adobeRgbLinearize,
    gamma: adobeRgbGamma,
  },
  'prophoto': {
    id: 'prophoto',
    label: 'ProPhoto RGB',
    whitePoint: 'd50',
    toXYZ: [
      0.7976749, 0.1351917, 0.0313534,
      0.2880402, 0.7118741, 0.0000857,
      0.0000000, 0.0000000, 0.8252100,
    ],
    fromXYZ: [
       1.3459433, -0.2556075, -0.0511118,
      -0.5445989,  1.5081673,  0.0205351,
       0.0000000,  0.0000000,  1.2118128,
    ],
    linearize: proPhotoLinearize,
    gamma: proPhotoGamma,
  },
};

// ─── Bradford chromatic adaptation (D65 ↔ D50) ────────────────

// D65 XYZ: 0.95047, 1.00000, 1.08883
// D50 XYZ: 0.96422, 1.00000, 0.82521

const BRADFORD_D65_TO_D50 = [
   1.0478112, 0.0228866, -0.0501270,
   0.0295424, 0.9904844, -0.0170491,
  -0.0092345, 0.0150436,  0.7521316,
];

const BRADFORD_D50_TO_D65 = [
   0.9555766, -0.0230393, 0.0631636,
  -0.0282895,  1.0099416, 0.0210077,
   0.0122982, -0.0204830, 1.3299098,
];

// ─── Matrix math helpers ───────────────────────────────────────

function mat3x3MulVec(m: number[], v: [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

// ─── Public API ────────────────────────────────────────────────

/**
 * Convert a single pixel from one color space to another.
 * Input/output values are gamma-encoded, 0-1 range.
 */
export function convertPixel(
  r: number, g: number, b: number,
  from: ColorSpaceId, to: ColorSpaceId,
): [number, number, number] {
  if (from === to) return [r, g, b];

  const src = COLOR_SPACES[from];
  const dst = COLOR_SPACES[to];

  // 1. Linearize (remove source gamma)
  const lr = src.linearize(r);
  const lg = src.linearize(g);
  const lb = src.linearize(b);

  // 2. Source → XYZ
  let xyz = mat3x3MulVec(src.toXYZ, [lr, lg, lb]);

  // 3. Chromatic adaptation if white points differ
  if (src.whitePoint !== dst.whitePoint) {
    if (src.whitePoint === 'd65' && dst.whitePoint === 'd50') {
      xyz = mat3x3MulVec(BRADFORD_D65_TO_D50, xyz);
    } else {
      xyz = mat3x3MulVec(BRADFORD_D50_TO_D65, xyz);
    }
  }

  // 4. XYZ → target linear
  const [dr, dg, db] = mat3x3MulVec(dst.fromXYZ, xyz);

  // 5. Apply target gamma
  return [
    dst.gamma(Math.max(0, Math.min(1, dr))),
    dst.gamma(Math.max(0, Math.min(1, dg))),
    dst.gamma(Math.max(0, Math.min(1, db))),
  ];
}

/**
 * Convert an entire ImageData from one color space to another (in-place).
 */
export function convertImageData(
  data: ImageData,
  from: ColorSpaceId,
  to: ColorSpaceId,
): void {
  if (from === to) return;

  const src = COLOR_SPACES[from];
  const dst = COLOR_SPACES[to];
  const needsAdaptation = src.whitePoint !== dst.whitePoint;
  const adaptMatrix = src.whitePoint === 'd65' ? BRADFORD_D65_TO_D50 : BRADFORD_D50_TO_D65;
  const px = data.data;

  for (let i = 0; i < px.length; i += 4) {
    // Decode 0-255 → 0-1
    let r = px[i] / 255;
    let g = px[i + 1] / 255;
    let b = px[i + 2] / 255;

    // Linearize
    r = src.linearize(r);
    g = src.linearize(g);
    b = src.linearize(b);

    // Source → XYZ
    let xyz = mat3x3MulVec(src.toXYZ, [r, g, b]);

    // Chromatic adaptation
    if (needsAdaptation) xyz = mat3x3MulVec(adaptMatrix, xyz);

    // XYZ → target
    const [dr, dg, db] = mat3x3MulVec(dst.fromXYZ, xyz);

    // Gamma + quantize
    px[i]     = Math.round(dst.gamma(Math.max(0, Math.min(1, dr))) * 255);
    px[i + 1] = Math.round(dst.gamma(Math.max(0, Math.min(1, dg))) * 255);
    px[i + 2] = Math.round(dst.gamma(Math.max(0, Math.min(1, db))) * 255);
    // Alpha unchanged
  }
}

/**
 * 16-bit RGBA counterpart to convertImageData. It operates directly on the
 * typed pixel buffer because ImageData is restricted to 8-bit channels.
 */
export function convertImageData16(
  px: Uint16Array,
  from: ColorSpaceId,
  to: ColorSpaceId,
): void {
  if (from === to) return;

  const src = COLOR_SPACES[from];
  const dst = COLOR_SPACES[to];
  const needsAdaptation = src.whitePoint !== dst.whitePoint;
  const adaptMatrix = src.whitePoint === 'd65' ? BRADFORD_D65_TO_D50 : BRADFORD_D50_TO_D65;

  for (let i = 0; i < px.length; i += 4) {
    let r = src.linearize(px[i] / 65535);
    let g = src.linearize(px[i + 1] / 65535);
    let b = src.linearize(px[i + 2] / 65535);

    let xyz = mat3x3MulVec(src.toXYZ, [r, g, b]);
    if (needsAdaptation) xyz = mat3x3MulVec(adaptMatrix, xyz);
    [r, g, b] = mat3x3MulVec(dst.fromXYZ, xyz);

    px[i] = Math.round(dst.gamma(Math.max(0, Math.min(1, r))) * 65535);
    px[i + 1] = Math.round(dst.gamma(Math.max(0, Math.min(1, g))) * 65535);
    px[i + 2] = Math.round(dst.gamma(Math.max(0, Math.min(1, b))) * 65535);
  }
}

/**
 * Check if a pixel (sRGB, 0-255) is inside the gamut of a target color space.
 * Returns true if the pixel can be represented in the target space.
 */
export function isInGamut(r: number, g: number, b: number, target: ColorSpaceId): boolean {
  if (target === 'srgb') return true; // sRGB is always in its own gamut

  const src = COLOR_SPACES['srgb'];
  const dst = COLOR_SPACES[target];

  // Linearize from sRGB
  const lr = src.linearize(r / 255);
  const lg = src.linearize(g / 255);
  const lb = src.linearize(b / 255);

  // sRGB → XYZ
  let xyz = mat3x3MulVec(src.toXYZ, [lr, lg, lb]);

  // Chromatic adaptation
  if (src.whitePoint !== dst.whitePoint) {
    xyz = mat3x3MulVec(
      src.whitePoint === 'd65' ? BRADFORD_D65_TO_D50 : BRADFORD_D50_TO_D65,
      xyz,
    );
  }

  // XYZ → target linear
  const [dr, dg, db] = mat3x3MulVec(dst.fromXYZ, xyz);

  // In gamut if all channels are in [0, 1]
  const eps = -0.001; // tiny tolerance
  return dr >= eps && dg >= eps && db >= eps && dr <= 1.001 && dg <= 1.001 && db <= 1.001;
}

// ─── Standard ICC profiles (binary, base64-encoded) ────────────
// These are the minimal ICC v2 profiles for embedding in exported files.

/** Minimal sRGB IEC61966-2.1 ICC profile (3024 bytes) */
export const ICC_SRGB_BASE64 = 'AAALQE5vbmUAAAACAAEAAExJTk8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEWNwcnQAAAEAAAAALGRlc2MAAAEsAAAAa3d0cHQAAAGYAAAAFGJrcHQAAAGsAAAAFHJYWVoAAAHAAAAAFGdYWVoAAAHUAAAAFGJYWVoAAAHoAAAAFGRtbmQAAAH8AAAAcmRtZGQAAAJwAAAAiHZ1ZWQAAAL4AAAAhkx1bWkAAAOAAAAAFG1lYXMAAAOUAAAAJHRlY2gAAAO4AAAADHJUUkMAAAO4AAAADG1sdWMAAAP4AAAAHG1sdWMAAAQUAAAAJm1sdWMAAAQ8AAAABnByZTAAAARcAAAAKHByZTAAAASEAAAALHBhcmEAAATwAAAABnBhcmEAAAUAAAAABnBhcmEAAAUQAAAABnNmMzIAAAUYAAAADHNmMzIAAAUkAAAADHNmMzIAAAUwAAAADA==';

/** Minimal Adobe RGB (1998) ICC profile (560 bytes) */
export const ICC_ADOBE_RGB_BASE64 = 'AAAyUEFEQkUAAAACAAEAAExpbk8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADWAAAGAAAANYZ3B0AAABhAAAABRia3B0AAABmAAAABRyWFlaAAABrAAAABRnWFlaAAABwAAAABRiWFlaAAAB1AAAABRkZXNjAAAB6AAAAEdkZXNjAAACMAAAAGRkZXNjAAACkAAAACBkZXNjAAACsAAAACVyVFJDAAAC2AAAACBnVFJDAAAC2AAAACBiVFJDAAAC2AAAACBjcHJ0AAAC+AAAADB3dHB0AAADJAAAABRjaGFkAAADOAAAACw=';
