import { describe, expect, it } from 'vitest';

import { addRetouchSpot, removeRetouchSpot } from './documentRetouch';
import { createDocument, type PhotoDocument } from './DocumentModel';
import { MAX_RETOUCH_SPOTS } from './graph';
import type { SpotRemoval } from './Mask';

const SPOT: Omit<SpotRemoval, 'id'> = {
  mode: 'heal',
  target: { x: 0.5, y: 0.5, radius: 0.1 },
  source: { x: 0.2, y: 0.5 },
  feather: 0.5, opacity: 1,
};

const withSpots = (n: number): PhotoDocument => ({
  ...createDocument(),
  retouch: Array.from({ length: n }, (_, i) => ({ ...SPOT, id: `s${i}` })),
});

describe('addRetouchSpot', () => {
  it('creates the field on the first spot and appends after that', () => {
    const first = addRetouchSpot(createDocument(), SPOT, 's1');
    expect(first.retouch).toEqual([{ ...SPOT, id: 's1' }]);
    expect(addRetouchSpot(first, SPOT, 's2').retouch).toHaveLength(2);
  });

  it('leaves the rest of the document alone', () => {
    const doc = createDocument();
    const next = addRetouchSpot(doc, SPOT, 's1');
    expect(next.layers).toBe(doc.layers);
    expect(doc.retouch).toBeUndefined();
  });

  it('refuses the spot past the shader limit instead of storing a dead one', () => {
    const full = withSpots(MAX_RETOUCH_SPOTS);
    expect(addRetouchSpot(full, SPOT, 'over')).toBe(full);
  });
});

describe('removeRetouchSpot', () => {
  it('drops the named spot and keeps the others in order', () => {
    const next = removeRetouchSpot(withSpots(3), 's1');
    expect(next.retouch?.map((s) => s.id)).toEqual(['s0', 's2']);
  });

  it('takes the field away with the last spot', () => {
    // `retouch: []` is not the same document as no retouch: it hashes to a
    // different export filename and does not project back byte-identically.
    const next = removeRetouchSpot(withSpots(1), 's0');
    expect('retouch' in next).toBe(false);
  });

  it('is a no-op for an id that is not there', () => {
    const doc = withSpots(2);
    expect(removeRetouchSpot(doc, 'nope')).toBe(doc);
    expect(removeRetouchSpot(createDocument(), 's0').retouch).toBeUndefined();
  });
});
