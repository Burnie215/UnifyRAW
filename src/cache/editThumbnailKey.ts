/** Key prefix of every developed thumbnail, and the handle a bulk purge takes them by. */
export const EDIT_THUMBNAIL_PREFIX = 'edit:';

/**
 * Keep developed thumbnails separate from immutable source thumbnails.
 *
 * `stamp` names the base-development and lens profiles that produced this
 * rendering (see `engine/thumbnailStamp`). It is absent for every photo no
 * profile covers, which is why introducing it invalidated nothing.
 */
export function editThumbnailKey(contentHash: string, stamp?: string | null): string {
  return stamp
    ? `${EDIT_THUMBNAIL_PREFIX}${stamp}:${contentHash}`
    : `${EDIT_THUMBNAIL_PREFIX}${contentHash}`;
}
