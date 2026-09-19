import { rawDecoder, type RawImage } from '../RawDecoder';
import type {
  RawDecoderStrategy,
  RawDecodeResult,
  RawDecodeOptions,
  RawPixelData,
} from './RawDecoderStrategy';
import { EmbeddedJpegStrategy } from './EmbeddedJpegStrategy';
import { resizeRaw16LongEdge } from './resizeRaw16';
import { getDefaultRawPixelsCache } from './RawPixelsOpfsCache';

export class LibrawWasmStrategy implements RawDecoderStrategy {
  readonly id = 'libraw-wasm' as const;
  readonly displayName = 'libraw-wasm (Browser)';
  readonly description = 'Echter RAW-Decode im Browser via libraw-wasm. Funktioniert für die meisten Bayer-Sensoren (Canon CR2/CR3, Nikon NEF, Sony ARW). Bekanntes Problem: Fuji X-Trans wird bei einigen Modellen als Bayer fehlinterpretiert (Streifenmuster). Verbraucht Browser-Memory bei großen Dateien. Bei Fehler wird auf die eingebettete JPEG-Preview zurückgefallen.';

  private fallback = new EmbeddedJpegStrategy();

  async decode(file: File, opts?: RawDecodeOptions): Promise<RawDecodeResult | null> {
    if (opts?.signal?.aborted) return null;
    try {
      // Decode to scene-linear 16-bit RGB in the browser. Camera WB is baked
      // by LibRaw; user temperature/tint stays editable and is applied later
      // as multiplicative gains in WhiteBalanceRawPass.
      const raw = await rawDecoder.decode(file, {
        outputBps: 16,
        useAutoWb: false,
        useCameraWb: true,
        // LibRaw can reduce the demosaic cost before our exact preview-size
        // resize. Full sensor resolution belongs to export, not live sliders.
        halfSize: true,
        linear: true,
      });
      if (opts?.signal?.aborted) return null;

      if (!raw.data16 || (raw.colors !== 3 && raw.colors !== 4)) {
        throw new Error(`Unexpected LibRaw output (${raw.bits}-bit, ${raw.colors} channels)`);
      }
      const preview = resizeRaw16LongEdge({
        data: raw.data16,
        width: raw.width,
        height: raw.height,
        channels: raw.colors,
      }, opts?.size ?? 1200);
      const previewRaw = {
        ...raw,
        width: preview.width,
        height: preview.height,
        colors: preview.channels,
        data: new Uint8Array(preview.data.buffer),
        data16: preview.data,
      };

      const displayUrl = await this.previewUrl(previewRaw, opts);
      if (opts?.signal?.aborted) return null;

      const rawPixels: RawPixelData = {
        data: preview.data,
        width: preview.width,
        height: preview.height,
        channels: preview.channels,
        bits: 16,
        // libraw-wasm already emitted linear sRGB with camera WB.
        colorMatrix: null,
        asShotNeutral: null,
      };
      if (opts?.cacheKey) {
        getDefaultRawPixelsCache()
          .put(opts.cacheKey, String(opts.size ?? 1200), rawPixels)
          .catch((error: unknown) => console.warn('[LibrawWasm] pixel cache write failed:', error));
      }

      return {
        displayUrl,
        width: preview.width,
        height: preview.height,
        bits: 16,
        source: this.id,
        rawPixels,
      };
    } catch (e) {
      if (opts?.signal?.aborted) return null;
      console.warn(`[LibrawWasm] ${file.name}: decode failed, falling back to embedded JPEG:`, e);
      return this.fallback.decode(file, opts);
    }
  }

  async decodeFromCache(
    cacheKey: string,
    size: number,
    opts?: RawDecodeOptions,
  ): Promise<RawDecodeResult | null> {
    if (opts?.signal?.aborted) return null;
    opts?.onStage?.({ kind: 'cache-check', label: 'Lokalen Cache prüfen', next: 'Vorschau bauen' });
    const cached = await getDefaultRawPixelsCache().get(cacheKey, String(size));
    if (!cached || !(cached.data instanceof Uint16Array)) return null;
    if (opts?.signal?.aborted) return null;

    const displayUrl = await this.previewUrl({
      width: cached.width,
      height: cached.height,
      colors: cached.channels,
      bits: 16,
      data: new Uint8Array(cached.data.buffer, cached.data.byteOffset, cached.data.byteLength),
      data16: cached.data,
      metadata: { width: cached.width, height: cached.height },
    }, opts);
    if (opts?.signal?.aborted) return null;
    opts?.onStage?.({ kind: 'done', label: 'Fertig' });
    return {
      displayUrl,
      width: cached.width,
      height: cached.height,
      bits: 16,
      source: this.id,
      rawPixels: cached,
    };
  }

  /** A caller that only wants the pixels pays for no bitmap and no JPEG. */
  private async previewUrl(raw: RawImage, opts?: RawDecodeOptions): Promise<string> {
    if (opts?.wantPreview === false) return '';
    opts?.onStage?.({ kind: 'preview', label: 'Vorschau bauen', next: 'An Pipeline übergeben' });
    const bitmap = await rawDecoder.toImageBitmap(raw);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    return URL.createObjectURL(blob);
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}
