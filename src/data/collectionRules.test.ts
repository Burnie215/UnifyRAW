import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CollectionRow, CollectionRule, PhotoView } from '../storage/repos';
import { filterPhotosByCollection, matchesCollectionRules, operatorsForCollectionField } from './collectionRules';

const CAPTURE_DATE = Date.UTC(2025, 4, 17, 14, 30);

function photo(id: number, patch: Partial<PhotoView> = {}): PhotoView {
  return {
    id,
    name: `photo-${id}.jpg`,
    rating: 4,
    flag: 'pick',
    colorLabel: 'red',
    camera: 'Fujifilm X-T5',
    lens: 'XF 35mm F1.4',
    dateTaken: CAPTURE_DATE,
    iso: 640,
    focalLength: 35,
    keywords: ['Travel', 'Night'],
    mimeType: 'image/jpeg',
    ...patch,
  } as PhotoView;
}

function collection(id: number, patch: Partial<CollectionRow>): CollectionRow {
  return {
    id,
    syncId: `collection-${id}`,
    name: `Collection ${id}`,
    type: 'smart',
    parentId: null,
    rules: [],
    photoIds: null,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    ...patch,
  };
}

describe('matchesCollectionRules', () => {
  it('offers only operators that make sense for each input kind', () => {
    expect(operatorsForCollectionField('iso')).toEqual(['equals', 'greaterThan', 'lessThan', 'between']);
    expect(operatorsForCollectionField('date')).toEqual(['equals', 'greaterThan', 'lessThan', 'between']);
    expect(operatorsForCollectionField('mimeType')).toEqual(['equals', 'contains']);
    expect(operatorsForCollectionField('flag')).toEqual(['equals']);
  });

  it.each<[CollectionRule['field'], CollectionRule['value']]>([
    ['rating', 4],
    ['flag', 'pick'],
    ['colorLabel', 'red'],
    ['camera', 'fujifilm x-t5'],
    ['lens', 'xf 35mm f1.4'],
    ['date', '2025-05-17'],
    ['iso', 640],
    ['focalLength', 35],
    ['keywords', 'travel'],
    ['mimeType', 'IMAGE/JPEG'],
  ])('matches the %s field', (field, value) => {
    expect(matchesCollectionRules(photo(1), [{ field, operator: 'equals', value }])).toBe(true);
  });

  it('implements every supported operator with field-appropriate values', () => {
    const subject = photo(1);
    expect(matchesCollectionRules(subject, [{ field: 'camera', operator: 'contains', value: 'X-T' }])).toBe(true);
    expect(matchesCollectionRules(subject, [{ field: 'keywords', operator: 'contains', value: 'nig' }])).toBe(true);
    expect(matchesCollectionRules(subject, [{ field: 'iso', operator: 'greaterThan', value: 500 }])).toBe(true);
    expect(matchesCollectionRules(subject, [{ field: 'focalLength', operator: 'lessThan', value: 50 }])).toBe(true);
    expect(matchesCollectionRules(subject, [{ field: 'rating', operator: 'between', value: 3, value2: 5 }])).toBe(true);
    expect(matchesCollectionRules(subject, [{ field: 'date', operator: 'between', value: '2025-05-16', value2: '2025-05-17' }])).toBe(true);
  });

  it('requires every rule to match', () => {
    expect(matchesCollectionRules(photo(1), [
      { field: 'rating', operator: 'greaterThan', value: 3 },
      { field: 'iso', operator: 'lessThan', value: 200 },
    ])).toBe(false);
  });

  it('treats no rules as match-all but rejects empty values and unknown syntax', () => {
    const subject = photo(1);
    expect(matchesCollectionRules(subject, [])).toBe(true);
    expect(matchesCollectionRules(subject, [{ field: 'camera', operator: 'contains', value: '' }])).toBe(false);
    expect(matchesCollectionRules(subject, [{ field: 'iso', operator: 'equals', value: '' }])).toBe(false);
    expect(matchesCollectionRules(subject, [
      { field: 'camera', operator: 'unknown', value: 'Fuji' } as unknown as CollectionRule,
    ])).toBe(false);
    expect(matchesCollectionRules(subject, [
      { field: 'unknown', operator: 'equals', value: 'Fuji' } as unknown as CollectionRule,
    ])).toBe(false);
    expect(matchesCollectionRules(subject, [
      { field: 'rating', operator: 'contains', value: 4 } as CollectionRule,
    ])).toBe(false);
  });

  it('fails closed for malformed persisted or synchronized payloads', () => {
    const subject = photo(1);
    expect(matchesCollectionRules(subject, null)).toBe(false);
    expect(matchesCollectionRules(subject, {})).toBe(false);
    expect(matchesCollectionRules(subject, [null])).toBe(false);
    expect(matchesCollectionRules(subject, [{ field: 'unknown', operator: 'equals', value: 4 }])).toBe(false);
    expect(matchesCollectionRules(subject, [{ field: 'iso', operator: 'between', value: 100 }])).toBe(false);
    expect(matchesCollectionRules(subject, [{ field: 'camera', operator: 'equals', value: {} }])).toBe(false);
    expect(matchesCollectionRules(subject, [{ field: 'rating', operator: 'equals', value: 6 }])).toBe(false);
    expect(matchesCollectionRules(subject, [{ field: 'flag', operator: 'equals', value: 'maybe' }])).toBe(false);
    expect(matchesCollectionRules(subject, [{ field: 'date', operator: 'equals', value: '2025-02-30' }])).toBe(false);
  });

  it('compares every date operator by UTC calendar day', () => {
    const subject = photo(1);
    expect(matchesCollectionRules(subject, [{ field: 'date', operator: 'equals', value: '2025-05-17' }])).toBe(true);
    expect(matchesCollectionRules(subject, [{ field: 'date', operator: 'greaterThan', value: '2025-05-17' }])).toBe(false);
    expect(matchesCollectionRules(subject, [{ field: 'date', operator: 'lessThan', value: '2025-05-17' }])).toBe(false);
    expect(matchesCollectionRules(subject, [{ field: 'date', operator: 'greaterThan', value: '2025-05-16' }])).toBe(true);
    expect(matchesCollectionRules(subject, [{ field: 'date', operator: 'lessThan', value: '2025-05-18' }])).toBe(true);
    expect(matchesCollectionRules(subject, [
      { field: 'date', operator: 'between', value: '2025-05-17', value2: '2025-05-17' },
    ])).toBe(true);
  });

  it('does not treat missing EXIF numbers as zero while retaining unrated as zero', () => {
    const subject = photo(1, { iso: null, focalLength: null, rating: null });
    expect(matchesCollectionRules(subject, [{ field: 'iso', operator: 'equals', value: 0 }])).toBe(false);
    expect(matchesCollectionRules(subject, [{ field: 'iso', operator: 'lessThan', value: 800 }])).toBe(false);
    expect(matchesCollectionRules(subject, [
      { field: 'focalLength', operator: 'between', value: 0, value2: 100 },
    ])).toBe(false);
    expect(matchesCollectionRules(subject, [{ field: 'rating', operator: 'equals', value: 0 }])).toBe(true);
  });
});

describe('filterPhotosByCollection', () => {
  it('unions manual rows and dynamically matched smart descendants', () => {
    const photos = [photo(1, { rating: 1 }), photo(2, { rating: 5 }), photo(3, { rating: 2 })];
    const collections = [
      collection(10, { type: 'manual', photoIds: [1], rules: null }),
      collection(11, { parentId: 10, rules: [{ field: 'rating', operator: 'greaterThan', value: 4 }] }),
      collection(12, { rules: [{ field: 'rating', operator: 'equals', value: 2 }] }),
    ];

    expect(filterPhotosByCollection(photos, collections, 10).map((item) => item.id)).toEqual([1, 2]);
  });

  it('lets an existing smart row with no rules match the current photo list', () => {
    const photos = [photo(1), photo(2)];
    expect(filterPhotosByCollection(photos, [collection(10, { rules: [] })], 10)).toEqual(photos);
  });

  it('keeps null and malformed rules fail-closed instead of treating them as empty', () => {
    const photos = [photo(1), photo(2)];
    expect(filterPhotosByCollection(photos, [collection(10, { rules: null })], 10)).toEqual([]);
    expect(filterPhotosByCollection(photos, [
      collection(10, { rules: {} as unknown as CollectionRule[] }),
    ], 10)).toEqual([]);
  });

  it('includes matches from smart grandchildren', () => {
    const photos = [photo(1, { rating: 1 }), photo(2, { rating: 5 })];
    const collections = [
      collection(10, { type: 'manual', photoIds: [], rules: null }),
      collection(11, { type: 'manual', parentId: 10, photoIds: [], rules: null }),
      collection(12, {
        parentId: 11,
        rules: [{ field: 'rating', operator: 'equals', value: 5 }],
      }),
    ];

    expect(filterPhotosByCollection(photos, collections, 10).map((item) => item.id)).toEqual([2]);
  });
});

describe('smart collection wiring', () => {
  it('passes the persistence callback through both App sidebars', () => {
    const app = readFileSync(fileURLToPath(new URL('../App.tsx', import.meta.url)), 'utf8');
    const sidebar = readFileSync(fileURLToPath(new URL('../components/Sidebar.tsx', import.meta.url)), 'utf8');

    expect(app.match(/onUpdateSmartRules=\{updateSmartRules\}/g)).toHaveLength(2);
    expect(sidebar).toContain('onUpdateSmartRules={onUpdateSmartRules}');
  });
});
