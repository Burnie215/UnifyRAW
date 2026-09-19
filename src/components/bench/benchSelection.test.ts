import { describe, expect, it } from 'vitest';
import { analyseBenchSelection, benchSelectionHint } from './benchSelection';
import type { PhotoView } from '../../storage/repos';

let nextId = 1;
function photo(name: string, camera: string | null, lens: string | null): PhotoView {
  return { id: nextId++, name, camera, lens } as unknown as PhotoView;
}

const R5 = 'Canon EOS R5';
const R6 = 'Canon EOS R6';
const L24 = 'RF 24-70mm F2.8 L IS USM';
const L50 = 'RF 50mm F1.2 L USM';

describe('analyseBenchSelection', () => {
  it('reports the camera and lens when every photo agrees', () => {
    const s = analyseBenchSelection([photo('a.cr3', R5, L24), photo('b.cr3', R5, L24)]);
    expect(s.camera?.label).toBe(R5);
    expect(s.lens?.label).toBe(L24);
    expect(s.rawCount).toBe(2);
  });

  it('drops the lens when the selection mixes two of them', () => {
    const s = analyseBenchSelection([photo('a.cr3', R5, L24), photo('b.cr3', R5, L50)]);
    expect(s.camera?.label).toBe(R5);
    expect(s.lens).toBeNull();
    expect(s.lensCount).toBe(2);
  });

  it('drops the camera when the selection mixes two bodies', () => {
    const s = analyseBenchSelection([photo('a.cr3', R5, L24), photo('b.cr3', R6, L24)]);
    expect(s.camera).toBeNull();
    expect(s.lens?.label).toBe(L24);
  });

  it('folds two spellings of one body together', () => {
    const s = analyseBenchSelection([
      photo('a.nef', 'NIKON CORPORATION NIKON Z 8', 'NIKKOR Z 50mm f/1.8 S'),
      photo('b.nef', 'Nikon Z 8', 'NIKKOR Z 50mm f1.8 S'),
    ]);
    expect(s.camera).not.toBeNull();
    expect(s.lens).not.toBeNull();
  });

  it('lets one unlabelled photo break the agreement', () => {
    // Counting a nameless frame as a match would let a single stray photo make
    // any selection look uniform, and the profile would then cover a body it
    // was never measured on.
    const s = analyseBenchSelection([photo('a.cr3', R5, L24), photo('b.jpg', null, null)]);
    expect(s.camera).toBeNull();
    expect(s.lens).toBeNull();
  });

  it('counts how many of the photos a profile could reach', () => {
    const s = analyseBenchSelection([photo('a.cr3', R5, L24), photo('b.jpg', R5, L24)]);
    expect(s.rawCount).toBe(1);
  });
});

describe('benchSelectionHint', () => {
  it('asks for more photos below the minimum', () => {
    expect(benchSelectionHint(analyseBenchSelection([photo('a.cr3', R5, L24)])))
      .toMatch(/mindestens 2 Bilder/);
  });

  it('points at the tiles rather than counting cameras', () => {
    // A count leaves the user to find the odd one among nine; a frame around
    // the tile is the answer itself, so the hint describes the frames.
    const hint = benchSelectionHint(analyseBenchSelection([
      photo('a.cr3', R5, L24), photo('b.cr3', R6, L50),
    ]));
    expect(hint).toMatch(/umrahmt/);
    expect(hint).toMatch(/×/);
    expect(hint).toMatch(/✓/);
  });

  it('counts the odd ones, singular and plural', () => {
    const one = benchSelectionHint(analyseBenchSelection([
      photo('a.cr3', R5, L24), photo('b.cr3', R5, L24), photo('c.jpg', null, null),
    ]));
    expect(one).toMatch(/^Ein Bild passt/);
    const two = benchSelectionHint(analyseBenchSelection([
      photo('a.cr3', R5, L24), photo('b.cr3', R5, L24),
      photo('c.jpg', null, null), photo('d.jpg', null, null),
    ]));
    expect(two).toMatch(/^2 Bilder passen/);
  });

  it('says so when the selection holds no RAW', () => {
    expect(benchSelectionHint(analyseBenchSelection([
      photo('a.jpg', R5, L24), photo('b.jpg', R5, L24),
    ]))).toMatch(/Kein RAW/);
  });

  it('is silent when something can be saved', () => {
    expect(benchSelectionHint(analyseBenchSelection([
      photo('a.cr3', R5, L24), photo('b.cr3', R5, L50),
    ]))).toBeNull();
  });
});


describe('naming the odd photos', () => {
  it('frames the one photo that records nothing', () => {
    const good1 = photo('a.cr3', R5, L24);
    const good2 = photo('b.cr3', R5, L24);
    const blank = photo('c.jpg', null, null);
    const s = analyseBenchSelection([good1, good2, blank]);
    expect([...s.odd.keys()]).toEqual([blank.id]);
    expect(s.odd.get(blank.id)).toBe('both');
  });

  it('says which of the two it is when only the lens differs', () => {
    const odd = photo('c.cr3', R5, L50);
    const s = analyseBenchSelection([photo('a.cr3', R5, L24), photo('b.cr3', R5, L24), odd]);
    expect(s.odd.get(odd.id)).toBe('lens');
    // The camera still agrees, so a camera profile is on the table.
    expect(s.camera?.label).toBe(R5);
  });

  it('frames the minority, not the majority', () => {
    const a = photo('a.cr3', R5, L24);
    const b = photo('b.cr3', R5, L24);
    const c = photo('c.cr3', R6, L24);
    expect([...analyseBenchSelection([a, b, c]).odd.keys()]).toEqual([c.id]);
  });

  it('lets a vouched-for photo count as belonging', () => {
    const blank = photo('c.jpg', null, null);
    const photos = [photo('a.cr3', R5, L24), photo('b.cr3', R5, L24), blank];
    const before = analyseBenchSelection(photos);
    expect(before.camera).toBeNull();

    const after = analyseBenchSelection(photos, new Set([blank.id]));
    expect(after.camera?.label).toBe(R5);
    expect(after.lens?.label).toBe(L24);
    expect(after.odd.size).toBe(0);
    expect(benchSelectionHint(after)).toBeNull();
  });
});
