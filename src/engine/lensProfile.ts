/**
 * Measured lens correction profiles.
 *
 * The old public profile lookup was never called and has been removed.
 * `resolveLensCoefficients` is the live path: it prefers a user's measured
 * profile and falls back to the built-in approximations.
 *
 * Measured profiles are keyed by lens and focal range and take precedence over
 * those approximations.
 */
import { LENS_PROFILES, interpolateProfile, type LensProfile } from './LensCorrection';

/** The eight coefficients a profile is made of, without the bookkeeping. */
export interface LensCoefficients {
  k1: number; k2: number; k3: number;
  v1: number; v2: number; v3: number;
  caR: number; caB: number;
}

export const NEUTRAL_LENS_COEFFICIENTS: LensCoefficients = {
  k1: 0, k2: 0, k3: 0, v1: 0, v2: 0, v3: 0, caR: 0, caB: 0,
};

export interface MeasuredLensProfile extends LensCoefficients {
  syncId: string;
  name: string;
  /** Normalised lens name, as `normaliseLensKey` produces it. */
  key: string;
  /** Inclusive focal-length band in mm. Null on either side means unbounded. */
  focalFrom: number | null;
  focalTo: number | null;
  updatedAt: number;
}

/** The parts of a photo that decide which lens profile covers it. */
export interface LensSubject {
  lens?: string | null;
  focalLength?: number | null;
}

/**
 * Fold a lens string into a comparable key.
 *
 * Everything that is not a letter or a digit goes, spaces included. Lens names
 * are written half a dozen ways for the same glass - "EF 24-70mm f/2.8L",
 * "EF24-70mm F2.8 L", "24-70mm f2.8" - and every difference between them is
 * punctuation or spacing. Anything gentler leaves the same lens sitting under
 * two keys, which is exactly the failure that makes a measured profile
 * silently stop applying.
 *
 * The result is opaque and never shown; the profile's own name is what the UI
 * displays.
 */
export function normaliseLensKey(lens: string | null | undefined): string {
  if (!lens) return '';
  return lens.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function coversFocal(profile: MeasuredLensProfile, focal: number | null | undefined): boolean {
  if (profile.focalFrom === null && profile.focalTo === null) return true;
  if (focal === null || focal === undefined) return false;
  if (profile.focalFrom !== null && focal < profile.focalFrom) return false;
  if (profile.focalTo !== null && focal > profile.focalTo) return false;
  return true;
}

/** How narrow a band is; a tighter one is a better answer for this focal length. */
function bandWidth(profile: MeasuredLensProfile): number {
  if (profile.focalFrom === null || profile.focalTo === null) return Number.POSITIVE_INFINITY;
  return profile.focalTo - profile.focalFrom;
}

/**
 * The measured profile covering this photo, or null.
 *
 * The narrowest matching band wins: a profile measured at 24mm says more about
 * a 24mm frame than one averaged over 24-70. Ties go to whichever was measured
 * last.
 */
export function selectMeasuredLensProfile(
  profiles: readonly MeasuredLensProfile[],
  subject: LensSubject,
): MeasuredLensProfile | null {
  const key = normaliseLensKey(subject.lens);
  if (!key) return null;
  let best: MeasuredLensProfile | null = null;
  for (const profile of profiles) {
    if (profile.key !== key || !coversFocal(profile, subject.focalLength)) continue;
    if (
      best === null
      || bandWidth(profile) < bandWidth(best)
      || (bandWidth(profile) === bandWidth(best) && profile.updatedAt > best.updatedAt)
    ) best = profile;
  }
  return best;
}

/** Just the coefficients, at the given focal length. */
export function coefficientsOf(profile: LensProfile | MeasuredLensProfile): LensCoefficients {
  return {
    k1: profile.k1, k2: profile.k2, k3: profile.k3,
    v1: profile.v1, v2: profile.v2, v3: profile.v3,
    caR: profile.caR, caB: profile.caB,
  };
}

/**
 * What should correct this photo: the user's own measurement first, one of the
 * built-in approximations second, nothing third.
 *
 * The built-ins are only consulted as a fallback, and interpolated across
 * their zoom range the way `interpolateProfile` intends - a table entry
 * spanning 24-70mm does not describe either end of it.
 */
export function resolveLensCoefficients(
  measured: readonly MeasuredLensProfile[],
  subject: LensSubject,
): { coefficients: LensCoefficients; source: 'measured' | 'builtin' } | null {
  const own = selectMeasuredLensProfile(measured, subject);
  if (own) return { coefficients: coefficientsOf(own), source: 'measured' };

  const builtin = findBuiltinLensProfile(subject);
  if (builtin) return { coefficients: coefficientsOf(builtin), source: 'builtin' };
  return null;
}

function findBuiltinLensProfile(subject: LensSubject): LensProfile | null {
  const lens = subject.lens;
  if (!lens) return null;
  const lensLower = lens.toLowerCase();
  for (const profile of LENS_PROFILES) {
    const name = profile.lens.toLowerCase();
    if (!lensLower.includes(name) && !name.includes(lensLower)) continue;
    const focal = subject.focalLength;
    if (focal && (focal < profile.focalRange[0] || focal > profile.focalRange[1])) continue;
    return focal ? interpolateProfile(profile, focal) : profile;
  }
  return null;
}
