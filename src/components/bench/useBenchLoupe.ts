import { useEffect, useRef, useState } from 'react';
import type { PhotoView } from '../../storage/repos';
import { getDefaultPipelineService } from '../../engine/graph';
import { generateThumbnailBlob } from '../../engine/thumbnail/generateThumbnailBlob';
import { RawDecoder } from '../../engine/RawDecoder';
import { cropRaw16 } from '../../engine/raw/resizeRaw16';
import type { BenchSource } from './useBenchSources';
import { loadBenchRaw } from './benchRawLoader';

/** Edge length of the cut-out, in source pixels. */
export const LOUPE_EDGE = 420;

/** Photo id the loupe renders under. Negative so it cannot collide with a row id. */
export const LOUPE_PHOTO_ID = -1;

export interface LoupeRequest {
  photo: PhotoView;
  /** Where in the tile the user clicked, normalised 0..1. */
  x: number;
  y: number;
}

function cutOrigin(x: number, width: number, edge: number): number {
  return Math.max(0, Math.min(width - edge, Math.round(x * width - edge / 2)));
}

/**
 * A 1:1 cut-out of one photo, bound as an extra render source.
 *
 * The grid runs at 500px, which is the right size for judging exposure and
 * colour and the wrong size for judging sharpening and noise reduction - at
 * that scale both are invisible. So the focused tile can hand over a cut-out
 * at source scale, which then rides through the very same plan as the tiles
 * and lands in its own canvas.
 *
 * "Source scale" means something different per file type, and deliberately so.
 * For a JPEG or HEIC it is the full original. For a RAW it is the smart
 * preview - the same pixels the editor itself works on, and therefore the
 * honest basis for deciding how much sharpening a profile should carry. A
 * full-resolution demosaic here would show detail no other view in the app
 * ever renders.
 *
 * Loaded on request, not with the grid: it costs a decode, and most of the
 * time nobody asks for it.
 */
export function useBenchLoupe(request: LoupeRequest | null): BenchSource | null {
  const [source, setSource] = useState<BenchSource | null>(null);
  // The caller rebuilds the request object on every render, so the effect keys
  // off what actually identifies a cut-out and reads the object through a ref.
  const key = request ? `${request.photo.id}:${request.x.toFixed(3)}:${request.y.toFixed(3)}` : '';
  const requestRef = useRef(request);
  requestRef.current = request;

  useEffect(() => {
    const req = requestRef.current;
    if (!req) { setSource(null); return; }

    const svc = getDefaultPipelineService();
    const controller = new AbortController();
    let cancelled = false;
    let boundId: string | null = null;

    const base = { photoId: LOUPE_PHOTO_ID, name: req.photo.name, boundId: null, width: 0, height: 0 };
    setSource({ ...base, status: 'loading', kind: 'imageBitmap' });

    (async () => {
      try {
        const { sourceManager } = await import('../../sources');
        const provider = sourceManager.get(req.photo.sourceId);
        if (!provider) throw new Error('Quelle nicht verfügbar');

        let next: BenchSource;
        boundId = `bench-loupe-${Date.now()}`;

        if (RawDecoder.isRawFile(req.photo.name)) {
          const result = await loadBenchRaw(req.photo, provider, controller.signal);
          if (cancelled) return;
          if (result?.displayUrl.startsWith('blob:')) URL.revokeObjectURL(result.displayUrl);
          const px = result?.rawPixels;
          if (!px || px.bits !== 16 || !(px.data instanceof Uint16Array)) {
            throw new Error('Keine 16-Bit-Pixel für die Lupe');
          }
          const edge = Math.min(LOUPE_EDGE, px.width, px.height);
          const crop = cropRaw16(
            { data: px.data, width: px.width, height: px.height, channels: px.channels },
            cutOrigin(req.x, px.width, edge),
            cutOrigin(req.y, px.height, edge),
            edge,
          );
          await svc.bindSource(boundId, {
            pixels: crop.data, width: crop.width, height: crop.height, channels: crop.channels,
          });
          next = {
            ...base, status: 'ready', boundId, kind: 'raw16',
            width: crop.width, height: crop.height, channels: crop.channels,
            calibration: {
              asShotNeutral: px.asShotNeutral ?? null,
              colorMatrix: px.colorMatrix ?? null,
            },
          };
        } else {
          const file = await provider.getFile({
            sourcePhotoId: req.photo.sourcePhotoId,
            sourceId: req.photo.sourceId,
            name: req.photo.name,
          }, controller.signal);
          if (!file) throw new Error('Originaldatei nicht erreichbar');
          if (cancelled) return;
          // Through the ladder at full size: no downscale, but HEIC still has
          // to go via libheif, and createImageBitmap cannot read it.
          const full = await generateThumbnailBlob(file, Number.MAX_SAFE_INTEGER, 0.95);
          if (cancelled) return;
          const probe = await createImageBitmap(full);
          const { width: fullW, height: fullH } = probe;
          probe.close();
          if (cancelled) return;

          const edge = Math.min(LOUPE_EDGE, fullW, fullH);
          const crop = await createImageBitmap(
            full, cutOrigin(req.x, fullW, edge), cutOrigin(req.y, fullH, edge), edge, edge,
          );
          if (cancelled) { crop.close(); return; }
          await svc.bindSource(boundId, crop);
          next = { ...base, status: 'ready', boundId, kind: 'imageBitmap', width: edge, height: edge };
        }

        if (cancelled) { void svc.unbindSource(boundId); return; }
        setSource(next);
      } catch (e) {
        if (cancelled) return;
        console.warn('[Bench] loupe failed', e);
        setSource({
          ...base, status: 'error', kind: 'imageBitmap',
          error: e instanceof Error ? e.message : 'Fehler',
        });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      if (boundId) void svc.unbindSource(boundId);
    };
  }, [key]);

  return source;
}
