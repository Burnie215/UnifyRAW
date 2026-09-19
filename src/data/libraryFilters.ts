export const DEFAULT_LIBRARY_FILTERS = {
  ratingFilter: 0,
  flagFilter: 'all',
  labelFilter: 'all',
  availabilityFilter: 'online',
  cameraFilter: 'all',
  lensFilter: 'all',
  keywordFilter: '',
} as const;

export const RATING_FILTER_VALUES = [0, 1, 2, 3, 4, 5] as const;
export const FLAG_FILTER_VALUES = ['all', 'pick', 'reject', 'unflagged'] as const;
export const LABEL_FILTER_VALUES = ['all', 'red', 'yellow', 'green', 'blue', 'purple'] as const;

export interface LibraryFilterValues {
  ratingFilter: number;
  flagFilter: string;
  labelFilter: string;
  availabilityFilter: 'online' | 'unavailable' | 'all';
  cameraFilter: string;
  lensFilter: string;
  keywordFilter: string;
}

export interface LibraryFilterSetters {
  onRatingFilterChange: (value: number) => void;
  onFlagFilterChange: (value: string) => void;
  onLabelFilterChange: (value: string) => void;
  onAvailabilityFilterChange: (value: LibraryFilterValues['availabilityFilter']) => void;
  onCameraFilterChange: (value: string) => void;
  onLensFilterChange: (value: string) => void;
  onKeywordFilterChange: (value: string) => void;
}

export function isFilterActive(filters: LibraryFilterValues): boolean {
  return filters.ratingFilter !== DEFAULT_LIBRARY_FILTERS.ratingFilter
    || filters.flagFilter !== DEFAULT_LIBRARY_FILTERS.flagFilter
    || filters.labelFilter !== DEFAULT_LIBRARY_FILTERS.labelFilter
    || filters.availabilityFilter !== DEFAULT_LIBRARY_FILTERS.availabilityFilter
    || filters.cameraFilter !== DEFAULT_LIBRARY_FILTERS.cameraFilter
    || filters.lensFilter !== DEFAULT_LIBRARY_FILTERS.lensFilter
    || filters.keywordFilter !== DEFAULT_LIBRARY_FILTERS.keywordFilter;
}

export function filterResetActions(setters: LibraryFilterSetters): () => void {
  return () => {
    setters.onRatingFilterChange(DEFAULT_LIBRARY_FILTERS.ratingFilter);
    setters.onFlagFilterChange(DEFAULT_LIBRARY_FILTERS.flagFilter);
    setters.onLabelFilterChange(DEFAULT_LIBRARY_FILTERS.labelFilter);
    setters.onAvailabilityFilterChange(DEFAULT_LIBRARY_FILTERS.availabilityFilter);
    setters.onCameraFilterChange(DEFAULT_LIBRARY_FILTERS.cameraFilter);
    setters.onLensFilterChange(DEFAULT_LIBRARY_FILTERS.lensFilter);
    setters.onKeywordFilterChange(DEFAULT_LIBRARY_FILTERS.keywordFilter);
  };
}

export function toggleValue<T>(current: T, next: T, neutral: T): T {
  return current === next ? neutral : next;
}
