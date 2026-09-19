import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LIBRARY_FILTERS,
  filterResetActions,
  isFilterActive,
  toggleValue,
  type LibraryFilterSetters,
  type LibraryFilterValues,
} from './libraryFilters';

function defaults(): LibraryFilterValues {
  return { ...DEFAULT_LIBRARY_FILTERS };
}

describe('library filter semantics', () => {
  it.each([
    ['ratingFilter', 3],
    ['flagFilter', 'pick'],
    ['labelFilter', 'red'],
    ['availabilityFilter', 'all'],
    ['cameraFilter', 'Fujifilm X-T5'],
    ['lensFilter', 'XF 35mm F1.4'],
    ['keywordFilter', 'Animals|Dogs'],
  ] as const)('recognizes %s as an active filter', (key, value) => {
    expect(isFilterActive({ ...defaults(), [key]: value })).toBe(true);
  });

  it('recognizes the complete neutral state', () => {
    expect(isFilterActive(defaults())).toBe(false);
  });

  it('uses the same click-again toggle for numeric and string filters', () => {
    expect(toggleValue(3, 3, 0)).toBe(0);
    expect(toggleValue(3, 4, 0)).toBe(4);
    expect(toggleValue('pick', 'pick', 'all')).toBe('all');
    expect(toggleValue('pick', 'reject', 'all')).toBe('reject');
  });

  it('resets every filter dimension through one action', () => {
    const setters = Object.fromEntries(
      Object.keys(DEFAULT_LIBRARY_FILTERS).map((key) => [`on${key[0].toUpperCase()}${key.slice(1)}Change`, vi.fn()]),
    ) as unknown as LibraryFilterSetters;

    filterResetActions(setters)();

    expect(setters.onRatingFilterChange).toHaveBeenCalledWith(0);
    expect(setters.onFlagFilterChange).toHaveBeenCalledWith('all');
    expect(setters.onLabelFilterChange).toHaveBeenCalledWith('all');
    expect(setters.onAvailabilityFilterChange).toHaveBeenCalledWith('online');
    expect(setters.onCameraFilterChange).toHaveBeenCalledWith('all');
    expect(setters.onLensFilterChange).toHaveBeenCalledWith('all');
    expect(setters.onKeywordFilterChange).toHaveBeenCalledWith('');
  });

  it('keeps the persisted availability default connected to the shared definition', () => {
    const app = readFileSync(fileURLToPath(new URL('../App.tsx', import.meta.url)), 'utf8');
    expect(app).toMatch(
      /usePersistedState<'online' \| 'unavailable' \| 'all'>\(\s*'availabilityFilter',\s*DEFAULT_LIBRARY_FILTERS\.availabilityFilter,/,
    );
  });
});
