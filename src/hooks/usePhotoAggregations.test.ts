import { describe, expect, it } from 'vitest';
import { buildKeywordTree } from '../data/keywordTree';
import type { PhotoView } from '../storage/repos';
import { aggregateKeywords } from './usePhotoAggregations';
import { filterAndSortPhotos, type FilterOptions } from './usePhotoFilter';

function photo(id: number | undefined, keywords: string[]): PhotoView {
  return { id, name: `photo-${id ?? 'pending'}.jpg`, keywords } as PhotoView;
}

describe('keyword photo aggregations', () => {
  it('counts unique photos across sibling keyword branches and filters the same set', () => {
    const photos = [
      photo(1, ['Animals|Dogs', 'Animals|Cats']),
      photo(2, ['Animals|Cats']),
    ];
    const tree = buildKeywordTree(aggregateKeywords(photos));
    const animals = tree.find((node) => node.path === 'Animals')!;

    expect(animals.totalCount).toBe(2);
    expect(animals.children.find((node) => node.name === 'Dogs')).toMatchObject({ count: 1, totalCount: 1 });
    expect(animals.children.find((node) => node.name === 'Cats')).toMatchObject({ count: 2, totalCount: 2 });

    const options: FilterOptions = {
      photos,
      search: '', sort: 'name-asc', hiddenSources: new Set(), folderFilter: null,
      ratingFilter: 0, flagFilter: 'all', labelFilter: 'all', keywordFilter: 'Animals',
      cameraFilter: 'all', lensFilter: 'all', activeCollectionId: null, collections: [],
    };
    expect(filterAndSortPhotos(options)).toHaveLength(2);
  });

  it('assigns collision-free aggregation identities to photos without database IDs', () => {
    const summaries = aggregateKeywords([
      photo(undefined, ['Animals|Dogs']),
      photo(undefined, ['Animals|Cats']),
    ]);
    expect(buildKeywordTree(summaries)[0].totalCount).toBe(2);
  });
});
