import { useMemo } from 'react';
import type { PhotoView, SourceRow } from '../storage/repos';

export interface AvailablePhotoProjection {
  photos: PhotoView[];
  photoIds: Set<number>;
  sourceIds: Set<string>;
}

export type AvailabilityFilter = 'online' | 'unavailable' | 'all';

/**
 * Project the persistent photo index onto sources that are currently usable.
 *
 * Photo rows deliberately survive a temporary disconnect so metadata and edits
 * are available again after reconnecting. Library views, however, must never
 * render those rows as if their image bytes were currently accessible.
 */
export function projectAvailablePhotos(
  indexedPhotos: PhotoView[],
  sources: SourceRow[],
  disconnectedSourceIds: readonly string[],
  sourceStateReady: boolean,
  availabilityFilter: AvailabilityFilter = 'online',
): AvailablePhotoProjection {
  if (!sourceStateReady) {
    return { photos: [], photoIds: new Set(), sourceIds: new Set() };
  }

  const disconnected = new Set(disconnectedSourceIds);
  const sourceIds = new Set(
    sources
      .map((source) => source.id)
      .filter((sourceId) => !disconnected.has(sourceId)),
  );
  const photos = indexedPhotos.filter((photo) => {
    if (!sourceIds.has(photo.sourceId)) return false;
    if (availabilityFilter === 'all') return true;
    if (availabilityFilter === 'unavailable') return photo.availability !== 'online';
    return photo.availability === 'online';
  });
  const photoIds = new Set<number>();
  for (const photo of photos) {
    if (photo.id !== undefined) photoIds.add(photo.id);
  }

  return { photos, photoIds, sourceIds };
}

export function useAvailablePhotos(
  indexedPhotos: PhotoView[],
  sources: SourceRow[],
  disconnectedSourceIds: readonly string[],
  sourceStateReady: boolean,
  availabilityFilter: AvailabilityFilter = 'online',
): AvailablePhotoProjection {
  return useMemo(
    () => projectAvailablePhotos(
      indexedPhotos,
      sources,
      disconnectedSourceIds,
      sourceStateReady,
      availabilityFilter,
    ),
    [indexedPhotos, sources, disconnectedSourceIds, sourceStateReady, availabilityFilter],
  );
}
