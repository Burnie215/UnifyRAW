/**
 * The active set of measured lens profiles, and the one function every render
 * path calls to ask for a photo's.
 *
 * Same shape and same reason as `developProfileStore`: the exporter and the
 * background thumbnail renderer build graphs outside any React tree, and all
 * of them have to reach the same answer as the editor canvas.
 */
import {
  resolveLensCoefficients,
  selectMeasuredLensProfile,
  type LensCoefficients,
  type LensSubject,
  type MeasuredLensProfile,
} from './lensProfile';

let profiles: readonly MeasuredLensProfile[] = [];
let revision = 0;

export function setLensProfiles(next: readonly MeasuredLensProfile[]): void {
  profiles = next;
  revision++;
}

export function getLensProfiles(): readonly MeasuredLensProfile[] {
  return profiles;
}

/** Monotonic; changes whenever any lens profile changes. */
export function lensProfileRevision(): number {
  return revision;
}

/**
 * The correction for this photo's lens, or null.
 *
 * Returns null when nothing is known rather than a neutral set, so the graph
 * can leave the pass disabled instead of running a resample that changes
 * nothing but costs a full pass.
 */
export function lensCoefficientsFor(subject: LensSubject): LensCoefficients | null {
  return resolveLensCoefficients(profiles, subject)?.coefficients ?? null;
}

/**
 * The measured profile covering this photo, or null.
 *
 * Separate from `lensCoefficientsFor` because the caller wants the profile's
 * identity, not its numbers: a developed thumbnail's cache key has to change
 * when the measurement behind it changes. Built-in profiles are deliberately
 * not considered - they are compiled into the app and cannot change under a
 * stored thumbnail.
 */
export function measuredLensProfileFor(subject: LensSubject): MeasuredLensProfile | null {
  return selectMeasuredLensProfile(profiles, subject);
}
