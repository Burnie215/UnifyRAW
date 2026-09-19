/**
 * Camera base-development profiles: what a RAW looks like before anyone edits
 * it.
 *
 * A profile is not a preset. A preset is an edit the user applies and can take
 * off again; a profile is the RAW converter's own rendering of a sensor, and
 * it lives underneath the sliders - which is why a photo that has one still
 * shows every slider at zero. It is stored per camera or per format, never per
 * photo, and changing one changes every RAW it covers on the next render.
 *
 * This module is the pure half: what a profile is, how it is keyed, and which
 * of several profiles covers a given photo. Persistence lives in the
 * `developProfiles` repository, the render side in `DefaultGraphBuilder`.
 */
import type { Adjustments } from '../types';

export type DevelopProfileScope = 'extension' | 'camera';

export interface DevelopProfile {
  /** Stable identity across devices. */
  syncId: string;
  name: string;
  scope: DevelopProfileScope;
  /** Normalised extension (`raf`) or camera name (`fujifilm x-t5`). */
  key: string;
  /** Inclusive lower bound of the ISO band this profile is limited to. */
  isoFrom: number | null;
  /** Inclusive upper bound. Null with a set `isoFrom` means "and above". */
  isoTo: number | null;
  adjustments: Partial<Adjustments>;
  updatedAt: number;
}

/** The parts of a photo that decide which profile covers it. */
export interface DevelopProfileSubject {
  name: string;
  camera?: string | null;
  iso?: number | null;
}

/** Lowercased extension without the dot, or '' when the name has none. */
export function extensionKey(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * Fold a camera string into a comparable key.
 *
 * The 23 source providers do not agree on what `photos.camera` holds. Immich,
 * Lychee and Photoprism write "Make Model"; Flickr, Piwigo and Synology write
 * the model alone; some write nothing. So the same body indexed from two
 * sources must still land on one key, which means dropping a make that the
 * model already repeats and normalising case and spacing.
 */
export function normaliseCameraKey(camera: string | null | undefined): string {
  if (!camera) return '';
  const clean = camera.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!clean) return '';
  const words = clean.split(' ');
  // "nikon corporation nikon z 8" -> "nikon z 8": a make repeated inside the
  // model is the common shape of the duplication, not an arbitrary prefix.
  for (let start = 1; start < words.length; start++) {
    if (words[start] === words[0]) return words.slice(start).join(' ');
  }
  // "nikon corporation" is a make suffix no model ever carries.
  if (words.length > 2 && words[1] === 'corporation') return [words[0], ...words.slice(2)].join(' ');
  return clean;
}

function coversIso(profile: DevelopProfile, iso: number | null | undefined): boolean {
  if (profile.isoFrom === null && profile.isoTo === null) return true;
  if (iso === null || iso === undefined) return false;
  if (profile.isoFrom !== null && iso < profile.isoFrom) return false;
  if (profile.isoTo !== null && iso > profile.isoTo) return false;
  return true;
}

function matchesKey(profile: DevelopProfile, subject: DevelopProfileSubject): boolean {
  if (profile.scope === 'extension') return profile.key === extensionKey(subject.name);
  const camera = normaliseCameraKey(subject.camera);
  return camera !== '' && profile.key === camera;
}

/**
 * How specific a matching profile is. The most specific match wins, so a body
 * beats a file format and a body at a given ISO beats the body in general.
 */
function specificity(profile: DevelopProfile): number {
  const scope = profile.scope === 'camera' ? 2 : 1;
  const iso = profile.isoFrom !== null || profile.isoTo !== null ? 1 : 0;
  return scope * 2 + iso;
}

/**
 * The profile that covers this photo, or null.
 *
 * Extension scope exists because camera scope cannot be relied on: for a photo
 * from a provider that indexes no camera name there is no body to key on, and
 * a profile keyed only by body would silently cover nothing. So a format-wide
 * profile is the floor, and a body-specific one refines it.
 */
export function selectDevelopProfile(
  profiles: readonly DevelopProfile[],
  subject: DevelopProfileSubject,
): DevelopProfile | null {
  let best: DevelopProfile | null = null;
  let bestRank = -1;
  for (const profile of profiles) {
    if (!matchesKey(profile, subject) || !coversIso(profile, subject.iso)) continue;
    const rank = specificity(profile);
    // A tie is broken by recency: the profile the user touched last is the one
    // they were thinking about.
    if (rank > bestRank || (rank === bestRank && best !== null && profile.updatedAt > best.updatedAt)) {
      best = profile;
      bestRank = rank;
    }
  }
  return best;
}

/** Human-readable scope, for the bench header and the profile list. */
export function describeProfileScope(profile: DevelopProfile): string {
  const subject = profile.scope === 'extension'
    ? `alle .${profile.key.toUpperCase()}`
    : profile.key.toUpperCase();
  if (profile.isoFrom === null && profile.isoTo === null) return subject;
  if (profile.isoTo === null) return `${subject}, ISO ${profile.isoFrom} und höher`;
  if (profile.isoFrom === null) return `${subject}, ISO bis ${profile.isoTo}`;
  return `${subject}, ISO ${profile.isoFrom}-${profile.isoTo}`;
}

/**
 * The adjustment keys a base profile can actually render.
 *
 * The base stage occupies a fixed set of passes (see BASE_LINEAR_KINDS and
 * BASE_GAMMA_KINDS in DefaultGraphBuilder), so anything outside this list
 * would be stored, synced and never shown. Saving is filtered through it
 * rather than leaving the profile carrying values that do nothing - a stored
 * vignette that never appears is worse than no vignette, because the user
 * has no way to tell which of the two they are looking at.
 */
export const BASE_PROFILE_KEYS: readonly (keyof Adjustments)[] = [
  // tone
  'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks',
  // folded into WhiteBalanceRaw
  'temperature', 'tint',
  // hsl (vibrance/saturation only), clarity, texture
  'vibrance', 'saturation', 'clarity', 'dehaze', 'texture',
  // curve, levels, grading
  'toneCurve', 'levels', 'colorGrading',
  // detail
  'sharpness', 'sharpenRadius', 'sharpenMasking',
  'denoiseLuma', 'denoiseChroma', 'denoiseDetail',
];

/** Keep only what the base stage renders, and only what differs from neutral. */
export function toBaseProfileAdjustments(
  adjustments: Adjustments,
  neutral: Adjustments,
): Partial<Adjustments> {
  const out: Partial<Adjustments> = {};
  for (const key of BASE_PROFILE_KEYS) {
    const value = adjustments[key];
    if (JSON.stringify(value) === JSON.stringify(neutral[key])) continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}
