import { describe, expect, it } from 'vitest';
import { COLOR_LABEL_VALUES, FLAG_VALUES, RATING_VALUES, splitMetaTargets } from './photoMeta';

describe('splitMetaTargets', () => {
  it('keeps the identified photos and counts the ones without a content hash', () => {
    const result = splitMetaTargets([
      { id: 1, contentHash: 'aaa' },
      { id: 2, contentHash: null },
      { id: 3, contentHash: 'bbb' },
      { id: 4, contentHash: undefined },
    ]);

    expect(result.targets.map((photo) => photo.id)).toEqual([1, 3]);
    expect(result.targets.map((photo) => photo.contentHash)).toEqual(['aaa', 'bbb']);
    expect(result.skipped).toBe(2);
  });

  it('treats an empty hash as no hash', () => {
    expect(splitMetaTargets([{ contentHash: '' }])).toEqual({ targets: [], skipped: 1 });
  });

  it('reports nothing skipped when every photo carries a hash', () => {
    expect(splitMetaTargets([{ contentHash: 'a' }, { contentHash: 'b' }]).skipped).toBe(0);
  });
});

describe('metadata value sets', () => {
  it('offers every rating the keyboard shortcuts offer, clearing included', () => {
    expect([...RATING_VALUES]).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('offers both flags plus the way back to unflagged', () => {
    expect([...FLAG_VALUES]).toEqual(['pick', 'reject', null]);
  });

  it('offers every colour label plus the way back to none', () => {
    expect([...COLOR_LABEL_VALUES]).toEqual(['red', 'yellow', 'green', 'blue', 'purple', null]);
  });
});
