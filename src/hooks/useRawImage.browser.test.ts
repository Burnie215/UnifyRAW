import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { RawDecodeResult } from '../engine/raw/RawDecoderStrategy';
import type { RawLoadRequest } from '../engine/raw/loadRawPixels';

interface PendingLoad {
  sourcePhotoId: string;
  resolve: (result: RawDecodeResult | null) => void;
}

const pending = vi.hoisted(() => [] as PendingLoad[]);

vi.mock('../engine/raw/loadRawPixels', () => ({
  loadRawPixels: vi.fn((request: RawLoadRequest) => new Promise<RawDecodeResult | null>((resolve) => {
    pending.push({ sourcePhotoId: request.identity.sourcePhotoId, resolve });
  })),
}));

import { useRawImage } from './useRawImage';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function decoded(value: number): RawDecodeResult {
  return {
    displayUrl: `data:image/jpeg;base64,${value}`,
    width: 1,
    height: 1,
    bits: 16,
    source: 'smart-preview',
    rawPixels: {
      data: new Uint16Array([value, value, value]),
      width: 1,
      height: 1,
      channels: 3,
      bits: 16,
    },
  };
}

describe('useRawImage photo identity', () => {
  it('drops the previous RAW pixels while the next photo is still decoding', async () => {
    pending.length = 0;
    const probe: { pixels: Uint16Array | Uint8Array | null } = { pixels: null };
    function Probe({ photoId }: { photoId: string }) {
      const result = useRawImage(null, {
        identity: { sourceId: 'source', sourcePhotoId: photoId },
        filename: `${photoId}.CR3`,
        size: 256,
      });
      probe.pixels = result.rawPixels?.data ?? null;
      return null;
    }

    const host = document.createElement('div');
    document.body.appendChild(host);
    let root: Root;
    act(() => {
      root = createRoot(host);
      root.render(createElement(Probe, { photoId: 'first' }));
    });
    expect(pending.map((load) => load.sourcePhotoId)).toEqual(['first']);

    await act(async () => {
      pending[0].resolve(decoded(111));
      await Promise.resolve();
    });
    expect(Array.from(probe.pixels ?? [])).toEqual([111, 111, 111]);

    act(() => root.render(createElement(Probe, { photoId: 'second' })));
    expect(pending.map((load) => load.sourcePhotoId)).toEqual(['first', 'second']);
    expect(probe.pixels).toBeNull();

    act(() => root.unmount());
    host.remove();
  });
});
