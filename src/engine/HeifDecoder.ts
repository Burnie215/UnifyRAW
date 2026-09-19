/**
 * HEIF / HEIC / HIF image decoder using libheif-js (WASM).
 * Sony saves HEIF as .HIF — same container, different extension.
 */

import type { RawPixelData } from './raw/RawDecoderStrategy';
import {
  decodeHeif16,
  probeHeifSourceBits,
  supportsHeif16,
  supportsHeifSourceBits,
} from './heif16';
import { STORAGE_KEYS } from '../platform/storageKeys';

const HEIF_EXTENSIONS = new Set(['heic', 'heif', 'hif']);

/**
 * How a HEIF reaches the editor.
 *
 *  - `jpeg`     decode to 8 bit, re-encode as JPEG q0.94. The long-standing
 *               behaviour: cheap and universally accepted by the pipeline,
 *               but it re-compresses the image before you edit it.
 *  - `lossless` decode to 8 bit, hand over as PNG. Same depth, no
 *               re-compression; costs a slower encode and a bigger blob.
 *  - `linear16` decode at the file's real depth into scene-linear 16-bit and
 *               use the same path RAW takes. Most headroom, most memory.
 */
export type HeifMode = 'jpeg' | 'lossless' | 'linear16';

export const HEIF_MODES: readonly HeifMode[] = ['jpeg', 'lossless', 'linear16'];
/** Unchanged behaviour stays the default; the others are opt-in. */
export const DEFAULT_HEIF_MODE: HeifMode = 'jpeg';

const MODE_KEY = STORAGE_KEYS.heifMode;

export function getHeifMode(): HeifMode {
  try {
    const stored = localStorage.getItem(MODE_KEY);
    if (stored && (HEIF_MODES as readonly string[]).includes(stored)) return stored as HeifMode;
  } catch { /* private mode / disabled storage */ }
  return DEFAULT_HEIF_MODE;
}

export function setHeifMode(mode: HeifMode): void {
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* non-fatal */ }
}

// libheif's browser build is one self-contained Emscripten module (including
// its WASM binary). Treat it as a hashed runtime asset so the bundler does not
// try to merge or split this indivisible 1.4 MB third-party module.
const LIBHEIF_MODULE_URL = new URL(
  '../../node_modules/libheif-js/libheif-wasm/libheif-bundle.mjs',
  import.meta.url,
).href;

interface HeifImage {
  get_width(): number;
  get_height(): number;
  display(imageData: ImageData, cb: (data: ImageData | null) => void): void;
}

interface HeifDecoderJs {
  decode(buffer: ArrayBuffer | Uint8Array): HeifImage[];
}

type LibheifModule = {
  HeifDecoder: new () => HeifDecoderJs;
};

export class HeifDecoder {
  private libheifPromise: Promise<LibheifModule> | null = null;

  static isHeifFile(name: string): boolean {
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    return HEIF_EXTENSIONS.has(ext);
  }

  /** Magic-byte sniff for files without a HEIF extension (`.jpg` containing HEIF, etc). */
  static async sniffHeif(file: File): Promise<boolean> {
    if (file.size < 12) return false;
    const head = new Uint8Array(await file.slice(0, Math.min(file.size, 128)).arrayBuffer());
    // ISO BMFF: bytes 4..8 = "ftyp"
    if (head[4] !== 0x66 || head[5] !== 0x74 || head[6] !== 0x79 || head[7] !== 0x70) return false;
    const supportedBrands = new Set([
      'heic', 'heix', 'mif1', 'msf1', 'heim', 'heis',
      'hevc', 'hevx', 'hevm', 'hevs', 'heif', 'mif2',
    ]);
    const boxSize = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(0);
    const end = Math.min(head.length, boxSize >= 16 ? boxSize : head.length);
    // Check the major brand and every compatible brand. Bytes 12..15 are the
    // minor version, not a brand.
    for (const offset of [8, ...range(16, end, 4)]) {
      if (offset + 4 > end) break;
      const brand = String.fromCharCode(
        head[offset],
        head[offset + 1],
        head[offset + 2],
        head[offset + 3],
      );
      if (supportedBrands.has(brand)) return true;
    }
    return false;
  }

  private async ensureLib(): Promise<LibheifModule> {
    if (!this.libheifPromise) {
      this.libheifPromise = (async () => {
        // Use libheif-js' browser-oriented WASM bundle. The former default
        // import selected its much slower asm.js compatibility build despite
        // this decoder being documented as WASM.
        const mod = await import(/* @vite-ignore */ LIBHEIF_MODULE_URL);
        const candidate = (mod as { default?: unknown }).default ?? mod;
        const resolved = typeof candidate === 'function'
          ? await (candidate as () => Promise<unknown> | unknown)()
          : candidate;
        const library = resolved as Partial<LibheifModule>;
        if (typeof library.HeifDecoder !== 'function') {
          throw new Error('HEIF decoder module did not initialize');
        }
        return library as LibheifModule;
      })().catch((error) => {
        // A transient failed chunk/WASM load must be retryable.
        this.libheifPromise = null;
        throw error;
      });
    }
    return this.libheifPromise;
  }

  /**
   * Decode to scene-linear 16-bit pixels at the file's real bit depth.
   * Returns null when the WASM build lacks the C API this needs, so callers
   * can fall back to an 8-bit mode instead of failing the load.
   */
  async decode16(file: File, maxLongEdge: number): Promise<RawPixelData | null> {
    const lib = await this.ensureLib();
    if (!supportsHeif16(lib)) return null;
    return decodeHeif16(lib, new Uint8Array(await file.arrayBuffer()), maxLongEdge);
  }

  /**
   * Inspect the encoded primary image without decoding its pixels. The
   * current libheif memory interface still consumes the complete container;
   * callers should therefore use this for an already-loaded original, not as
   * a reason to bulk-download remote libraries.
   */
  async probeSourceBits(file: File): Promise<number | null> {
    try {
      const lib = await this.ensureLib();
      if (!supportsHeifSourceBits(lib)) return null;
      return probeHeifSourceBits(lib, new Uint8Array(await file.arrayBuffer()));
    } catch {
      return null;
    }
  }

  /**
   * Decode to 8 bit and hand the pixels over losslessly as PNG. Same depth as
   * {@link decode}, but without the JPEG re-compression in front of editing.
   */
  async decodeLossless(file: File): Promise<Blob> {
    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(file);
        try {
          if (bitmap.width > 0 && bitmap.height > 0) return await bitmapToBlob(bitmap, 'image/png');
        } finally {
          bitmap.close();
        }
      } catch {
        // Chrome/Firefox cannot decode HEIF natively; fall through to libheif.
      }
    }
    return imageDataToBlob(await this.decodeToImageData(file), 'image/png');
  }

  /** libheif's 8-bit output, before any re-encoding. */
  private async decodeToImageData(file: File): Promise<ImageData> {
    const lib = await this.ensureLib();
    const decoder = new lib.HeifDecoder();
    const images = decoder.decode(new Uint8Array(await file.arrayBuffer()));
    if (!images || images.length === 0) throw new Error('HEIF decode: no images');
    const candidates = images
      .map((image) => ({ image, width: image.get_width(), height: image.get_height() }))
      .filter(({ width, height }) => width > 0 && height > 0)
      .sort((left, right) => right.width * right.height - left.width * left.height);
    if (candidates.length === 0) throw new Error('HEIF decode: zero dimensions');

    let lastError: unknown;
    for (const { image, width, height } of candidates) {
      try {
        const imageData = new ImageData(width, height);
        return await new Promise<ImageData>((resolve, reject) => {
          image.display(imageData, (data) => {
            if (!data) reject(new Error('HEIF display failed'));
            else resolve(data);
          });
        });
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error('HEIF decode: no decodable primary image', { cause: lastError });
  }

  /**
   * Decode a HEIF file's primary image to an ImageData blob (JPEG by default).
   */
  async decode(file: File): Promise<Blob> {
    // Safari and some platform WebViews can decode HEIF natively. Prefer that
    // path when available because it also understands vendor-specific colour
    // profiles that may not be present in the portable libheif build.
    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(file);
        try {
          if (bitmap.width > 0 && bitmap.height > 0) return await bitmapToBlob(bitmap);
        } finally {
          bitmap.close();
        }
      } catch {
        // Chrome/Firefox normally land here; continue with libheif WASM.
      }
    }

    return imageDataToBlob(await this.decodeToImageData(file));
  }
}

function range(start: number, end: number, step: number): number[] {
  const values: number[] = [];
  for (let value = start; value < end; value += step) values.push(value);
  return values;
}

async function imageDataToBlob(imageData: ImageData, type = 'image/jpeg'): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(imageData.width, imageData.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('HEIF decode: 2D canvas unavailable');
    context.putImageData(imageData, 0, 0);
    return canvas.convertToBlob({ type, quality: 0.94 });
  }

  if (typeof document === 'undefined') {
    throw new Error('HEIF decode: canvas unavailable');
  }
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('HEIF decode: 2D canvas unavailable');
  context.putImageData(imageData, 0, 0);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('HEIF decode: JPEG conversion failed')),
      type,
      0.94,
    );
  });
}

async function bitmapToBlob(bitmap: ImageBitmap, type = 'image/jpeg'): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('HEIF decode: 2D canvas unavailable');
    context.drawImage(bitmap, 0, 0);
    return canvas.convertToBlob({ type, quality: 0.94 });
  }
  if (typeof document === 'undefined') throw new Error('HEIF decode: canvas unavailable');
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('HEIF decode: 2D canvas unavailable');
  context.drawImage(bitmap, 0, 0);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('HEIF decode: JPEG conversion failed')),
      type,
      0.94,
    );
  });
}

export const heifDecoder = new HeifDecoder();
