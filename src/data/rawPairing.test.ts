import { describe, expect, it } from 'vitest';
import type { PhotoView } from '../storage/repos';
import { buildRawPairIndex, collapseRawPairs, pairMembers, pairPartner } from './rawPairing';

function photo(id: number, sourcePath: string, sourceId = 'src'): PhotoView {
  const name = sourcePath.slice(sourcePath.lastIndexOf('/') + 1);
  return { id, name, sourceId, sourcePath, sourcePhotoId: sourcePath, contentHash: `h${id}` } as PhotoView;
}

describe('buildRawPairIndex', () => {
  it('pairs a RAW with its JPEG sibling in the same folder', () => {
    const jpg = photo(1, '2024/IMG_1234.JPG');
    const raw = photo(2, '2024/IMG_1234.ARW');
    const index = buildRawPairIndex([jpg, raw]);

    expect(index.get(1)).toEqual({ display: jpg, raw, lead: jpg });
    expect(index.get(2)).toEqual({ display: jpg, raw, lead: jpg });
  });

  it('covers the RAW and display extensions beyond ARW/JPG', () => {
    const pairs: [string, string][] = [
      ['a/IMG_1.HIF', 'a/IMG_1.CR3'],
      ['b/IMG_2.heic', 'b/IMG_2.nef'],
      ['c/IMG_3.jpeg', 'c/IMG_3.rw2'],
      ['d/IMG_4.png', 'd/IMG_4.dng'],
    ];
    for (const [displayPath, rawPath] of pairs) {
      const index = buildRawPairIndex([photo(1, displayPath), photo(2, rawPath)]);
      expect(index.size, `${displayPath} + ${rawPath}`).toBe(2);
    }
  });

  it('ignores case and matches on the base name only', () => {
    const index = buildRawPairIndex([photo(1, '2024/img_1234.jpg'), photo(2, '2024/IMG_1234.ARW')]);
    expect(index.size).toBe(2);
  });

  it('does not pair across folders or across sources', () => {
    expect(buildRawPairIndex([
      photo(1, 'JPG/IMG_1234.JPG'),
      photo(2, 'RAW/IMG_1234.ARW'),
    ]).size).toBe(0);

    expect(buildRawPairIndex([
      photo(1, '2024/IMG_1234.JPG', 'immich'),
      photo(2, '2024/IMG_1234.ARW', 'webdav'),
    ]).size).toBe(0);
  });

  it('leaves ambiguous groups unpaired', () => {
    // One RAW, two display candidates - guessing would hide one of them.
    const index = buildRawPairIndex([
      photo(1, '2024/IMG_1234.JPG'),
      photo(2, '2024/IMG_1234.HIF'),
      photo(3, '2024/IMG_1234.ARW'),
    ]);
    expect(index.size).toBe(0);
  });

  it('ignores files that are neither RAW nor a displayable image', () => {
    const index = buildRawPairIndex([photo(1, '2024/IMG_1234.xmp'), photo(2, '2024/IMG_1234.ARW')]);
    expect(index.size).toBe(0);
  });
});

describe('collapseRawPairs', () => {
  const jpg = photo(1, '2024/IMG_1234.JPG');
  const raw = photo(2, '2024/IMG_1234.ARW');
  const loose = photo(3, '2024/IMG_9999.ARW');
  const index = buildRawPairIndex([jpg, raw, loose]);

  it('keeps the display file and drops its RAW', () => {
    expect(collapseRawPairs([jpg, raw, loose], index).map((p) => p.id)).toEqual([1, 3]);
  });

  it('keeps a RAW whose display sibling was filtered out', () => {
    expect(collapseRawPairs([raw, loose], index).map((p) => p.id)).toEqual([2, 3]);
  });
});

describe('pairPartner', () => {
  const jpg = photo(1, '2024/IMG_1234.JPG');
  const raw = photo(2, '2024/IMG_1234.ARW');
  const index = buildRawPairIndex([jpg, raw]);

  it('resolves in both directions', () => {
    expect(pairPartner(jpg, index)?.id).toBe(2);
    expect(pairPartner(raw, index)?.id).toBe(1);
  });

  it('returns null for an unpaired photo', () => {
    expect(pairPartner(photo(9, '2024/solo.jpg'), index)).toBeNull();
  });
});

describe('the half a pair leads with', () => {
  const jpg = photo(1, '2024/IMG_1234.JPG');
  const raw = photo(2, '2024/IMG_1234.ARW');

  it('is the JPEG while neither half has been edited', () => {
    expect(buildRawPairIndex([jpg, raw]).get(1)?.lead.id).toBe(1);
    expect(buildRawPairIndex([jpg, raw], new Map()).get(1)?.lead.id).toBe(1);
  });

  it('follows the most recently edited half', () => {
    const rawEdited = new Map([['h1', 1_000], ['h2', 2_000]]);
    expect(buildRawPairIndex([jpg, raw], rawEdited).get(1)?.lead.id).toBe(2);

    const jpgEdited = new Map([['h1', 3_000], ['h2', 2_000]]);
    expect(buildRawPairIndex([jpg, raw], jpgEdited).get(1)?.lead.id).toBe(1);
  });

  it('keeps the JPEG in front when both were edited at the same moment', () => {
    const both = new Map([['h1', 5_000], ['h2', 5_000]]);
    expect(buildRawPairIndex([jpg, raw], both).get(1)?.lead.id).toBe(1);
  });

  it('decides which half the grid keeps', () => {
    const rawEdited = new Map([['h2', 9_000]]);
    const index = buildRawPairIndex([jpg, raw], rawEdited);
    expect(collapseRawPairs([jpg, raw], index).map((p) => p.id)).toEqual([2]);
  });
});

describe('pairMembers', () => {
  const jpg = photo(1, '2024/IMG_1234.JPG');
  const raw = photo(2, '2024/IMG_1234.ARW');
  const index = buildRawPairIndex([jpg, raw]);

  it('returns both halves for either member', () => {
    expect(pairMembers(1, index).sort()).toEqual([1, 2]);
    expect(pairMembers(2, index).sort()).toEqual([1, 2]);
  });

  it('returns the photo itself when it has no pair', () => {
    expect(pairMembers(99, index)).toEqual([99]);
  });
});
