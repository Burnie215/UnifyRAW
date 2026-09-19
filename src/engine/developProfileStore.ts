/**
 * The active set of base-development profiles, and the one function every
 * render path calls to ask for a photo's.
 *
 * A module singleton rather than a context because the callers are not all
 * React: the background thumbnail renderer and the exporter build graphs
 * outside any tree, and all of them have to reach the same answer as the
 * editor canvas - two views of one photo disagreeing is exactly the bug this
 * whole stage exists to avoid. It is filled from the catalog by
 * `useDevelopProfiles` and re-filled whenever a profile is written.
 *
 * The list is tiny (one entry per camera or format the user has tuned), so
 * resolving is a linear scan and needs no index.
 */
import type { Adjustments } from '../types';
import {
  selectDevelopProfile,
  type DevelopProfile,
  type DevelopProfileSubject,
} from './developProfile';
import { adjustmentsToBuilderAdjustments, type BuilderAdjustments } from './graph/DefaultGraphBuilder';
import { defaultAdjustments } from '../types';
import { RawDecoder } from './RawDecoder';

let profiles: readonly DevelopProfile[] = [];
/**
 * Bumped on every change. Anything that caches a rendered RAW has to include
 * this, or a profile edit leaves stale pictures behind under unchanged keys.
 */
let revision = 0;

const builderCache = new Map<string, BuilderAdjustments>();

export function setDevelopProfiles(next: readonly DevelopProfile[]): void {
  profiles = next;
  revision++;
  builderCache.clear();
}

export function getDevelopProfiles(): readonly DevelopProfile[] {
  return profiles;
}

/** Monotonic; changes whenever any profile changes. */
export function developProfileRevision(): number {
  return revision;
}

/**
 * The profile covering this photo, or null.
 *
 * Only RAW gets one. A JPEG or HEIC has already been developed by whatever
 * produced it, and a second base development on top would be a look, not a
 * rendering.
 */
export function developProfileFor(subject: DevelopProfileSubject): DevelopProfile | null {
  if (profiles.length === 0) return null;
  if (!RawDecoder.isRawFile(subject.name)) return null;
  return selectDevelopProfile(profiles, subject);
}

/**
 * The photo's base development in builder units, ready for the raw16 source
 * spec - or null when it has no profile, which reproduces the graph as it was
 * before profiles existed.
 */
export function baseAdjustmentsFor(subject: DevelopProfileSubject): BuilderAdjustments | null {
  const profile = developProfileFor(subject);
  if (!profile) return null;
  const cached = builderCache.get(profile.syncId);
  if (cached) return cached;
  const built = toBuilderBase(profile.adjustments);
  builderCache.set(profile.syncId, built);
  return built;
}

/**
 * Turn a stored partial profile into builder units.
 *
 * The defaults are merged in first because `adjustmentsToBuilderAdjustments`
 * reads a whole `Adjustments`, and a half-filled one would hand the graph
 * undefined where it expects a neutral value.
 */
export function toBuilderBase(adjustments: Partial<Adjustments>): BuilderAdjustments {
  return adjustmentsToBuilderAdjustments({ ...defaultAdjustments, ...adjustments } as Adjustments);
}
