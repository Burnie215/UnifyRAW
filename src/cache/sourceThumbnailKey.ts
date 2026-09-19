import { makeRawCacheKey, type RawCacheIdentity } from '../engine/raw/cacheKey';

/** Key prefix of a source thumbnail named by the photo's scan identity. */
export const SOURCE_THUMBNAIL_PREFIX = 'src:';

export type SourceThumbnailIdentity = RawCacheIdentity & { contentHash?: string | null };

/**
 * Where a photo's SOURCE thumbnail is stored, and the slots it may be found in.
 *
 * `[0]` is where new ones are written: the same stable scan identity the RAW
 * ladder is keyed by, available from the moment a photo is scanned. The tile
 * loader and the background walker used to store and look up under
 * `contentHash` alone, which fails twice. A fresh scan writes no hash - 22 of
 * the 23 providers only get one when the editor opens that photo - so nothing
 * was stored for a library nobody had opened and every grid build decoded
 * every RAW again. And when the hash did arrive the key MOVED, the same drift
 * that cost the RAW ladder a re-decode per open, so the photo was decoded once
 * more.
 *
 * The content hash stays in the list as a second place to look: it is where
 * every thumbnail written before this was stored, and two sources holding the
 * same file share it.
 *
 * `edit:` names the DEVELOPED rendering of a photo; this is the undeveloped
 * one, so the two never share a slot.
 */
export function sourceThumbnailKeys(photo: SourceThumbnailIdentity): string[] {
  const stable = `${SOURCE_THUMBNAIL_PREFIX}${makeRawCacheKey(photo)}`;
  return photo.contentHash ? [stable, photo.contentHash] : [stable];
}

/** The slot a newly generated source thumbnail is written to. */
export function sourceThumbnailKey(photo: SourceThumbnailIdentity): string {
  return sourceThumbnailKeys(photo)[0];
}
