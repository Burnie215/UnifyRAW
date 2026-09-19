import { describe, expect, it } from 'vitest';
import type { PhotoView } from '../storage/repos';
import {
  buildStackIndex,
  collapseStacks,
  isStackHead,
  planAutoStack,
  planCreateStack,
  planSetStackHead,
  planUnstack,
  plannedStackCount,
  stackMemberIds,
} from './photoStacks';

function photo(
  id: number,
  fields: { stackId?: string | null; stackPosition?: number | null; dateTaken?: number | null; dateModified?: number } = {},
): PhotoView {
  return {
    id,
    name: `IMG_${id}.ARW`,
    sourceId: 'src',
    sourcePhotoId: `IMG_${id}.ARW`,
    stackId: fields.stackId ?? null,
    stackPosition: fields.stackPosition ?? null,
    dateTaken: fields.dateTaken ?? null,
    dateModified: fields.dateModified ?? 0,
  } as PhotoView;
}

function ids(updates: { id: number; patch: { stackId: string | null; stackPosition: number | null } }[]) {
  return updates.map((u) => [u.id, u.patch.stackId, u.patch.stackPosition]);
}

describe('buildStackIndex', () => {
  it('groups members by stackId and puts position 0 in front', () => {
    const a = photo(1, { stackId: 's', stackPosition: 1 });
    const b = photo(2, { stackId: 's', stackPosition: 0 });
    const index = buildStackIndex([a, b]);

    expect(index.size).toBe(2);
    expect(index.get(1)?.head.id).toBe(2);
    expect(index.get(1)?.members.map((m) => m.id)).toEqual([2, 1]);
    expect(index.get(1)).toBe(index.get(2));
  });

  it('sorts a member without a position last instead of letting it lead', () => {
    const index = buildStackIndex([
      photo(1, { stackId: 's', stackPosition: null }),
      photo(2, { stackId: 's', stackPosition: 0 }),
      photo(3, { stackId: 's', stackPosition: 1 }),
    ]);
    expect(index.get(1)?.members.map((m) => m.id)).toEqual([2, 3, 1]);
  });

  it('ignores unstacked photos and a lone leftover member', () => {
    const index = buildStackIndex([
      photo(1),
      photo(2, { stackId: 'orphan', stackPosition: 0 }),
    ]);
    expect(index.size).toBe(0);
  });

  it('keeps two different stacks apart', () => {
    const index = buildStackIndex([
      photo(1, { stackId: 'a', stackPosition: 0 }),
      photo(2, { stackId: 'a', stackPosition: 1 }),
      photo(3, { stackId: 'b', stackPosition: 0 }),
      photo(4, { stackId: 'b', stackPosition: 1 }),
    ]);
    expect(index.get(1)?.id).toBe('a');
    expect(index.get(3)?.id).toBe('b');
    expect(index.get(3)).not.toBe(index.get(1));
  });
});

describe('collapseStacks', () => {
  const head = photo(1, { stackId: 's', stackPosition: 0 });
  const second = photo(2, { stackId: 's', stackPosition: 1 });
  const third = photo(3, { stackId: 's', stackPosition: 2 });
  const loose = photo(4);
  const index = buildStackIndex([head, second, third, loose]);

  it('keeps only the head and leaves unstacked photos alone', () => {
    expect(collapseStacks([head, second, third, loose], index).map((p) => p.id)).toEqual([1, 4]);
  });

  it('leaves an expanded stack unfolded', () => {
    const photos = collapseStacks([head, second, third, loose], index, new Set(['s']));
    expect(photos.map((p) => p.id)).toEqual([1, 2, 3, 4]);
  });

  it('promotes the first surviving member when the head was filtered out', () => {
    expect(collapseStacks([second, third, loose], index).map((p) => p.id)).toEqual([2, 4]);
  });

  it('returns the input untouched when nothing is stacked', () => {
    const photos = [loose];
    expect(collapseStacks(photos, buildStackIndex(photos))).toBe(photos);
  });
});

describe('stack lookups', () => {
  const index = buildStackIndex([
    photo(1, { stackId: 's', stackPosition: 0 }),
    photo(2, { stackId: 's', stackPosition: 1 }),
  ]);

  it('expands a member id to the whole stack and an unstacked id to itself', () => {
    expect(stackMemberIds(2, index)).toEqual([1, 2]);
    expect(stackMemberIds(99, index)).toEqual([99]);
  });

  it('names the head', () => {
    expect(isStackHead(1, index)).toBe(true);
    expect(isStackHead(2, index)).toBe(false);
    expect(isStackHead(99, index)).toBe(false);
  });
});

describe('planCreateStack', () => {
  it('numbers the members oldest frame first', () => {
    const updates = planCreateStack([
      photo(1, { dateTaken: 300 }),
      photo(2, { dateTaken: 100 }),
      photo(3, { dateTaken: 200 }),
    ], 'new');
    expect(ids(updates)).toEqual([[2, 'new', 0], [3, 'new', 1], [1, 'new', 2]]);
  });

  it('falls back to the file time when a photo has no capture time', () => {
    const updates = planCreateStack([
      photo(1, { dateModified: 500 }),
      photo(2, { dateTaken: 100 }),
    ], 'new');
    expect(ids(updates)).toEqual([[2, 'new', 0], [1, 'new', 1]]);
  });

  it('plans nothing for fewer than two photos', () => {
    expect(planCreateStack([photo(1)], 'new')).toEqual([]);
    expect(planCreateStack([], 'new')).toEqual([]);
  });
});

describe('planUnstack', () => {
  it('clears both stack columns and skips photos that carry none', () => {
    const updates = planUnstack([photo(1, { stackId: 's', stackPosition: 0 }), photo(2)]);
    expect(ids(updates)).toEqual([[1, null, null]]);
  });
});

describe('planSetStackHead', () => {
  const index = buildStackIndex([
    photo(1, { stackId: 's', stackPosition: 0 }),
    photo(2, { stackId: 's', stackPosition: 1 }),
    photo(3, { stackId: 's', stackPosition: 2 }),
  ]);

  it('moves the chosen photo to the front and renumbers the rest', () => {
    expect(ids(planSetStackHead(3, index))).toEqual([[3, 's', 0], [1, 's', 1], [2, 's', 2]]);
  });

  it('plans nothing for the current head or an unstacked photo', () => {
    expect(planSetStackHead(1, index)).toEqual([]);
    expect(planSetStackHead(99, index)).toEqual([]);
  });
});

describe('planAutoStack', () => {
  let counter = 0;
  const makeId = () => `auto-${++counter}`;

  it('groups shots inside the burst window and starts a new stack past it', () => {
    counter = 0;
    const updates = planAutoStack([
      photo(1, { dateTaken: 1000 }),
      photo(2, { dateTaken: 1400 }),
      photo(3, { dateTaken: 9000 }),
      photo(4, { dateTaken: 9500 }),
    ], makeId, 1000);

    expect(ids(updates)).toEqual([
      [1, 'auto-1', 0], [2, 'auto-1', 1],
      [3, 'auto-2', 0], [4, 'auto-2', 1],
    ]);
    expect(plannedStackCount(updates)).toBe(2);
  });

  it('chains a burst whose frames each stay inside the window', () => {
    counter = 0;
    const updates = planAutoStack([
      photo(1, { dateTaken: 0 }),
      photo(2, { dateTaken: 900 }),
      photo(3, { dateTaken: 1800 }),
    ], makeId, 1000);
    expect(ids(updates)).toEqual([[1, 'auto-1', 0], [2, 'auto-1', 1], [3, 'auto-1', 2]]);
  });

  it('leaves a single shot alone and never touches an existing stack', () => {
    counter = 0;
    const updates = planAutoStack([
      photo(1, { dateTaken: 1000 }),
      photo(2, { dateTaken: 50_000 }),
      photo(3, { dateTaken: 1100, stackId: 'manual', stackPosition: 0 }),
      photo(4, { dateTaken: 1200, stackId: 'manual', stackPosition: 1 }),
    ], makeId, 1000);
    expect(updates).toEqual([]);
  });

  it('skips photos without a capture time', () => {
    counter = 0;
    const updates = planAutoStack([photo(1), photo(2)], makeId, 1000);
    expect(updates).toEqual([]);
  });
});
