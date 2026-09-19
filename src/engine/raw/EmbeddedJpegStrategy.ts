import { rawDecoder } from '../RawDecoder';
import type { RawDecoderStrategy, RawDecodeResult, RawDecodeOptions } from './RawDecoderStrategy';

export class EmbeddedJpegStrategy implements RawDecoderStrategy {
  readonly id = 'embedded-jpeg' as const;
  readonly displayName = 'Embedded JPEG Preview';
  readonly description = 'Schnell und format-agnostisch. Nutzt die in jedem RAW eingebettete Preview-JPEG (das ist was auch Lightroom initial zeigt). 8-bit; eingeschränkte Editier-Reserve.';

  async decode(file: File, opts?: RawDecodeOptions): Promise<RawDecodeResult | null> {
    if (opts?.signal?.aborted) return null;
    const t0 = performance.now();
    const blob = await rawDecoder.extractLargestEmbeddedJpeg(file);
    if (!blob) {
      console.warn(`[EmbeddedJpeg] no embedded JPEG found in ${file.name} (size=${file.size}KB)`);
      return null;
    }
    if (opts?.signal?.aborted) return null;

    const url = URL.createObjectURL(blob);
    let width = 0, height = 0;
    try {
      const bitmap = await createImageBitmap(blob);
      width = bitmap.width;
      height = bitmap.height;
      bitmap.close();
    } catch (e) {
      console.warn(`[EmbeddedJpeg] extracted JPEG (size=${Math.round(blob.size/1024)}KB) is not decodable:`, e);
    }

    console.log(`[EmbeddedJpeg] ${file.name}: ${Math.round(blob.size/1024)}KB ${width}x${height} (${Math.round(performance.now()-t0)}ms)`);
    // As the fallback of libraw-wasm this is often the last word on a load.
    // Without it the editor's overlay keeps showing the libraw stage it died
    // on, forever (F039). Same hard-coded label as the other strategies; the
    // translation of these labels is F090/AP22.
    opts?.onStage?.({ kind: 'done', label: 'Fertig' });
    return { displayUrl: url, width, height, bits: 8, source: this.id };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}
