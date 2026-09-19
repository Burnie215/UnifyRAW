import { describe, expect, it, vi } from 'vitest';
import { EditorRawMemoryCache, rawCacheSingleFlight } from './EditorRawMemoryCache';
import type { RawPixelData } from './RawDecoderStrategy';

function pixels(values: number[]): RawPixelData {
  return { data: new Uint16Array(values), width: 1, height: 1, channels: 3, bits: 16 };
}

describe('EditorRawMemoryCache', () => {
  it('evicts the least recently used pixels by byte budget', () => {
    const cache = new EditorRawMemoryCache(12, 10);
    cache.put('a', 1200, pixels([1, 2, 3])); // 6 bytes
    cache.put('b', 1200, pixels([4, 5, 6])); // 6 bytes
    cache.get('a', 1200); // a is newest
    cache.put('c', 1200, pixels([7, 8, 9]));

    expect(cache.get('a', 1200)).not.toBeNull();
    expect(cache.get('b', 1200)).toBeNull();
    expect(cache.get('c', 1200)).not.toBeNull();
    expect(cache.byteSize).toBe(12);
  });

  it('deduplicates concurrent cache reads', async () => {
    let resolve!: (value: null) => void;
    const load = vi.fn(() => new Promise<null>((done) => { resolve = done; }));
    const first = rawCacheSingleFlight('photo', 1200, load);
    const second = rawCacheSingleFlight('photo', 1200, load);
    expect(first).toBe(second);
    expect(load).toHaveBeenCalledTimes(1);
    resolve(null);
    await Promise.all([first, second]);
  });
});
