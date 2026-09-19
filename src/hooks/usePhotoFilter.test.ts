import { describe, expect, it } from 'vitest';
import type { PhotoView } from '../storage/repos';
import type { CollectionRow } from '../storage/repos';
import { buildStackIndex } from '../data/photoStacks';
import { filterAndSortPhotos, sortPhotos, type FilterOptions } from './usePhotoFilter';

function photo(id: number, values: Partial<PhotoView>): PhotoView {
  return { id, name: `photo-${id}.jpg`, ...values } as PhotoView;
}

function filterOptions(photos: PhotoView[], overrides: Partial<FilterOptions> = {}): FilterOptions {
  return {
    photos,
    search: '',
    sort: 'name-asc',
    hiddenSources: new Set(),
    folderFilter: null,
    ratingFilter: 0,
    flagFilter: 'all',
    labelFilter: 'all',
    keywordFilter: '',
    cameraFilter: 'all',
    lensFilter: 'all',
    activeCollectionId: null,
    collections: [] as CollectionRow[],
    ...overrides,
  };
}

describe('sortPhotos', () => {
  it('sorts by capture date and falls back to modification date', () => {
    const photos = [
      photo(1, { dateTaken: 100, dateModified: 900 }),
      photo(2, { dateTaken: null, dateModified: 200 }),
      photo(3, { dateTaken: 300, dateModified: 50 }),
    ];
    expect(sortPhotos(photos, 'date-newest').map((item) => item.id)).toEqual([3, 2, 1]);
    expect(sortPhotos(photos, 'date-oldest').map((item) => item.id)).toEqual([1, 2, 3]);
  });

  it('sorts by rating in both directions', () => {
    const photos = [photo(1, { rating: 2 }), photo(2, { rating: 5 }), photo(3, { rating: null })];
    expect(sortPhotos(photos, 'rating-highest').map((item) => item.id)).toEqual([2, 1, 3]);
    expect(sortPhotos(photos, 'rating-lowest').map((item) => item.id)).toEqual([3, 1, 2]);
  });
});

describe('filterAndSortPhotos', () => {
  const photos = [
    photo(1, { sourceId: 'local', sourcePhotoId: 'one.jpg', camera: 'Fujifilm X-T5', lens: 'XF 35mm', keywords: ['Animals|Dogs|Labrador'] }),
    photo(2, { sourceId: 'local', sourcePhotoId: 'two.jpg', camera: 'Fujifilm X-T5', lens: 'XF 56mm', keywords: ['Animals|Cats'] }),
    photo(3, { sourceId: 'local', sourcePhotoId: 'three.jpg', camera: 'Nikon Z8', lens: 'Nikkor Z 50mm', keywords: ['Landscape'] }),
  ];

  it('matches a selected keyword and all of its descendants, but not a prefix sibling', () => {
    expect(filterAndSortPhotos(filterOptions(photos, { keywordFilter: 'Animals' })).map((item) => item.id)).toEqual([1, 2]);
    expect(filterAndSortPhotos(filterOptions(photos, { keywordFilter: 'Animal' }))).toEqual([]);
  });

  it('filters by camera and lens through the same pure pipeline', () => {
    expect(filterAndSortPhotos(filterOptions(photos, { cameraFilter: 'Fujifilm X-T5' })).map((item) => item.id)).toEqual([1, 2]);
    expect(filterAndSortPhotos(filterOptions(photos, { lensFilter: 'XF 56mm' })).map((item) => item.id)).toEqual([2]);
    expect(filterAndSortPhotos(filterOptions(photos, {
      cameraFilter: 'Fujifilm X-T5', lensFilter: 'Nikkor Z 50mm',
    }))).toEqual([]);
  });
});

describe('filterAndSortPhotos with stacks', () => {
  const stacked = [
    photo(1, { sourceId: 'local', sourcePhotoId: 'a.jpg', stackId: 's', stackPosition: 0, rating: 5 }),
    photo(2, { sourceId: 'local', sourcePhotoId: 'b.jpg', stackId: 's', stackPosition: 1, rating: 5 }),
    photo(3, { sourceId: 'local', sourcePhotoId: 'c.jpg', stackId: null, stackPosition: null, rating: 5 }),
  ];
  const stackIndex = buildStackIndex(stacked);

  it('shows a stack as its head alone', () => {
    expect(filterAndSortPhotos(filterOptions(stacked, { stackIndex })).map((item) => item.id)).toEqual([1, 3]);
  });

  it('unfolds an expanded stack', () => {
    expect(filterAndSortPhotos(filterOptions(stacked, {
      stackIndex, expandedStacks: new Set(['s']),
    })).map((item) => item.id)).toEqual([1, 2, 3]);
  });

  it('folds after the other filters, so a hidden head hands over to a member', () => {
    const photos = [
      stacked[0],
      photo(2, { sourceId: 'local', sourcePhotoId: 'b.jpg', stackId: 's', stackPosition: 1, rating: 5 }),
      stacked[2],
    ];
    photos[0] = photo(1, { sourceId: 'local', sourcePhotoId: 'a.jpg', stackId: 's', stackPosition: 0, rating: 1 });
    expect(filterAndSortPhotos(filterOptions(photos, {
      stackIndex, ratingFilter: 5,
    })).map((item) => item.id)).toEqual([2, 3]);
  });
});
