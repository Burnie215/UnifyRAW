/**
 * Lens correction profiles and shader pass.
 *
 * Profiles contain coefficients for:
 * - Distortion (barrel/pincushion): Brown-Conrady model (k1, k2, k3)
 * - Vignetting: cos^4 falloff correction (v1, v2, v3)
 * - Chromatic aberration: lateral CA correction (ca_r, ca_b)
 */

export interface LensProfile {
  id: string;
  make: string;
  lens: string;
  /** Focal lengths this profile covers */
  focalRange: [number, number];
  /** Distortion: Brown-Conrady radial coefficients */
  k1: number;
  k2: number;
  k3: number;
  /** Vignetting correction coefficients */
  v1: number;
  v2: number;
  v3: number;
  /** Lateral chromatic aberration (red shift, blue shift) */
  caR: number;
  caB: number;
}

/**
 * Built-in lens profiles for common lenses.
 * Values are approximations — real profiles would come from lensfun DB.
 */
export const LENS_PROFILES: LensProfile[] = [
  // ─── Canon ───
  { id: 'canon-ef-50-1.8', make: 'Canon', lens: 'EF 50mm f/1.8', focalRange: [50, 50],
    k1: -0.012, k2: 0.008, k3: 0, v1: 1.2, v2: -0.8, v3: 0.3, caR: 0.0003, caB: -0.0003 },
  { id: 'canon-ef-24-70-2.8', make: 'Canon', lens: 'EF 24-70mm f/2.8L', focalRange: [24, 70],
    k1: -0.025, k2: 0.015, k3: 0, v1: 1.5, v2: -1.0, v3: 0.4, caR: 0.0004, caB: -0.0005 },
  { id: 'canon-ef-70-200-2.8', make: 'Canon', lens: 'EF 70-200mm f/2.8L', focalRange: [70, 200],
    k1: -0.005, k2: 0.002, k3: 0, v1: 1.1, v2: -0.5, v3: 0.2, caR: 0.0002, caB: -0.0002 },
  // ─── Sony ───
  { id: 'sony-fe-50-1.8', make: 'Sony', lens: 'FE 50mm F1.8', focalRange: [50, 50],
    k1: -0.010, k2: 0.006, k3: 0, v1: 1.3, v2: -0.9, v3: 0.35, caR: 0.0003, caB: -0.0003 },
  { id: 'sony-fe-24-70-2.8', make: 'Sony', lens: 'FE 24-70mm F2.8 GM', focalRange: [24, 70],
    k1: -0.020, k2: 0.012, k3: 0, v1: 1.4, v2: -0.9, v3: 0.35, caR: 0.0003, caB: -0.0004 },
  // ─── Nikon ───
  { id: 'nikon-50-1.8g', make: 'Nikon', lens: 'AF-S 50mm f/1.8G', focalRange: [50, 50],
    k1: -0.008, k2: 0.005, k3: 0, v1: 1.2, v2: -0.7, v3: 0.3, caR: 0.0002, caB: -0.0003 },
  { id: 'nikon-24-70-2.8', make: 'Nikon', lens: 'AF-S 24-70mm f/2.8E', focalRange: [24, 70],
    k1: -0.022, k2: 0.014, k3: 0, v1: 1.4, v2: -0.9, v3: 0.35, caR: 0.0004, caB: -0.0004 },
  // ─── Sigma ───
  { id: 'sigma-35-1.4', make: 'Sigma', lens: '35mm F1.4 DG HSM Art', focalRange: [35, 35],
    k1: -0.018, k2: 0.010, k3: 0, v1: 1.3, v2: -0.8, v3: 0.3, caR: 0.0003, caB: -0.0004 },
  // ─── Fuji ───
  { id: 'fuji-xf-35-1.4', make: 'Fujifilm', lens: 'XF 35mm F1.4 R', focalRange: [35, 35],
    k1: -0.015, k2: 0.009, k3: 0, v1: 1.4, v2: -1.0, v3: 0.4, caR: 0.0003, caB: -0.0003 },
];

/**
 * Interpolate profile coefficients for a specific focal length within a zoom range.
 */
export function interpolateProfile(profile: LensProfile, focalLength: number): LensProfile {
  const [fMin, fMax] = profile.focalRange;
  if (fMin === fMax) return profile;
  const t = Math.max(0, Math.min(1, (focalLength - fMin) / (fMax - fMin)));
  // Distortion typically decreases toward tele end
  return {
    ...profile,
    k1: profile.k1 * (1 - t * 0.5),
    k2: profile.k2 * (1 - t * 0.3),
  };
}
