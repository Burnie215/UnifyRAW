import { describe, expect, it } from 'vitest';
import { cropRaw16, resizeRaw16LongEdge } from './resizeRaw16';

describe('resizeRaw16LongEdge', () => {
  it('keeps linear 16-bit data and constrains the long edge', () => {
    const result = resizeRaw16LongEdge({
      data: new Uint16Array([
        0, 0, 0,       10_000, 20_000, 30_000,
        20_000, 30_000, 40_000, 40_000, 50_000, 60_000,
      ]),
      width: 4,
      height: 1,
      channels: 3,
    }, 2);

    expect(result.width).toBe(2);
    expect(result.height).toBe(1);
    expect(result.data).toBeInstanceOf(Uint16Array);
    expect([...result.data]).toEqual([
      5_000, 10_000, 15_000,
      30_000, 40_000, 50_000,
    ]);
  });

  it('copies pixels when no resize is required', () => {
    const data = new Uint16Array([1, 2, 3]);
    const result = resizeRaw16LongEdge({ data, width: 1, height: 1, channels: 3 }, 1200);
    expect(result.data).toEqual(data);
    expect(result.data).not.toBe(data);
  });
});

describe('cropRaw16', () => {
  /** 4x4 RGB frame whose red channel is the pixel index, for easy assertions. */
  function frame() {
    const data = new Uint16Array(4 * 4 * 3);
    for (let i = 0; i < 16; i++) {
      data[i * 3] = i;
      data[i * 3 + 1] = 1000 + i;
      data[i * 3 + 2] = 2000 + i;
    }
    return { data, width: 4, height: 4, channels: 3 as const };
  }

  it('cuts the requested square without resampling', () => {
    const result = cropRaw16(frame(), 1, 1, 2);
    expect(result.width).toBe(2);
    expect(result.height).toBe(2);
    // Rows 1 and 2, columns 1 and 2 - untouched sample values, not averages.
    expect([...result.data].filter((_, i) => i % 3 === 0)).toEqual([5, 6, 9, 10]);
  });

  it('pulls the cut inside the frame instead of reading past its edge', () => {
    const result = cropRaw16(frame(), 3, 3, 2);
    expect([...result.data].filter((_, i) => i % 3 === 0)).toEqual([10, 11, 14, 15]);
  });

  it('never returns a square larger than the frame', () => {
    const result = cropRaw16(frame(), 0, 0, 99);
    expect(result.width).toBe(4);
    expect(result.height).toBe(4);
  });
});
