import { useEffect, useMemo, useRef, useState } from 'react';
import type { PhotoView } from '../../storage/repos';
import { getDefaultPipelineService } from '../../engine/graph';
import { generateThumbnailBlob } from '../../engine/thumbnail/generateThumbnailBlob';
import { pauseThumbnailRendering } from '../../engine/ThumbnailRenderer';
import { RawDecoder } from '../../engine/RawDecoder';
import { resizeRaw16LongEdge } from '../../engine/raw/resizeRaw16';
import { baseAdjustmentsFor } from '../../engine/developProfileStore';
import { lensCoefficientsFor } from '../../engine/lensProfileStore';
import type { BenchCalibration, BenchSourceKind } from './benchSourceSpec';
import { loadBenchRaw } from './benchRawLoader';

/** Long edge every bench tile is decoded and rendered at. */
export const BENCH_TILE_EDGE = 500;

export type BenchSourceStatus = 'pending' | 'loading' | 'ready' | 'error';

export interface BenchSource {
  photoId: number;
  name: string;
  status: BenchSourceStatus;
  /** Worker binding id, set once the decoded pixels have been handed over. */
  boundId: string | null;
  kind: BenchSourceKind;
  width: number;
  height: number;
  channels?: 3 | 4;
  calibration?: BenchCalibration;
  /** The camera profile in force for this photo, or null. */
  baseAdjustments?: import('../../engine/graph').BuilderAdjustments | null;
  /** The lens correction in force for this photo, or null. */
  lensProfile?: import('../../engine/lensProfile').LensCoefficients | null;
  /**
   * A tile that must stay untouched by the sliders.
   *
   * The camera's own JPEG is the thing a RAW profile is being tuned towards.
   * Moving it with the same sliders would be like adjusting the ruler along
   * with the thing being measured - the comparison would always look right.
   */
  reference?: boolean;
  /** Short label while loading - a RAW goes through several stages. */
  stage?: string;
  /**
   * True when this is a RAW that could not be developed and is showing its
   * camera JPEG instead. Surfaced on the tile on purpose: a base profile
   * judged against camera JPEGs is worthless, and the difference is not
   * something the eye can be relied on to catch.
   */
  rawFallback?: boolean;
  error?: string;
}

let _counter = 0;
function nextBoundId(): string {
  return `bench-${++_counter}`;
}

function emptySource(photo: PhotoView): BenchSource {
  return {
    photoId: photo.id, name: photo.name, status: 'pending',
    boundId: null, kind: 'imageBitmap', width: 0, height: 0,
  };
}

/**
 * Fetch the photo's bytes the same way the library thumbnail path does:
 * the original file when the provider hands one over, its display rendition
 * otherwise.
 *
 * The name the ladder judges the blob by matters. A display URL is always
 * something the browser can render, so it is labelled `display.jpg` - passing
 * the original name would send a JPEG rendition of a HEIC photo to libheif.
 */
async function loadDisplayBlob(
  photo: PhotoView,
  signal: AbortSignal,
): Promise<{ blob: Blob; decodeAs: string } | null> {
  const { sourceManager } = await import('../../sources');
  const source = sourceManager.get(photo.sourceId);
  if (!source) return null;
  const ref = { sourcePhotoId: photo.sourcePhotoId, sourceId: photo.sourceId, name: photo.name };

  try {
    const file = await source.getFile(ref, signal);
    if (file) return { blob: file, decodeAs: photo.name };
  } catch { /* fall through to the display rendition */ }
  if (signal.aborted) return null;

  try {
    const url = await source.getDisplayUrl(ref);
    if (url) {
      const res = await fetch(url, { signal });
      const blob = await res.blob();
      if (url.startsWith('blob:')) URL.revokeObjectURL(url);
      return { blob, decodeAs: 'display.jpg' };
    }
  } catch { /* nothing left to try */ }

  return null;
}

interface DecodedSource {
  data: Parameters<ReturnType<typeof getDefaultPipelineService>['bindSource']>[1];
  shape: Pick<BenchSource, 'kind' | 'width' | 'height' | 'channels' | 'calibration' | 'rawFallback' | 'baseAdjustments' | 'lensProfile'>;
}

/**
 * Decode a RAW the way the editor does, then shrink it to tile size.
 *
 * This deliberately avoids `generateThumbnailBlob`, which for a RAW returns
 * the camera's own embedded JPEG. That JPEG is the very thing a base profile
 * is meant to be judged against, so developing it instead of the sensor data
 * would make both the profile and the RAW-vs-JPG comparison meaningless.
 *
 * The shrink happens on the 16-bit linear frame, before anything is bound: a
 * smart preview is ~5.8 MB and nine of them would sit in the worker for the
 * life of the bench, while nine 500px frames are under 6 MB together.
 */
async function decodeRaw(
  photo: PhotoView,
  signal: AbortSignal,
  onStage: (label: string) => void,
): Promise<DecodedSource | null> {
  const { sourceManager } = await import('../../sources');
  const provider = sourceManager.get(photo.sourceId);
  if (!provider) return null;

  const result = await loadBenchRaw(photo, provider, signal, (stage) => onStage(stage.label));
  if (!result || signal.aborted) return null;

  const px = result.rawPixels;
  if (px && px.bits === 16 && px.data instanceof Uint16Array) {
    if (result.displayUrl.startsWith('blob:')) URL.revokeObjectURL(result.displayUrl);
    onStage('verkleinern');
    const small = resizeRaw16LongEdge(
      { data: px.data, width: px.width, height: px.height, channels: px.channels },
      BENCH_TILE_EDGE,
    );
    return {
      data: {
        pixels: small.data, width: small.width, height: small.height, channels: small.channels,
      },
      shape: {
        kind: 'raw16', width: small.width, height: small.height, channels: small.channels,
        calibration: {
          asShotNeutral: px.asShotNeutral ?? null,
          colorMatrix: px.colorMatrix ?? null,
        },
        // The preset bench shows what the library shows, which means the
        // camera profile is already on. A preset is judged on top of it.
        baseAdjustments: baseAdjustmentsFor(photo),
        lensProfile: lensCoefficientsFor(photo),
      },
    };
  }

  // No 16-bit path on this browser, this backend or this file. The strategy
  // already fell back to something displayable; render that rather than
  // showing a gap - but say so, because what is on screen is then the
  // camera's rendering and not the sensor's.
  let bitmap: ImageBitmap;
  try {
    const response = await fetch(result.displayUrl);
    bitmap = await createImageBitmap(await response.blob());
  } finally {
    if (result.displayUrl.startsWith('blob:')) URL.revokeObjectURL(result.displayUrl);
  }
  return {
    data: bitmap,
    shape: {
      kind: 'imageBitmap', width: bitmap.width, height: bitmap.height, rawFallback: true,
    },
  };
}

async function decodeDisplay(photo: PhotoView, signal: AbortSignal): Promise<DecodedSource | null> {
  const loaded = await loadDisplayBlob(photo, signal);
  if (!loaded) return null;
  const file = loaded.blob instanceof File ? loaded.blob : new File([loaded.blob], loaded.decodeAs);
  const bitmap = await createImageBitmap(await generateThumbnailBlob(file, BENCH_TILE_EDGE, 0.92));
  return {
    data: bitmap,
    shape: { kind: 'imageBitmap', width: bitmap.width, height: bitmap.height },
  };
}

/**
 * Decode N photos once, shrink them to `BENCH_TILE_EDGE` and hand each one to
 * the render worker, where it stays bound until the bench closes.
 *
 * The binding is the point of the whole hook. `bindSource` transfers the
 * pixels into the worker and keeps them there, so every later slider move
 * costs nine GL renders and not a single decode - which is what makes a live
 * nine-up view affordable at all.
 *
 * Loading is strictly sequential. It is a one-off cost the user has agreed to
 * pay, and running it in parallel would only pile decodes onto the same
 * worker the bench is about to render through.
 */
export interface BenchSourceOptions {
  /**
   * Render tiles through the camera profile the catalog already holds.
   *
   * True for the preset bench, which is judged on top of a developed photo.
   * False for the profile bench, where the sliders ARE the profile: applying
   * the stored one as well would show every value twice.
   */
  applyStoredBase?: boolean;
  /** Photo ids whose tiles are references and never take the sliders. */
  referenceIds?: ReadonlySet<number>;
}

export function useBenchSources(
  photos: PhotoView[],
  options: BenchSourceOptions = {},
): BenchSource[] {
  /**
   * Decoded and bound sources, by photo id, kept for the life of the bench.
   *
   * Switching between RAW and the camera's JPEG changes which photos are on
   * the bench, and without this every switch tore down all nine bindings and
   * decoded them again - seconds of work to show pictures that were still
   * sitting in the worker. The tiles the user flips between are the same nine
   * photos; they are decoded once.
   */
  const cache = useRef(new Map<number, CacheEntry>());
  /** In-flight and failed photos. Ready ones live in the cache instead. */
  const [progress, setProgress] = useState<Map<number, Partial<BenchSource>>>(new Map());
  /** Bumped when the cache gains an entry, to rebuild the returned list. */
  const [cacheVersion, setCacheVersion] = useState(0);

  const photoIdsKey = photos.map((p) => p.id).join(',');
  const photosRef = useRef(photos);
  photosRef.current = photos;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Teardown belongs to the bench's lifetime, not to one photo list: the
  // whole point is that a list change keeps the bindings.
  useEffect(() => {
    const held = cache.current;
    const resumeThumbnails = pauseThumbnailRendering();
    return () => {
      const svc = getDefaultPipelineService();
      for (const entry of held.values()) void svc.unbindSource(entry.boundId);
      held.clear();
      resumeThumbnails();
    };
  }, []);

  useEffect(() => {
    const list = photosRef.current;
    const svc = getDefaultPipelineService();
    const controller = new AbortController();
    let cancelled = false;

    const patch = (photoId: number, next: Partial<BenchSource> | null) => {
      setProgress((prev) => {
        const map = new Map(prev);
        if (next === null) map.delete(photoId);
        else map.set(photoId, { ...map.get(photoId), ...next });
        return map;
      });
    };

    (async () => {
      for (const photo of list) {
        if (cancelled) return;
        if (cache.current.has(photo.id)) continue;
        patch(photo.id, { status: 'loading', stage: undefined });
        try {
          const decoded = RawDecoder.isRawFile(photo.name)
            ? await decodeRaw(photo, controller.signal, (stage) => {
              if (!cancelled) patch(photo.id, { stage });
            })
            : await decodeDisplay(photo, controller.signal);
          if (cancelled) return;
          if (!decoded) {
            patch(photo.id, { status: 'error', error: 'nicht erreichbar', stage: undefined });
            continue;
          }

          const { applyStoredBase = true } = optionsRef.current;
          const boundId = nextBoundId();
          // bindSource transfers the pixels; the main-thread handle is dead
          // afterwards, so the shape is read off before handing them over.
          await svc.bindSource(boundId, decoded.data);
          if (cancelled) { void svc.unbindSource(boundId); return; }

          evictBeyond(cache.current, MAX_CACHED_SOURCES, svc);
          cache.current.set(photo.id, {
            boundId,
            shape: {
              ...decoded.shape,
              baseAdjustments: applyStoredBase ? decoded.shape.baseAdjustments ?? null : null,
            },
            name: photo.name,
          });
          patch(photo.id, null);
          setCacheVersion((v) => v + 1);
        } catch (e) {
          if (cancelled) return;
          console.warn('[Bench] source failed', photo.name, e);
          patch(photo.id, {
            status: 'error', stage: undefined,
            error: e instanceof Error ? e.message : 'Fehler',
          });
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      // Nothing is unbound here: what this run managed to decode stays in the
      // cache for the list that comes next.
    };
    // photoIdsKey stands in for the photo list: a new set of ids means new
    // photos may need decoding, while a re-query returning the same ones must
    // not start over.
  }, [photoIdsKey]);

  // `reference` is decided here rather than stored with the decode: the same
  // photo is a reference in one comparison mode and a subject in another, and
  // a flag frozen at decode time would be wrong after the first switch.
  return useMemo(() => photos.map((photo) => {
    const held = cache.current.get(photo.id);
    if (held) {
      return {
        photoId: photo.id, name: photo.name, status: 'ready' as const,
        boundId: held.boundId,
        ...held.shape,
        reference: options.referenceIds?.has(photo.id) ?? false,
      } as BenchSource;
    }
    return { ...emptySource(photo), ...progress.get(photo.id) } as BenchSource;
    // cacheVersion is the signal that the cache changed under us.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [photos, progress, cacheVersion, options.referenceIds]);
}

interface CacheEntry {
  boundId: string;
  shape: DecodedSource['shape'];
  name: string;
}

/** Keep the map bounded; a long session can walk through many selections. */
const MAX_CACHED_SOURCES = 24;

function evictBeyond(
  cache: Map<number, CacheEntry>,
  max: number,
  svc: ReturnType<typeof getDefaultPipelineService>,
): void {
  while (cache.size >= max) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) return;
    const entry = cache.get(oldest);
    if (entry) void svc.unbindSource(entry.boundId);
    cache.delete(oldest);
  }
}
