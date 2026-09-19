/**
 * Write a source thumbnail into the shared memory slot - unless a developed
 * one exists for this photo.
 *
 * Three places produce the picture a tile shows, and all of them write the
 * same slot: the tile's own loader, the background thumbnailer that walks the
 * whole library, and the developed-thumbnail renderer. For a RAW the first two
 * take seconds (fetch the camera file, decode it) while the third takes a
 * fraction of that, so the slow ones routinely finish last and win - putting
 * the embedded camera JPEG back over the developed picture and leaving it
 * there, because the render that would correct it has already happened and
 * will not happen again.
 *
 * The check costs one indexed lookup and only runs for photos a profile
 * actually develops; everything else takes the plain path it always took.
 *
 * @returns the blob that ended up on screen, which may be the developed one.
 */
import { thumbMemCache } from './ThumbMemCache';
import { editThumbnailKey } from './editThumbnailKey';
import { thumbnailStampFor, type StampSubject } from '../engine/thumbnailStamp';
import { getActiveRepos } from '../storage/activeRepos';

export type SourceThumbSubject = StampSubject & {
  id: number;
  contentHash?: string | null;
};

export async function putSourceThumb(photo: SourceThumbSubject, blob: Blob): Promise<Blob> {
  if (photo.contentHash) {
    const stamp = thumbnailStampFor(photo);
    if (stamp) {
      const developed = await getActiveRepos()?.thumbnails
        .get(editThumbnailKey(photo.contentHash, stamp))
        .catch(() => null);
      if (developed && developed.size > 0) {
        thumbMemCache.put(photo.id, developed);
        return developed;
      }
    }
  }
  thumbMemCache.put(photo.id, blob);
  return blob;
}
