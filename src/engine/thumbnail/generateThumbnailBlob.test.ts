import { beforeEach, describe, expect, it, vi } from 'vitest';

const rawMocks = vi.hoisted(() => ({
  embedded: vi.fn(),
  decodePreview: vi.fn(),
  toImageBitmap: vi.fn(),
}));

vi.mock('../RawDecoder', () => ({
  RawDecoder: { isRawFile: (name: string) => name.toLowerCase().endsWith('.raf') },
  rawDecoder: {
    extractLargestEmbeddedJpeg: rawMocks.embedded,
    decodePreview: rawMocks.decodePreview,
    toImageBitmap: rawMocks.toImageBitmap,
  },
}));

vi.mock('../HeifDecoder', () => ({
  HeifDecoder: { isHeifFile: () => false, sniffHeif: vi.fn(async () => false) },
  heifDecoder: { decode: vi.fn() },
}));

import { generateThumbnailBlob } from './generateThumbnailBlob';

function bitmap(width = 600, height = 400) {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap;
}

describe('generateThumbnailBlob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('OffscreenCanvas', class {
      width: number;
      height: number;
      constructor(width: number, height: number) { this.width = width; this.height = height; }
      getContext() { return { drawImage: vi.fn() }; }
      async convertToBlob() { return new Blob(['thumb'], { type: 'image/jpeg' }); }
    });
  });

  it('uses the embedded JPEG for a RAF thumbnail without a full demosaic', async () => {
    rawMocks.embedded.mockResolvedValue(new Blob(['jpeg'], { type: 'image/jpeg' }));
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap()));
    const file = Object.assign(new Blob(['raw']), { name: 'image.RAF' }) as File;

    const result = await generateThumbnailBlob(file, 300);

    expect(result.type).toBe('image/jpeg');
    expect(rawMocks.embedded).toHaveBeenCalledWith(file);
    expect(rawMocks.decodePreview).not.toHaveBeenCalled();
  });

  it('falls back to libraw when the RAW has no embedded preview', async () => {
    const decoded = { width: 10, height: 10 };
    rawMocks.embedded.mockResolvedValue(null);
    rawMocks.decodePreview.mockResolvedValue(decoded);
    rawMocks.toImageBitmap.mockResolvedValue(bitmap(10, 10));
    const file = Object.assign(new Blob(['raw']), { name: 'image.RAF' }) as File;

    await generateThumbnailBlob(file, 300);

    expect(rawMocks.decodePreview).toHaveBeenCalledWith(file);
    expect(rawMocks.toImageBitmap).toHaveBeenCalledWith(decoded);
  });
});
