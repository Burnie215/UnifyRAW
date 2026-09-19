interface SlideshowCandidate {
  id?: number | null;
}

/**
 * What a slideshow shows, and where it starts.
 *
 * From two selected photos onward the user has said which ones they mean, so
 * the show is exactly those. With one or none the selection is only where the
 * cursor happens to sit - a single click through the grid selects a photo -
 * and the show is the whole filtered library, starting at that photo.
 *
 * The start index is clamped: a selected photo that is not in the list at all
 * used to yield -1, and the slideshow then opened on `photos[-1]`.
 */
export function slideshowSelection<T extends SlideshowCandidate>(
  filtered: readonly T[],
  selectedIds: ReadonlySet<number>,
  selectedPhoto: T | null | undefined,
): { photos: T[]; startIndex: number } {
  const photos = selectedIds.size >= 2
    ? filtered.filter((photo) => photo.id != null && selectedIds.has(photo.id))
    : [...filtered];
  const at = selectedPhoto?.id == null
    ? -1
    : photos.findIndex((photo) => photo.id === selectedPhoto.id);
  return { photos, startIndex: at < 0 ? 0 : at };
}
