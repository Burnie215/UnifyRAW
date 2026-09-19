import type { SortOption } from '../../types';

const SORT_OPTIONS: readonly SortOption[] = [
  'name-asc',
  'name-desc',
  'date-newest',
  'date-oldest',
  'rating-highest',
  'rating-lowest',
  'size-largest',
  'size-smallest',
];

export const SORT_LABEL_KEYS: Readonly<Record<SortOption, string>> = {
  'name-asc': 'nameAsc',
  'name-desc': 'nameDesc',
  'date-newest': 'dateNewest',
  'date-oldest': 'dateOldest',
  'rating-highest': 'ratingHighest',
  'rating-lowest': 'ratingLowest',
  'size-largest': 'sizeLargest',
  'size-smallest': 'sizeSmallest',
};

export function sortOptions(): readonly SortOption[] {
  return SORT_OPTIONS;
}
