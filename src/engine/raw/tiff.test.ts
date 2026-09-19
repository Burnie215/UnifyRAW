import { describe, expect, it, vi } from 'vitest';

const utif = vi.hoisted(() => {
  const samples = new Uint16Array([101, 202, 303, 404, 505, 606]);
  return {
    ifd: {
      width: 2,
      height: 1,
      t258: [16, 16, 16],
      t277: [3],
      data: new Uint8Array(samples.buffer),
      // Include both the tag the old code confused with AsShotNeutral and
      // the actual DNG calibration tags. Developed TIFF pixels must not
      // acquire either calibration vocabulary.
      t33422: [2, 1, 1.5],
      t50721: [2, 0, 0, 0, 2, 0, 0, 0, 2],
      t50728: [0.5, 1, 0.75],
    },
    decodeImage: vi.fn(),
  };
});

vi.mock('utif', () => ({
  decode: () => [utif.ifd],
  decodeImage: utif.decodeImage,
}));

import { decodeTiff } from './tiff';

describe('decodeTiff calibration boundary (F070)', () => {
  it('returns developed samples unchanged and transports no DNG calibration', () => {
    const decoded = decodeTiff(new ArrayBuffer(8));

    expect(decoded).toMatchObject({ width: 2, height: 1, bits: 16, channels: 3 });
    expect(Array.from(decoded.data)).toEqual([101, 202, 303, 404, 505, 606]);
    expect(Object.keys(decoded).sort()).toEqual(['bits', 'channels', 'data', 'height', 'width']);
    expect(utif.decodeImage).toHaveBeenCalledOnce();
  });
});
