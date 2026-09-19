/**
 * What the local RAW export path hands on — the buffer, not a copy of it.
 *
 * The decoder already returns `data16` as a view over the pixel buffer it
 * owns alone (its worker is terminated before `decode` returns), so the
 * `buffer.slice` this used to do was a second 361 MB for a 61-MP file, held
 * at the same moment as the first (F132).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SMART_PREVIEW_MAX_PX } from '@photolib/shared';

const decode = vi.fn();
const decodeHeif16 = vi.fn();
const probe = vi.fn();
const apiFetch = vi.fn();
const decodeTiff = vi.fn();
const webglCaps = vi.fn(() => ({ rgba16fRender: true }));

vi.mock('../webglCaps', () => ({
  detectWebGLCaps: () => webglCaps(),
}));
vi.mock('../HeifDecoder', () => ({
  heifDecoder: { decode16: (...args: unknown[]) => decodeHeif16(...args) },
}));
vi.mock('../RawDecoder', () => ({
  rawDecoder: { decode: (...args: unknown[]) => decode(...args) },
}));
vi.mock('./sourcePolicy', () => ({
  isLocalRawSourceType: (sourceType?: string) => sourceType === 'local',
}));
vi.mock('./smartPreviewProbe', () => ({
  probeSmartPreviewCache: (...args: unknown[]) => probe(...args),
}));
vi.mock('../../platform/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock('./tiff', () => ({
  decodeTiff: (...args: unknown[]) => decodeTiff(...args),
}));

const { loadFullResRawPixels, loadFullResHeifPixels } = await import('./exportRaw');

function decoded(width: number, height: number) {
  const bytes = new Uint8Array(width * height * 3 * 2);
  return {
    width, height, colors: 3, bits: 16,
    data: bytes,
    data16: new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2),
    metadata: { width, height },
  };
}

const file = new File([new Uint8Array(4)], 'DSC0001.ARW');
const backendPixels = new Uint16Array([101, 202, 303, 404, 505, 606]);

describe('loadFullResRawPixels, local decoder path', () => {
  beforeEach(() => decode.mockReset());

  it('passes the decoder16 view straight on instead of copying it', async () => {
    const raw = decoded(8, 4);
    decode.mockResolvedValue(raw);

    const result = await loadFullResRawPixels(file, 'k', 'local');

    expect(result?.data).toBe(raw.data16);
    expect(result).toMatchObject({ width: 8, height: 4, channels: 3, bits: 16 });
  });

  it('gives up rather than guess when the decoder returned no 16-bit view', async () => {
    decode.mockResolvedValue({ ...decoded(8, 4), data16: undefined });
    expect(await loadFullResRawPixels(file, 'k', 'local')).toBeNull();
  });
});

/**
 * The native export slot is the biggest upload this app makes. The backend
 * caches it, so a second device or a cleared browser has to be able to ask
 * for it instead of pushing the RAW again (F054).
 */
describe('loadFullResRawPixels, backend path', () => {
  beforeEach(() => {
    probe.mockReset();
    apiFetch.mockReset();
    decodeTiff.mockReset().mockReturnValue({
      data: backendPixels, width: 1, height: 2, channels: 3, bits: 16,
      // Simulate a legacy TIFF that still carries copied DNG tags. They are
      // metadata about the pre-developed camera samples, not these sRGB pixels.
      colorMatrix: [2, 0, 0, 0, 2, 0, 0, 0, 2],
      asShotNeutral: [0.5, 1, 0.75],
    });
  });

  it('takes the cached preview and uploads nothing', async () => {
    probe.mockResolvedValue(new Blob(['cached-tiff']));

    const result = await loadFullResRawPixels(file, 'k', 'immich');

    expect(probe).toHaveBeenCalledWith('k_native', 8000);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(result?.data).toBe(backendPixels);
    expect(result).toMatchObject({
      width: 1, height: 2, bits: 16,
      colorMatrix: null, asShotNeutral: null,
    });
  });

  it('uploads the RAW only after the probe missed', async () => {
    probe.mockResolvedValue(null);
    apiFetch.mockResolvedValue(new Response(new Uint8Array(4), { status: 200 }));

    const result = await loadFullResRawPixels(file, 'k', 'immich');

    expect(apiFetch).toHaveBeenCalledOnce();
    expect(apiFetch.mock.calls[0]?.[0]).toBe('/api/raw/smart-preview?size=8000&key=k_native');
    expect((apiFetch.mock.calls[0]?.[1] as RequestInit).method).toBe('POST');
    expect(result).toMatchObject({ width: 1, height: 2 });
  });
});

/**
 * HEIC used to be locked out of the 16-bit export entirely: the export only
 * ever loaded full pixels for RAW, so a 10-bit HEIC reached `renderPhoto`
 * with nothing but its 8-bit display blob and the export failed outright.
 * The loader below is that missing branch - and its `null` is a promise the
 * caller has to keep, because an 8-bit render labelled 16 bit is worse than
 * no file at all.
 */
describe('loadFullResHeifPixels', () => {
  const heic = new File([new Uint8Array(4)], 'IMG_0001.HEIC');
  const frame = () => ({
    data: new Uint16Array(6),
    width: 2, height: 1, channels: 3 as const, bits: 16 as const, sourceBits: 10,
    colorMatrix: null, asShotNeutral: null,
  });

  beforeEach(() => {
    decodeHeif16.mockReset();
    webglCaps.mockReset().mockReturnValue({ rgba16fRender: true });
  });

  it('hands the decoded 16-bit frame on, capped at the native ceiling', async () => {
    const pixels = frame();
    decodeHeif16.mockResolvedValue(pixels);

    expect(await loadFullResHeifPixels(heic)).toBe(pixels);
    expect(decodeHeif16).toHaveBeenCalledWith(heic, SMART_PREVIEW_MAX_PX);
  });

  it('reports nothing rather than 8-bit pixels when the C API has no 16-bit path', async () => {
    decodeHeif16.mockResolvedValue(null);
    expect(await loadFullResHeifPixels(heic)).toBeNull();
  });

  it('swallows a refused decode into a null so the caller can fall back', async () => {
    decodeHeif16.mockRejectedValue(new Error('heif: 16-bit decode refused'));
    expect(await loadFullResHeifPixels(heic)).toBeNull();
  });

  it('refuses a frame that claims 16 bit without a 16-bit buffer', async () => {
    decodeHeif16.mockResolvedValue({ ...frame(), data: new Uint8Array(12) });
    expect(await loadFullResHeifPixels(heic)).toBeNull();
  });

  it('does not even read the file when the browser cannot render 16-bit', async () => {
    webglCaps.mockReturnValue({ rgba16fRender: false });
    expect(await loadFullResHeifPixels(heic)).toBeNull();
    expect(decodeHeif16).not.toHaveBeenCalled();
  });
});
