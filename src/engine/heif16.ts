/**
 * 16-bit HEIF decoding through libheif's C API.
 *
 * The convenient JS wrapper (`HeifImage.display`) only ever writes into an
 * `ImageData`, which is 8 bit per channel by definition — that is a limit of
 * the wrapper, not of the library. The WASM build exports the full C API, so
 * a 10-bit HEIC can be read at its real depth by driving those functions
 * directly and reading the interleaved plane out of `HEAPU16`.
 *
 * Two conventions matter when calling in:
 *
 *   - libheif returns `heif_error` **by value**. Emscripten turns that into a
 *     hidden first pointer argument (sret), so every such function takes one
 *     more parameter here than the C header shows and returns void.
 *   - The decoded plane is padded to a row stride, which is given in bytes and
 *     is not necessarily `width * channels * 2`.
 *
 * The result is scene-linear, because the 16-bit editor path expects linear
 * light (see DefaultGraphBuilder: "for raw16 the source is already linear").
 * HEIF is gamma-encoded, so the transfer function is inverted on the way out.
 *
 * KNOWN LIMIT: the inverse transfer is sRGB/BT.709. libheif's WASM build does
 * not export the NCLX transfer-characteristics getter, so an HLG or PQ HEIF
 * cannot be detected here and would come out with the wrong tone response.
 * The 8-bit modes stay available as the fallback for those files.
 */

import type { RawPixelData } from './raw/RawDecoderStrategy';
import { resizeRaw16LongEdge } from './raw/resizeRaw16';

// Enum values from libheif/api/libheif/heif_image.h
const COLORSPACE_RGB = 1;
const CHROMA_INTERLEAVED_RRGGBB_LE = 14;
const CHANNEL_INTERLEAVED = 10;

/** sizeof(heif_error): two enums plus a message pointer under wasm32. */
const ERROR_STRUCT_BYTES = 12;
/** Camera HEIFs are opaque; alpha would only cost a quarter more memory. */
const CHANNELS = 3;

/** The subset of the Emscripten module this decoder drives. */
export interface LibheifProbeWasm {
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  _heif_context_alloc(): number;
  _heif_context_free(ctx: number): void;
  _heif_context_read_from_memory(err: number, ctx: number, mem: number, size: number, options: number): void;
  _heif_context_get_primary_image_handle(err: number, ctx: number, outHandle: number): void;
  _heif_image_handle_release(handle: number): void;
  _heif_image_handle_get_luma_bits_per_pixel(handle: number): number;
  _heif_image_handle_get_chroma_bits_per_pixel?(handle: number): number;
}

/** The full subset needed to decode 16-bit editor pixels. */
export interface LibheifWasm extends LibheifProbeWasm {
  HEAPU16: Uint16Array;
  _heif_decode_image(err: number, handle: number, outImage: number, colorspace: number, chroma: number, options: number): void;
  _heif_image_release(image: number): void;
  _heif_image_get_width(image: number, channel: number): number;
  _heif_image_get_height(image: number, channel: number): number;
  _heif_image_get_bits_per_pixel_range(image: number, channel: number): number;
  _heif_image_get_plane_readonly(image: number, channel: number, outStride: number): number;
}

/** True when the module exposes everything {@link decodeHeif16} needs. */
export function supportsHeif16(lib: unknown): lib is LibheifWasm {
  const m = lib as Partial<LibheifWasm> | null;
  if (!m) return false;
  const fns: (keyof LibheifWasm)[] = [
    '_malloc', '_free', '_heif_context_alloc', '_heif_context_free',
    '_heif_context_read_from_memory', '_heif_context_get_primary_image_handle',
    '_heif_decode_image', '_heif_image_handle_release', '_heif_image_release',
    '_heif_image_get_width', '_heif_image_get_height',
    '_heif_image_get_bits_per_pixel_range', '_heif_image_get_plane_readonly',
  ];
  return fns.every((fn) => typeof m[fn] === 'function')
    && m.HEAPU8 instanceof Uint8Array
    && m.HEAPU16 instanceof Uint16Array
    && m.HEAP32 instanceof Int32Array;
}

/** True when libheif can report encoded precision without decoding pixels. */
export function supportsHeifSourceBits(lib: unknown): lib is LibheifProbeWasm {
  const m = lib as Partial<LibheifProbeWasm> | null;
  if (!m) return false;
  const fns: (keyof LibheifProbeWasm)[] = [
    '_malloc', '_free', '_heif_context_alloc', '_heif_context_free',
    '_heif_context_read_from_memory', '_heif_context_get_primary_image_handle',
    '_heif_image_handle_release', '_heif_image_handle_get_luma_bits_per_pixel',
  ];
  return fns.every((fn) => typeof m[fn] === 'function')
    && m.HEAPU8 instanceof Uint8Array
    && m.HEAP32 instanceof Int32Array;
}

/**
 * Read the encoded primary image's precision without running the pixel
 * decoder. The current Emscripten memory API still needs the complete
 * container bytes, but it avoids allocating the decoded image and its RGB
 * planes. Invalid/missing channel values are ignored; at least one channel
 * must report a plausible value.
 */
export function probeHeifSourceBits(lib: LibheifProbeWasm, bytes: Uint8Array): number {
  const err = lib._malloc(ERROR_STRUCT_BYTES);
  const filePtr = lib._malloc(bytes.byteLength);
  const outPtr = lib._malloc(4);
  let ctx = 0;
  let handle = 0;
  const failed = () => lib.HEAP32[err >> 2] !== 0;

  try {
    lib.HEAPU8.set(bytes, filePtr);
    ctx = lib._heif_context_alloc();
    if (!ctx) throw new Error('heif: context allocation failed');

    lib._heif_context_read_from_memory(err, ctx, filePtr, bytes.byteLength, 0);
    if (failed()) throw new Error('heif: cannot read container');

    lib._heif_context_get_primary_image_handle(err, ctx, outPtr);
    if (failed()) throw new Error('heif: no primary image');
    handle = lib.HEAP32[outPtr >> 2];
    if (!handle) throw new Error('heif: empty primary image handle');

    const candidates = [
      lib._heif_image_handle_get_luma_bits_per_pixel(handle),
      lib._heif_image_handle_get_chroma_bits_per_pixel?.(handle) ?? 0,
    ].filter((bits) => Number.isInteger(bits) && bits >= 1 && bits <= 16);
    if (candidates.length === 0) throw new Error('heif: no plausible source bit depth');
    return Math.max(...candidates);
  } finally {
    if (handle) lib._heif_image_handle_release(handle);
    if (ctx) lib._heif_context_free(ctx);
    lib._free(outPtr);
    lib._free(filePtr);
    lib._free(err);
  }
}

/**
 * Lookup table from an n-bit gamma-encoded sample to a scene-linear 16-bit
 * one. Doing the range scaling and the inverse transfer in one table keeps the
 * per-pixel loop to a single array read, and it is only 2^bits entries — far
 * cheaper than a table over the full 16-bit range.
 */
export function buildLinearLut(bitsPerSample: number): Uint16Array {
  const max = (1 << bitsPerSample) - 1;
  const lut = new Uint16Array(max + 1);
  for (let i = 0; i <= max; i++) {
    const encoded = i / max;
    const linear = encoded <= 0.04045
      ? encoded / 12.92
      : Math.pow((encoded + 0.055) / 1.055, 2.4);
    lut[i] = Math.round(Math.max(0, Math.min(1, linear)) * 65535);
  }
  return lut;
}

/**
 * Copy a stride-padded interleaved RGB plane into a tightly packed buffer,
 * mapping every sample through `lut`.
 *
 * `heap` is indexed in 16-bit units; `planeByteOffset` and `strideBytes` come
 * from libheif in bytes, so both are halved on the way in.
 */
export function packInterleaved16(
  heap: Uint16Array,
  planeByteOffset: number,
  strideBytes: number,
  width: number,
  height: number,
  lut: Uint16Array,
): Uint16Array {
  const out = new Uint16Array(width * height * CHANNELS);
  const rowStride = strideBytes >> 1;
  const base = planeByteOffset >> 1;
  const clamp = lut.length - 1;

  for (let y = 0; y < height; y++) {
    let src = base + y * rowStride;
    let dst = y * width * CHANNELS;
    for (let x = 0; x < width * CHANNELS; x++) {
      const sample = heap[src++];
      out[dst++] = lut[sample > clamp ? clamp : sample];
    }
  }
  return out;
}

/**
 * Decode a HEIF file to scene-linear 16-bit pixels, downscaled to
 * `maxLongEdge` so memory behaves like the RAW smart-preview path.
 *
 * Throws on any libheif error; callers are expected to fall back to the 8-bit
 * decoder rather than surface a broken image.
 */
export function decodeHeif16(
  lib: LibheifWasm,
  bytes: Uint8Array,
  maxLongEdge: number,
): RawPixelData {
  const err = lib._malloc(ERROR_STRUCT_BYTES);
  const filePtr = lib._malloc(bytes.byteLength);
  const outPtr = lib._malloc(4);
  const stridePtr = lib._malloc(4);
  let ctx = 0;
  let handle = 0;
  let image = 0;

  const failed = () => lib.HEAP32[err >> 2] !== 0;

  try {
    lib.HEAPU8.set(bytes, filePtr);

    ctx = lib._heif_context_alloc();
    if (!ctx) throw new Error('heif: context allocation failed');

    lib._heif_context_read_from_memory(err, ctx, filePtr, bytes.byteLength, 0);
    if (failed()) throw new Error('heif: cannot read container');

    lib._heif_context_get_primary_image_handle(err, ctx, outPtr);
    if (failed()) throw new Error('heif: no primary image');
    handle = lib.HEAP32[outPtr >> 2];

    lib._heif_decode_image(err, handle, outPtr, COLORSPACE_RGB, CHROMA_INTERLEAVED_RRGGBB_LE, 0);
    if (failed()) throw new Error('heif: 16-bit decode refused');
    image = lib.HEAP32[outPtr >> 2];

    const width = lib._heif_image_get_width(image, CHANNEL_INTERLEAVED);
    const height = lib._heif_image_get_height(image, CHANNEL_INTERLEAVED);
    if (width <= 0 || height <= 0) throw new Error('heif: zero dimensions');

    // Per-channel depth: 10 for a typical HEIC, 8 when the file was 8-bit all
    // along and libheif widened it into 16-bit words.
    const bits = lib._heif_image_get_bits_per_pixel_range(image, CHANNEL_INTERLEAVED);
    if (bits < 1 || bits > 16) throw new Error(`heif: implausible bit depth ${bits}`);

    const plane = lib._heif_image_get_plane_readonly(image, CHANNEL_INTERLEAVED, stridePtr);
    if (!plane) throw new Error('heif: no interleaved plane');
    const stride = lib.HEAP32[stridePtr >> 2];

    const data = packInterleaved16(lib.HEAPU16, plane, stride, width, height, buildLinearLut(bits));
    const frame = resizeRaw16LongEdge({ data, width, height, channels: CHANNELS }, maxLongEdge);

    return {
      data: frame.data,
      width: frame.width,
      height: frame.height,
      channels: CHANNELS,
      bits: 16,
      sourceBits: bits,
      // Display-referred already: no camera matrix, no as-shot gains. The
      // graph builder falls back to identity for both when they are absent.
      colorMatrix: null,
      asShotNeutral: null,
    };
  } finally {
    if (image) lib._heif_image_release(image);
    if (handle) lib._heif_image_handle_release(handle);
    if (ctx) lib._heif_context_free(ctx);
    lib._free(stridePtr);
    lib._free(outPtr);
    lib._free(filePtr);
    lib._free(err);
  }
}
