import { useMemo } from 'react';
import type { PhotoView, CollectionRow } from '../storage/repos';
import type { SortOption } from '../types';
import { collapseRawPairs, type RawPairIndex } from '../data/rawPairing';
import { collapseStacks, type StackIndex } from '../data/photoStacks';
import { filterPhotosByCollection } from '../data/collectionRules';
import { matchesKeyword } from '../data/keywordTree';
import { DEFAULT_LIBRARY_FILTERS } from '../data/libraryFilters';

export interface FilterOptions {
  photos: PhotoView[];
  search: string;
  sort: SortOption;
  hiddenSources: Set<string>;
  folderFilter: string | null;
  ratingFilter: number;
  flagFilter: string;
  labelFilter: string;
  keywordFilter: string;
  cameraFilter: string;
  lensFilter: string;
  activeCollectionId: number | null;
  collections: CollectionRow[];
  /** RAW+JPEG pairs of the whole library, empty when grouping is off. */
  rawPairIndex?: RawPairIndex;
  /** Stacks of the whole library; each one shows as its head alone. */
  stackIndex?: StackIndex;
  /** Stacks the user opened, which stay unfolded. */
  expandedStacks?: ReadonlySet<string>;
}

function captureDate(photo: PhotoView): number {
  return photo.dateTaken ?? photo.dateModified ?? 0;
}

export function sortPhotos(photos: PhotoView[], sort: SortOption): PhotoView[] {
  const sorted = [...photos];
  switch (sort) {
    case 'name-asc': return sorted.sort((a, b) => a.name.localeCompare(b.name));
    case 'name-desc': return sorted.sort((a, b) => b.name.localeCompare(a.name));
    case 'date-newest': return sorted.sort((a, b) => captureDate(b) - captureDate(a));
    case 'date-oldest': return sorted.sort((a, b) => captureDate(a) - captureDate(b));
    case 'rating-highest': return sorted.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    case 'rating-lowest': return sorted.sort((a, b) => (a.rating ?? 0) - (b.rating ?? 0));
    case 'size-largest': return sorted.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
    case 'size-smallest': return sorted.sort((a, b) => (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0));
    default: return sorted;
  }
}

export function filterAndSortPhotos(opts: FilterOptions): PhotoView[] {
  const {
    photos, search, sort, hiddenSources, folderFilter,
    ratingFilter, flagFilter, labelFilter, keywordFilter, cameraFilter, lensFilter,
    activeCollectionId, collections, rawPairIndex, stackIndex, expandedStacks,
  } = opts;
  let result = photos;

  if (hiddenSources.size > 0) {
    result = result.filter((photo) => !hiddenSources.has(photo.sourceId));
  }

  if (folderFilter) {
    if (folderFilter.startsWith('§')) {
      const withoutPrefix = folderFilter.slice(1);
      const slashIdx = withoutPrefix.indexOf('/');
      if (slashIdx === -1) {
        result = result.filter((photo) => photo.sourceId === withoutPrefix);
      } else {
        const sourceId = withoutPrefix.slice(0, slashIdx);
        const subPath = withoutPrefix.slice(slashIdx + 1);
        result = result.filter((photo) =>
          photo.sourceId === sourceId
          && (photo.sourcePhotoId.startsWith(`${subPath}/`) || photo.sourcePhotoId === subPath)
        );
      }
    } else {
      result = result.filter((photo) =>
        photo.sourcePhotoId.startsWith(`${folderFilter}/`) || photo.sourcePhotoId === folderFilter
      );
    }
  }

  if (ratingFilter > 0) {
    result = result.filter((photo) => (photo.rating ?? 0) >= ratingFilter);
  }

  if (flagFilter !== DEFAULT_LIBRARY_FILTERS.flagFilter) {
    result = flagFilter === 'unflagged'
      ? result.filter((photo) => !photo.flag)
      : result.filter((photo) => photo.flag === flagFilter);
  }

  if (labelFilter !== DEFAULT_LIBRARY_FILTERS.labelFilter) {
    result = result.filter((photo) => photo.colorLabel === labelFilter);
  }

  if (cameraFilter !== DEFAULT_LIBRARY_FILTERS.cameraFilter) {
    result = result.filter((photo) => photo.camera === cameraFilter);
  }

  if (lensFilter !== DEFAULT_LIBRARY_FILTERS.lensFilter) {
    result = result.filter((photo) => photo.lens === lensFilter);
  }

  if (search) {
    const query = search.toLowerCase();
    result = result.filter((photo) => photo.name.toLowerCase().includes(query));
  }

  if (keywordFilter) {
    result = result.filter((photo) => matchesKeyword(photo.keywords ?? [], keywordFilter));
  }

  if (activeCollectionId !== null) {
    result = filterPhotosByCollection(result, collections, activeCollectionId);
  }

  if (rawPairIndex && rawPairIndex.size > 0) result = collapseRawPairs(result, rawPairIndex);

  // Stacks fold last: a stack whose head was dropped as the RAW half of a pair
  // is then led by the member that survived, not by a photo that is gone.
  if (stackIndex && stackIndex.size > 0) result = collapseStacks(result, stackIndex, expandedStacks);

  return sortPhotos(result, sort);
}

/**
 * Centralized photo filtering + sorting logic.
 * Extracted from App.tsx to reduce complexity.
 */
export function usePhotoFilter(opts: FilterOptions): PhotoView[] {
  const {
    photos, search, sort, hiddenSources, folderFilter,
    ratingFilter, flagFilter, labelFilter, keywordFilter, cameraFilter, lensFilter,
    activeCollectionId, collections, rawPairIndex, stackIndex, expandedStacks,
  } = opts;

  return useMemo(() => filterAndSortPhotos({
    photos, search, sort, hiddenSources, folderFilter,
    ratingFilter, flagFilter, labelFilter, keywordFilter, cameraFilter, lensFilter,
    activeCollectionId, collections, rawPairIndex, stackIndex, expandedStacks,
  }), [
    photos, search, sort, hiddenSources, folderFilter,
    ratingFilter, flagFilter, labelFilter, keywordFilter, cameraFilter, lensFilter,
    activeCollectionId, collections, rawPairIndex, stackIndex, expandedStacks,
  ]);
}
