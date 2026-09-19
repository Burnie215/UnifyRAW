import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { smartPreviewFileName } from '@photolib/shared';
import { createFakeDirectory, listFakeEntries } from '../../test/fakeFileSystem';
import type { RawPixelData } from './RawDecoderStrategy';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../../platform/api', () => ({ apiFetch }));
vi.mock('../webglCaps', () => ({
  detectWebGLCaps: () => ({ webgl2: true, rgba16fRender: true, reason: null }),
}));

const convertToBlob = vi.hoisted(() => vi.fn());

class FakeOffscreenCanvas {
  getContext() { return { putImageData: () => {}, drawImage: () => {} }; }
  convertToBlob(): Promise<Blob> { return convertToBlob(); }
}
class FakeImageData {}

const KEY = 'immich_asset_abc';
const SIZE = 1200;
const TIFF_SLOT = smartPreviewFileName(KEY, SIZE, 'tiff');
const FILL = 900;
let root: FileSystemDirectoryHandle;

/**
 * Smallest real smart-preview TIFF: uncompressed little-endian 16-bit RGB.
 * 100x100 keeps it over the 50 KB plausibility floor that `readOpfsCache`
 * uses to spot truncated cache files.
 */
function tiff16(width = 100, height = 100, fill = FILL): ArrayBuffer {
  const channels = 3;
  const SHORT = 3, LONG = 4;
  const ifdOffset = 8;
  const tags: [number, number, number, number][] = [];
  const ifdSize = 2 + 9 * 12 + 4;
  const bpsOffset = ifdOffset + ifdSize;
  const dataOffset = bpsOffset + 6;
  const dataBytes = width * height * channels * 2;
  tags.push([256, LONG, 1, width]);
  tags.push([257, LONG, 1, height]);
  tags.push([258, SHORT, 3, bpsOffset]);
  tags.push([259, SHORT, 1, 1]);
  tags.push([262, SHORT, 1, 2]);
  tags.push([273, LONG, 1, dataOffset]);
  tags.push([277, SHORT, 1, channels]);
  tags.push([278, LONG, 1, height]);
  tags.push([279, LONG, 1, dataBytes]);

  const buf = new ArrayBuffer(dataOffset + dataBytes);
  const view = new DataView(buf);
  view.setUint16(0, 0x4949, true);
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffset, true);
  view.setUint16(ifdOffset, tags.length, true);
  tags.forEach(([tag, type, count, value], i) => {
    const at = ifdOffset + 2 + i * 12;
    view.setUint16(at, tag, true);
    view.setUint16(at + 2, type, true);
    view.setUint32(at + 4, count, true);
    if (type === SHORT && count === 1) view.setUint16(at + 8, value, true);
    else view.setUint32(at + 8, value, true);
  });
  view.setUint32(ifdOffset + 2 + tags.length * 12, 0, true);
  for (let i = 0; i < channels; i++) view.setUint16(bpsOffset + i * 2, 16, true);
  new Uint16Array(buf, dataOffset, width * height * channels).fill(fill);
  return buf;
}

function samplePixels(): RawPixelData {
  return {
    data: new Uint16Array(24).fill(FILL), width: 4, height: 2, channels: 3, bits: 16,
    colorMatrix: null, asShotNeutral: null,
  };
}

async function writeTiffSlot(): Promise<void> {
  const previews = await root.getDirectoryHandle('smart-previews', { create: true });
  const writable = await (await previews.getFileHandle(TIFF_SLOT, { create: true })).createWritable();
  await writable.write(new Uint8Array(tiff16()));
  await writable.close();
}

async function load() {
  const [{ SmartPreviewStrategy }, { getDefaultRawPixelsCache }, { previewVariant }] = await Promise.all([
    import('./SmartPreviewStrategy'),
    import('./RawPixelsOpfsCache'),
    import('./previewSlots'),
  ]);
  return { strategy: new SmartPreviewStrategy(), pixels: getDefaultRawPixelsCache(), variant: previewVariant(SIZE) };
}

beforeEach(() => {
  root = createFakeDirectory();
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
  vi.stubGlobal('ImageData', FakeImageData);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.resetModules();
  apiFetch.mockReset();
  apiFetch.mockResolvedValue(new Response('backend down', { status: 503 }));
  convertToBlob.mockReset();
  convertToBlob.mockResolvedValue(new Blob(['jpeg'], { type: 'image/jpeg' }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('one TIFF to result conversion (F025)', () => {
  it('reads a real 16-bit TIFF into pixels the graph can take', async () => {
    const { strategy } = await load();
    await writeTiffSlot();

    const result = await strategy.decodeFromCache(KEY, SIZE);

    expect(result?.bits).toBe(16);
    expect(result?.width).toBe(100);
    expect(result?.rawPixels?.channels).toBe(3);
    expect(result?.rawPixels?.data).toBeInstanceOf(Uint16Array);
    expect(result?.rawPixels?.data[0]).toBe(FILL);
    // `dcraw_emu -o 1` already emitted sRGB primaries, so no client matrix.
    expect(result?.rawPixels?.colorMatrix).toBeNull();
    // `dcraw_emu -w` already applied camera WB, so no client WB gain either.
    expect(result?.rawPixels?.asShotNeutral).toBeNull();
  });

  it('builds no preview when the caller only wants the pixels', async () => {
    const { strategy } = await load();
    await writeTiffSlot();

    const result = await strategy.decodeFromCache(KEY, SIZE, { wantPreview: false });

    expect(result?.rawPixels?.data[0]).toBe(FILL);
    expect(result?.displayUrl).toBe('');
    expect(convertToBlob).not.toHaveBeenCalled();
  });

  it('builds the preview by default', async () => {
    const { strategy } = await load();
    await writeTiffSlot();

    const result = await strategy.decodeFromCache(KEY, SIZE);

    expect(result?.displayUrl.startsWith('blob:')).toBe(true);
    expect(convertToBlob).toHaveBeenCalledTimes(1);
  });
});

describe('every transport asks the cache first (F025)', () => {
  it('serves a prepared server path from the TIFF slot without a request', async () => {
    const { strategy } = await load();
    await writeTiffSlot();

    const result = await strategy.decodeFromPreparedUrl('/api/raw/prepared/a1', KEY, SIZE);

    expect(result?.rawPixels?.data[0]).toBe(FILL);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('serves a fetch hint from the pixel cache without a request', async () => {
    const { strategy, pixels, variant } = await load();
    await pixels.put(KEY, variant, samplePixels());

    const result = await strategy.decodeFromUrl(
      { url: 'https://immich/asset/a1', headers: {} }, KEY, SIZE,
    );

    expect(result?.rawPixels?.data).toEqual(samplePixels().data);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('drops legacy cached calibration without changing a pixel', async () => {
    const { strategy, pixels, variant } = await load();
    const legacy = {
      ...samplePixels(),
      asShotNeutral: [2, 1, 1.5] as [number, number, number],
      colorMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    };
    await pixels.put(KEY, variant, legacy);

    const result = await strategy.decodeFromCache(KEY, SIZE, { wantPreview: false });

    expect(result?.rawPixels?.data).toEqual(legacy.data);
    expect(result?.rawPixels?.asShotNeutral).toBeNull();
    expect(result?.rawPixels?.colorMatrix).toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('promotes the TIFF slot into the pixel cache and drops the file', async () => {
    const { strategy, pixels, variant } = await load();
    await writeTiffSlot();
    const previews = await root.getDirectoryHandle('smart-previews');

    await strategy.decodeFromPreparedUrl('/api/raw/prepared/a1', KEY, SIZE);

    await vi.waitFor(async () => expect(await listFakeEntries(previews)).not.toContain(TIFF_SLOT));
    expect(await pixels.has(KEY, variant)).toBe(true);
  });

  it('still fetches and caches when nothing is cached yet', async () => {
    const { strategy } = await load();
    apiFetch.mockResolvedValue(new Response(tiff16(), { status: 200 }));

    const result = await strategy.decodeFromPreparedUrl('/api/raw/prepared/a1', KEY, SIZE);

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(result?.rawPixels?.data[0]).toBe(FILL);
    const previews = await root.getDirectoryHandle('smart-previews');
    await vi.waitFor(async () => expect(await listFakeEntries(previews)).toContain(TIFF_SLOT));
  });
});
