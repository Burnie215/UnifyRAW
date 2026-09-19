/**
 * RAW image decoder using libraw-wasm.
 * Decodes RAW files (CR2, CR3, NEF, ARW, DNG, ORF, RAF, RW2, etc.)
 * entirely in the browser via WebAssembly.
 */

const RAW_EXTENSIONS = new Set([
  'cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2',
  'dng', 'orf', 'raf', 'rw2', 'rwl', 'pef', 'ptx',
  'srw', 'x3f', 'erf', 'mef', 'mos', 'mrw', 'kdc',
  'dcr', 'raw', '3fr', 'fff', 'iiq', 'rwz',
]);

export interface RawImage {
  width: number;
  height: number;
  data: Uint8Array;         // pixel-channel-interleaved
  data16?: Uint16Array;     // RGB, 16-bit per channel (if requested)
  colors: number;           // number of channels per pixel (1=mono, 3=RGB, 4=RGBA)
  bits: number;             // bits per channel (8 or 16)
  metadata: RawMetadata;
}

export interface RawMetadata {
  make?: string;
  model?: string;
  timestamp?: Date;
  width: number;
  height: number;
  thumbFormat?: string;
}

interface LibRawInstance {
  open(buffer: Uint8Array, settings: Record<string, unknown>): Promise<void>;
  metadata(full?: boolean): Promise<Record<string, unknown>>;
  imageData(): Promise<{ data: Uint8Array | Uint16Array; width: number; height: number; colors: number; bits: number; dataSize: number }>;
  /** Terminates the worker and rejects whatever is still in flight. */
  dispose?: () => void;
  worker?: Worker;
}

/**
 * A decode that stops answering must not stop the application.
 *
 * This is the lesson from libraw-wasm 1.1.2, which never settled a call the
 * worker had answered with an error: the file kept one of the two RAW slots and
 * one of the six thumbnail queue slots for the life of the tab, six such files
 * emptied the whole grid, and the background pass - which waits for an idle
 * queue before every item - stopped writing blur hashes. 1.6.0 settles its
 * promises properly, so nothing should reach this deadline; it is here so that
 * a worker which dies without a word cannot do the same thing again.
 *
 * Long enough that no real decode reaches it: the slowest file measured here,
 * a 26 MP X-Trans frame at half size, takes under two seconds.
 */
const DECODE_DEADLINE_MS = 180_000;

/** Reject `work` if it has not settled within `ms`, naming the file that stalled. */
function withDeadline<T>(work: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`RAW decode gave no answer within ${ms} ms: ${name}`)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

export class RawDecoder {
  static isRawFile(name: string): boolean {
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    return RAW_EXTENSIONS.has(ext);
  }

  /**
   * Decode a RAW file to interleaved RGB pixel data (8-bit by default,
   * optionally scene-linear 16-bit).
   *
   * Each call gets a fresh LibRaw instance (= its own Worker) and disposes of
   * it afterwards so the Worker thread doesn't leak. One instance serialises
   * its own calls, so sharing one would decode strictly one file at a time;
   * `withRawSlot` in the thumbnail generator is what decides how many run at
   * once. `dispose` also rejects anything still in flight, which is what lets
   * an abandoned decode give its slot back.
   */
  async decode(file: File, options?: {
    useAutoWb?: boolean;
    useCameraWb?: boolean;
    halfSize?: boolean;
    outputBps?: 8 | 16;
    /** Emit scene-linear samples (equivalent to dcraw `-g 1 1 -W`). */
    linear?: boolean;
  }): Promise<RawImage> {
    const LibRaw = (await import('libraw-wasm')).default;
    const raw = new LibRaw() as LibRawInstance;
    try {
      return await withDeadline(this.decodeInner(file, raw, options), DECODE_DEADLINE_MS, file.name);
    } finally {
      try {
        if (raw.dispose) raw.dispose();
        else raw.worker?.terminate();
      } catch { /* */ }
    }
  }

  private async decodeInner(
    file: File,
    raw: LibRawInstance,
    options?: {
      useAutoWb?: boolean;
      useCameraWb?: boolean;
      halfSize?: boolean;
      outputBps?: 8 | 16;
      linear?: boolean;
    },
  ): Promise<RawImage> {

    const buffer = new Uint8Array(await file.arrayBuffer());

    // Fuji X-Trans needs Markesteijn-3 (qual=11) — AHD (qual=3) silently
    // falls back to bilinear or worse for non-Bayer sensors → striped output.
    const isXTrans = file.name.toLowerCase().endsWith('.raf');
    const userQual = isXTrans ? 11 : 3;

    await raw.open(buffer, {
      outputColor: 1,       // sRGB
      outputBps: options?.outputBps ?? 8,
      useAutoWb: options?.useAutoWb ?? true,
      useCameraWb: options?.useCameraWb ?? false,
      halfSize: options?.halfSize ?? false,
      userQual,
      noAutoBright: options?.linear ?? false,
      gamm: options?.linear ? [1, 1] : null,
    });

    const meta = await raw.metadata(false);
    const result = await raw.imageData();
    if (!result || !result.data || typeof (result.data as { length?: number }).length !== 'number') {
      throw new Error(`libraw-wasm returned no pixel data (keys=${result ? Object.keys(result).join(',') : 'null'})`);
    }
    const pixels = result.data;
    const w = (result.width ?? meta.width) as number;
    const h = (result.height ?? meta.height) as number;
    const colors = result.colors ?? 3;
    const bits = result.bits ?? 8;
    const expectedBytes = w * h * colors * (bits / 8);
    if (pixels.byteLength !== expectedBytes) {
      console.warn(`[RawDecoder] size mismatch: got ${pixels.byteLength} expected ${expectedBytes} bytes (w=${w} h=${h} colors=${colors} bits=${bits}) — qual=${userQual}`);
    }

    const data16 = bits === 16
      ? pixels instanceof Uint16Array
        ? pixels
        : new Uint16Array(pixels.buffer, pixels.byteOffset, pixels.byteLength / 2)
      : undefined;
    // libraw-wasm returns Uint16Array for 16-bit output and Uint8Array for
    // 8-bit output. Keep RawImage.data's byte-view contract in both cases;
    // data16 exposes the sample view without copying the backing buffer.
    const data = pixels instanceof Uint8Array
      ? pixels
      : new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);

    return {
      width: w,
      height: h,
      data,
      data16,
      colors,
      bits,
      metadata: {
        make: (meta.desc as string)?.split(' ')[0],
        model: meta.desc as string,
        timestamp: meta.timestamp as Date | undefined,
        width: meta.width as number,
        height: meta.height as number,
        thumbFormat: meta.thumb_format as string | undefined,
      },
    };
  }

  /**
   * Decode at half resolution for fast preview.
   */
  async decodePreview(file: File): Promise<RawImage> {
    return this.decode(file, { halfSize: true, useAutoWb: true });
  }

  /**
   * Extract the LARGEST embedded JPEG from a RAW file by scanning for SOI/EOI
   * markers across the whole file. RAW files typically embed both a small
   * thumbnail and a full-res preview — the latter (what Lightroom etc.
   * display) is what we want for editor display.
   *
   * This avoids libraw's broken X-Trans demosaic path and works for every
   * RAW format (CR2/CR3/NEF/ARW/RAF/DNG/…) since they all embed a JPEG.
   */
  async extractLargestEmbeddedJpeg(file: File): Promise<Blob | null> {
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bestStart = -1;
      let bestSize = 0;
      let i = 0;
      const n = buf.length;
      while (i < n - 2) {
        if (buf[i] === 0xFF && buf[i + 1] === 0xD8 && buf[i + 2] === 0xFF) {
          const start = i;
          i += 3;
          let foundEnd = false;
          while (i < n - 1) {
            if (buf[i] === 0xFF && buf[i + 1] === 0xD9) {
              const size = (i + 2) - start;
              if (size > bestSize) { bestStart = start; bestSize = size; }
              i += 2;
              foundEnd = true;
              break;
            }
            i++;
          }
          if (!foundEnd) break;
        } else {
          i++;
        }
      }
      if (bestStart < 0 || bestSize < 1024) return null;
      return new Blob([buf.slice(bestStart, bestStart + bestSize)], { type: 'image/jpeg' });
    } catch {
      return null;
    }
  }

  /** Backwards-compatible alias — used by thumbnail generator elsewhere. */
  async extractThumbnail(file: File): Promise<Blob | null> {
    return this.extractLargestEmbeddedJpeg(file);
  }

  /**
   * Convert decoded RGB data to a displayable Blob URL.
   */
  async toImageBitmap(raw: RawImage): Promise<ImageBitmap> {
    const { width, height, data, colors, bits } = raw;
    const px = width * height;
    const rgba = new Uint8ClampedArray(px * 4);

    if (bits === 16) {
      // 16-bit interleaved, normalize to 8-bit (assume colors=3 or 4)
      const view = raw.data16 ?? new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2);
      for (let p = 0; p < px; p++) {
        const si = p * colors;
        const di = p * 4;
        rgba[di]     = view[si]     >> 8;
        rgba[di + 1] = view[si + 1] >> 8;
        rgba[di + 2] = view[si + 2] >> 8;
        rgba[di + 3] = colors === 4 ? (view[si + 3] >> 8) : 255;
      }
    } else if (colors === 1) {
      // Monochrome → replicate to RGB
      for (let p = 0; p < px; p++) {
        const v = data[p];
        const di = p * 4;
        rgba[di] = v; rgba[di + 1] = v; rgba[di + 2] = v; rgba[di + 3] = 255;
      }
    } else if (colors === 4) {
      for (let p = 0; p < px; p++) {
        const si = p * 4;
        const di = p * 4;
        rgba[di]     = data[si];
        rgba[di + 1] = data[si + 1];
        rgba[di + 2] = data[si + 2];
        rgba[di + 3] = data[si + 3];
      }
    } else {
      // 8-bit RGB (most common)
      for (let p = 0; p < px; p++) {
        const si = p * 3;
        const di = p * 4;
        rgba[di]     = data[si];
        rgba[di + 1] = data[si + 1];
        rgba[di + 2] = data[si + 2];
        rgba[di + 3] = 255;
      }
    }

    const imageData = new ImageData(rgba, width, height);
    return createImageBitmap(imageData);
  }
}

/** Singleton decoder instance */
export const rawDecoder = new RawDecoder();
