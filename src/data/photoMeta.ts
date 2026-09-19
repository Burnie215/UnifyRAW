/**
 * The values a user may hand to a photo's metadata, and the one rule that
 * decides which photos can take them.
 *
 * Rating, flag and colour label live on `photoMeta`, keyed by `contentHash`.
 * A photo that has not been identified yet has no hash, so it cannot carry
 * metadata — every surface that offers these actions counts those photos and
 * says so instead of dropping them silently (F026).
 */
import type { PhotoColorLabel, PhotoFlag } from '../storage/repos';

export const RATING_VALUES = [0, 1, 2, 3, 4, 5] as const;
export const FLAG_VALUES: readonly PhotoFlag[] = ['pick', 'reject', null];
export const COLOR_LABEL_VALUES: readonly PhotoColorLabel[] = ['red', 'yellow', 'green', 'blue', 'purple', null];

/** What a metadata write did: how many photos took it, how many had no hash. */
export interface PhotoMetaOutcome {
  applied: number;
  skipped: number;
}

/**
 * Split resolved photo rows into the ones that can carry metadata and a count
 * of the ones that cannot.
 */
export function splitMetaTargets<T extends { contentHash?: string | null }>(
  photos: readonly T[],
): { targets: (T & { contentHash: string })[]; skipped: number } {
  const targets = photos.filter(
    (photo): photo is T & { contentHash: string } => !!photo.contentHash,
  );
  return { targets, skipped: photos.length - targets.length };
}
