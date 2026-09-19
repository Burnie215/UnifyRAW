import { rawDecoder } from '../RawDecoder';
import type { RawDecodeMode, RawDecodeResult, RawPixelData } from './RawDecoderStrategy';

interface Entry {
  pixels: RawPixelData;
  previewBlob: Blob | null;
  bytes: number;
}

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 12;

export class EditorRawMemoryCache {
  private entries = new Map<string, Entry>();
  private bytes = 0;
  private readonly maxBytes: number;
  private readonly maxEntries: number;

  constructor(
    maxBytes = DEFAULT_MAX_BYTES,
    maxEntries = DEFAULT_MAX_ENTRIES,
  ) {
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
  }

  private slot(cacheKey: string, size: number): string {
    return `${cacheKey}|${size}`;
  }

  get byteSize(): number { return this.bytes; }
  get size(): number { return this.entries.size; }

  get(cacheKey: string, size: number): Entry | null {
    const slot = this.slot(cacheKey, size);
    const entry = this.entries.get(slot);
    if (!entry) return null;
    this.entries.delete(slot);
    this.entries.set(slot, entry);
    return entry;
  }

  put(cacheKey: string, size: number, pixels: RawPixelData, previewBlob: Blob | null = null): void {
    const slot = this.slot(cacheKey, size);
    const previous = this.entries.get(slot);
    if (previous) this.bytes -= previous.bytes;
    const bytes = pixels.data.byteLength + (previewBlob?.size ?? 0);
    this.entries.delete(slot);
    this.entries.set(slot, { pixels, previewBlob, bytes });
    this.bytes += bytes;
    this.evict();
  }

  async putResult(cacheKey: string, size: number, result: RawDecodeResult): Promise<void> {
    if (!result.rawPixels) return;
    const pixels = result.rawPixels;
    this.put(cacheKey, size, pixels);
    if (!result.displayUrl.startsWith('blob:')) return;
    try {
      const previewBlob = await fetch(result.displayUrl).then((response) => response.blob());
      const current = this.get(cacheKey, size);
      if (current?.pixels === pixels) this.put(cacheKey, size, pixels, previewBlob);
    } catch {
      // Pixels are the important part; a preview can be rebuilt on demand.
    }
  }

  async toResult(
    cacheKey: string,
    size: number,
    source: RawDecodeMode,
    wantPreview = true,
  ): Promise<RawDecodeResult | null> {
    const entry = this.get(cacheKey, size);
    if (!entry) return null;
    if (!wantPreview) {
      return {
        displayUrl: '',
        width: entry.pixels.width,
        height: entry.pixels.height,
        bits: entry.pixels.bits,
        source,
        rawPixels: entry.pixels,
      };
    }
    let blob = entry.previewBlob;
    if (!blob) {
      const pixels = entry.pixels;
      const raw = {
        width: pixels.width,
        height: pixels.height,
        colors: pixels.channels,
        bits: pixels.bits,
        data: pixels.bits === 16 && pixels.data instanceof Uint16Array
          ? new Uint8Array(pixels.data.buffer, pixels.data.byteOffset, pixels.data.byteLength)
          : pixels.data as Uint8Array,
        data16: pixels.data instanceof Uint16Array ? pixels.data : undefined,
        metadata: { width: pixels.width, height: pixels.height },
      };
      const bitmap = await rawDecoder.toImageBitmap(raw);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
      bitmap.close();
      blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
      this.put(cacheKey, size, pixels, blob);
    }
    return {
      displayUrl: URL.createObjectURL(blob),
      width: entry.pixels.width,
      height: entry.pixels.height,
      bits: entry.pixels.bits,
      source,
      rawPixels: entry.pixels,
    };
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.entries().next().value as [string, Entry] | undefined;
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      this.bytes -= oldest[1].bytes;
    }
  }
}

export const editorRawMemoryCache = new EditorRawMemoryCache();

const flights = new Map<string, Promise<RawDecodeResult | null>>();

/** Deduplicate concurrent OPFS/server cache probes for one preview slot. */
export function rawCacheSingleFlight(
  cacheKey: string,
  size: number,
  load: () => Promise<RawDecodeResult | null>,
): Promise<RawDecodeResult | null> {
  const slot = `${cacheKey}|${size}`;
  const existing = flights.get(slot);
  if (existing) return existing;
  const promise = load().finally(() => flights.delete(slot));
  flights.set(slot, promise);
  return promise;
}
