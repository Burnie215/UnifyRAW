/**
 * Background edit-thumbnail renderer.
 * Backed by the unified graph PipelineService (Phase 1).
 *
 * RAW handling (Phase 1.5): for RAW photos the renderer asks the one RAW
 * ladder (`loadRawPixels`) for whatever is already cached. On hit, it builds a raw16
 * (HDR) graph fed by the cached 16-bit linear pixels so the background
 * thumb matches what the editor renders. On miss, it falls back to the
 * SDR `displayUrl` path — the result is approximate but acceptable for
 * a thumbnail until the editor warms the cache on next open.
 *
 * What gets rendered is not decided here: `buildDocumentGraph` decides it
 * for the canvas, the exporter and this renderer alike. Two consequences of
 * asking it, both since step 4 of the single-source-of-truth plan:
 * a graph-led photo's thumbnail is its stored graph, and masks are
 * rasterized and bound instead of being dropped. The dropping used to be a
 * documented approximation; with a stored graph it stops being one, because
 * a mask input with nothing bound makes the executor throw and the
 * thumbnail never appears at all.
 */
import type { PhotoDocument } from './DocumentModel';
import type { Adjustments } from '../types';
import {
  getDefaultPipelineService,
  getMainThreadNodeRegistry,
  GraphCompiler,
  buildAdjustmentsGraph,
  buildDocumentGraph,
  type BuilderSourceSpec,
  type DocumentGraph,
  type Raw16SourceData,
} from './graph';
import { bindDocumentMasks, extraSourcesOf, unbindDocumentMasks } from './documentMasks';
import { RawDecoder } from './RawDecoder';
import { baseAdjustmentsFor } from './developProfileStore';
import { lensCoefficientsFor } from './lensProfileStore';
import type { OutputColorSpaceId } from './outputColorSpaces';
import { getSmartPreviewSize } from './raw/RawDecoderStrategy';
import type { RawPixelData } from './raw/RawDecoderStrategy';
import type { PhotoView } from '../storage/repos';
import { editThumbnailKey } from '../cache/editThumbnailKey';
import { thumbnailStampFor } from './thumbnailStamp';
import { generateThumbnailBlob, THUMB_LONG_EDGE } from './thumbnail/generateThumbnailBlob';

/** Upper bound on how long a queued thumbnail may wait for an idle moment. */
const FLUSH_DEADLINE_MS = 300;

let idleHandle = 0;

/**
 * While true, queued jobs are collected but nothing renders.
 *
 * The alignment bench binds up to nine sources to the same worker and
 * re-renders all of them on every slider move. Background thumbnails share
 * that worker, and a job that lands mid-drag competes for the one GL context
 * the bench needs. Jobs are not dropped — they run when the bench closes.
 */
let paused = false;

/** Suspend background rendering. Returns a function that resumes it. */
export function pauseThumbnailRendering(): () => void {
  paused = true;
  if (idleHandle) { cancelIdleCallback(idleHandle); idleHandle = 0; }
  let resumed = false;
  return () => {
    if (resumed) return;
    resumed = true;
    paused = false;
    if (pending.size > 0) {
      idleHandle = requestIdleCallback(flush, { timeout: FLUSH_DEADLINE_MS });
    }
  };
}

export interface ThumbJob {
  contentHash: string;
  adjustments: Adjustments;
  document?: PhotoDocument;
  /**
   * A job raised by a gallery tile rather than by a saved edit.
   *
   * It may only render from already-decoded RAW pixels. On a cold cache it
   * gives up instead of falling through to the SDR path, because that path
   * is the embedded camera JPEG - the very picture this job exists to
   * replace. See `processJob`.
   */
  baseOnly?: boolean;
}

/**
 * What this job renders, at the geometry it is about to be rendered at.
 *
 * The same answer the canvas and the exporter get — a graph-led photo
 * renders its STORED graph, a document with layers its layered graph, and a
 * job that carries only adjustments the flat chain. Without this the library
 * showed a different picture than the editor for exactly the photos the
 * user had just edited in the graph view.
 *
 * The geometry is why the choice is made here and not when the job is
 * queued: a stored graph remembers the size it was built at, and a thumbnail
 * is 300px wide.
 */
export function thumbnailGraph(job: ThumbJob, source: BuilderSourceSpec): DocumentGraph {
  return job.document
    ? buildDocumentGraph(job.document, source)
    : buildAdjustmentsGraph(job.adjustments, source);
}

/** Compile a thumbnail plan, except for a stored graph that is currently
 *  incomplete. Graph-editor rewiring persists intermediate states, and such
 *  a state has no image to replace the last good thumbnail with. Validation
 *  stays limited to stored graphs so a broken graph built by our own code,
 *  and every worker/render/storage failure, still rejects normally. */
export async function compileThumbnailPlan<T>(
  spec: DocumentGraph,
  compile: (graph: DocumentGraph['graph']) => Promise<T>,
): Promise<T | null> {
  if (spec.fromStoredGraph
    && new GraphCompiler(getMainThreadNodeRegistry()).validate(spec.graph)) return null;
  return compile(spec.graph);
}

/**
 * The colour space a gallery thumbnail renders in - sRGB, whatever the editor
 * setting says.
 *
 * A developed thumbnail is stored as an untagged JPEG and shown in an <img>,
 * and an untagged JPEG is sRGB to every browser. Rendering one in the wider
 * space the editor was set to therefore never put that space on screen: the
 * gallery showed those numbers as sRGB, so the tile drifted away from the
 * editor for exactly the photos the user had just edited (F124). The stored
 * key names no colour space either, so a switch of the setting could not
 * invalidate the tiles it changed.
 */
export function thumbnailColorSpace(): OutputColorSpaceId {
  return 'srgb';
}

export interface EditThumbnailSource {
  rawPixels?: RawPixelData;
  previewBlob?: Blob;
}

// Queue of pending jobs — only the latest per contentHash matters
const pending = new Map<string, ThumbJob>();

/**
 * Decoded 300px renditions, keyed by contentHash.
 *
 * Quick Develop re-renders the same photo once per slider release. Without
 * this each of those re-fetched the original from the source — a full download
 * for a remote provider — and decoded it again, which for HEIF means running
 * libheif over the whole frame to fill a 300px tile. The cache turns every run
 * after the first into a small JPEG decode plus the graph render.
 *
 * A Blob is kept rather than an ImageBitmap because bindSource transfers the
 * bitmap to the worker and detaches the main-thread handle, so a bitmap could
 * not be reused a second time anyway.
 *
 * What is cached is the UNDEVELOPED source at thumbnail size, so no adjustment
 * can make an entry stale; only the source file changing underneath could, and
 * the cache is session-scoped and holds a handful of photos.
 */
const decodedSources = new Map<string, Blob>();
const MAX_DECODED_SOURCES = 12;

/**
 * Photos a tile asked for and whose RAW pixels were not decoded yet.
 *
 * Without this, scrolling a library of cold RAWs re-probes OPFS for every
 * tile on every pass. Cleared by `forgetColdThumbnails()` at the one moment
 * the answer can have changed: coming back from the editor, which decodes
 * whatever it opened.
 */
const coldSkipped = new Set<string>();

/** Re-allow tile-raised jobs for photos previously found cold. */
export function forgetColdThumbnails(): void {
  coldSkipped.clear();
}

function rememberDecoded(contentHash: string, blob: Blob): void {
  decodedSources.delete(contentHash);
  decodedSources.set(contentHash, blob);
  while (decodedSources.size > MAX_DECODED_SOURCES) {
    const oldest = decodedSources.keys().next().value;
    if (oldest === undefined) break;
    decodedSources.delete(oldest);
  }
}

async function processJob(job: ThumbJob, providedSource?: EditThumbnailSource): Promise<void> {
  // Lazy imports to avoid module-level side effects
  const { getActiveRepos } = await import('../storage/activeRepos');
  const { sourceManager } = await import('../sources');

  // 1. Find photo by contentHash
  const repos = getActiveRepos();
  const matches = repos?.photos.getByContentHash(job.contentHash) ?? [];
  const photo = matches[0];
  if (!photo) return;

  const svc = getDefaultPipelineService();

  // Batch auto already decoded the source for analysis. Reuse that exact
  // decode instead of loading the file again (and, for RAW, accidentally
  // falling back to the embedded JPEG channel).
  if (providedSource?.rawPixels) {
    await renderRaw16ToCache(svc, job, providedSource.rawPixels, photo);
    return;
  }
  if (providedSource?.previewBlob) {
    // Already a decoded rendition, not the camera file - no decoder ladder.
    await renderSdrToCache(svc, job, providedSource.previewBlob, photo, null);
    return;
  }

  // 2a. RAW fast path: cache-only smart-preview lookup. Skips network +
  //     bypasses the SDR JPEG entirely when the editor has already opened
  //     this photo at least once.
  if (RawDecoder.isRawFile(photo.name)) {
    const rawPixels = await tryLoadCachedRawPixels(photo, sourceManager.get(photo.sourceId)?.type);
    if (rawPixels) {
      try {
        await renderRaw16ToCache(svc, job, rawPixels, photo);
        coldSkipped.delete(job.contentHash);
        return;
      } catch (e) {
        console.warn('[ThumbnailRenderer] raw16 path failed, falling back to SDR:', e);
      }
    } else if (job.baseOnly) {
      // Nothing decoded yet. Warming it costs a full upload and demosaic per
      // file, which is a background task with its own progress and cancel -
      // not something a tile scrolling into view gets to start.
      coldSkipped.add(job.contentHash);
      return;
    }

    // A tile-raised job never reaches the paths below - not on a cold cache,
    // and not when the raw16 render failed. They all end at the embedded
    // camera JPEG, which is the picture this job exists to replace, and
    // storing that under the developed key would hide the real rendering
    // from every later attempt.
    if (job.baseOnly) return;

    // A photo with a base-development profile has no correct SDR rendering:
    // the fallback below binds an `imageBitmap` source, and the base stage
    // only exists on the raw16 source. Rendering the user's adjustments
    // without the base underneath produces a tile that disagrees with the
    // editor in a way nothing on screen explains. Better no developed
    // thumbnail than a confidently wrong one.
    if (baseAdjustmentsFor(photo)) return;
  }

  // 2b. SDR path. A rendition decoded for an earlier job on this photo is
  //     reused as-is: it is already at thumbnail size, so nothing about it
  //     depends on the adjustments being rendered now.
  const cached = decodedSources.get(job.contentHash);
  if (cached) {
    await renderSdrToCache(svc, job, cached, photo, null);
    return;
  }

  const source = sourceManager.get(photo.sourceId);
  if (!source) return;

  let blob: Blob | null = null;
  // The name the decoder ladder should judge the blob by — never the original's
  // name for a display rendition, or a JPEG from a HEIC photo would be sent to
  // libheif.
  let decodeAs: string | null = null;
  // RAW skips getFile on purpose and goes straight to the display rendition:
  // the raw16 path above already covers every RAW whose smart preview is
  // cached, and for a cold cache the ladder would have to demosaic a full
  // camera file just to fill a 300px tile.
  if (!RawDecoder.isRawFile(photo.name)) {
    try {
      const file = await source.getFile({
        sourcePhotoId: photo.sourcePhotoId,
        sourceId: photo.sourceId,
        name: photo.name,
      });
      if (file) { blob = file; decodeAs = photo.name; }
    } catch { /* */ }
  }

  if (!blob) {
    try {
      const url = await source.getDisplayUrl({
        sourcePhotoId: photo.sourcePhotoId,
        sourceId: photo.sourceId,
        name: photo.name,
      });
      if (url) {
        const res = await fetch(url);
        blob = await res.blob();
        // A display URL is always something the browser can render, and going
        // through the ladder gets this path resized and cached like the others.
        decodeAs = 'display.jpg';
        if (url.startsWith('blob:')) URL.revokeObjectURL(url);
      }
    } catch { /* */ }
  }

  if (!blob) return;

  await renderSdrToCache(svc, job, blob, photo, decodeAs);
}

/**
 * @param decodeAs File name to judge `blob` by, or null to hand it straight to
 *   `createImageBitmap`. Non-null routes it through the shared decoder ladder
 *   and caches the result: `createImageBitmap` cannot read HEIC in Chromium or
 *   Firefox, so a HEIF photo used to throw here and never get a developed
 *   thumbnail at all — the grid path has handled it all along via
 *   generateThumbnailBlob, this one did not.
 */
async function renderSdrToCache(
  svc: ReturnType<typeof getDefaultPipelineService>,
  job: ThumbJob,
  blob: Blob,
  photo: PhotoView,
  decodeAs: string | null,
): Promise<void> {
  let bitmap: ImageBitmap;
  if (decodeAs === null) {
    bitmap = await createImageBitmap(blob, { resizeWidth: THUMB_LONG_EDGE, resizeQuality: 'medium' });
  } else {
    const rendition = await generateThumbnailBlob(
      blob instanceof File ? blob : new File([blob], decodeAs),
      THUMB_LONG_EDGE,
    );
    rememberDecoded(job.contentHash, rendition);
    bitmap = await createImageBitmap(rendition);
  }

  const sourceId = nextThumbSourceId();
  let maskIds: string[] = [];
  try {
    const builderSource: BuilderSourceSpec = {
      kind: 'imageBitmap',
      geometry: { width: bitmap.width, height: bitmap.height, pixelRatio: 1 },
      outputColorSpaceId: thumbnailColorSpace(),
    };
    const spec = thumbnailGraph(job, builderSource);
    const plan = await compileThumbnailPlan(spec, (graph) => svc.compile(graph));
    if (!plan) return;

    // bindSource transfers the bitmap to the worker (detaches main-thread
    // handle); the worker holds it until unbindSource in the finally block.
    await svc.bindSource(sourceId, bitmap);
    const masks = await bindDocumentMasks(
      svc, spec.maskLayers, sourceId, bitmap.width, bitmap.height,
    );
    maskIds = masks.boundIds;
    const editBlob = await svc.renderToBlob(plan, sourceId, spec.params, {
      type: 'image/jpeg', quality: 0.7,
    }, extraSourcesOf(masks));

    await storeEditThumbnail(photo, job.contentHash, editBlob);
    void svc.releasePlan(plan);
  } finally {
    void svc.unbindSource(sourceId);
    unbindDocumentMasks(svc, maskIds);
  }
}

let _thumbSourceCounter = 0;
function nextThumbSourceId(): string {
  return `thumb-render-${++_thumbSourceCounter}`;
}

/**
 * Try to load 16-bit linear pixels for a RAW photo from the smart-preview
 * OPFS cache (populated by `useRawImage` on prior editor opens). Returns
 * null on cache miss — the caller should fall through to the SDR path.
 */
async function tryLoadCachedRawPixels(
  photo: PhotoView,
  sourceType: string | undefined,
): Promise<RawPixelData | null> {
  const { loadRawPixels } = await import('./raw/loadRawPixels');
  try {
    // Cache-only on purpose: no file, no hints. A tile must never pull a cold
    // RAW from its source (coldSkipped). The source type matters — a local
    // RAW's pixels are cached by libraw-wasm under its own slot, which the
    // smart-preview strategy alone never found.
    const res = await loadRawPixels({
      identity: photo,
      size: getSmartPreviewSize(),
      sourceType,
      wantPreview: false,
    });
    if (res?.displayUrl.startsWith('blob:')) URL.revokeObjectURL(res.displayUrl);
    if (res?.rawPixels && res.rawPixels.bits === 16 && res.rawPixels.data instanceof Uint16Array) {
      return res.rawPixels;
    }
  } catch (e) {
    console.warn('[ThumbnailRenderer] smart-preview cache probe failed:', e);
  }
  return null;
}

async function renderRaw16ToCache(
  svc: ReturnType<typeof getDefaultPipelineService>,
  job: ThumbJob,
  px: RawPixelData,
  photo: PhotoView,
): Promise<void> {
  // Clone the Uint16 buffer: bindSource transfers it (detaches), and the
  // SmartPreviewStrategy cache may still hold the original reference.
  const pixelsCopy = new Uint16Array(px.data as Uint16Array);
  const raw16: Raw16SourceData = {
    pixels: pixelsCopy,
    width: px.width,
    height: px.height,
    channels: px.channels,
  };
  const builderSource: BuilderSourceSpec = {
    kind: 'raw16',
    geometry: { width: px.width, height: px.height, pixelRatio: 1 },
    channels: px.channels,
    calibration: {
      asShotNeutral: px.asShotNeutral ?? null,
      colorMatrix: px.colorMatrix ?? null,
    },
    // The gallery has to show what the editor shows. Skipping the camera
    // profile here would leave every developed RAW thumbnail rendering a
    // different picture than the editor does for the same photo.
    baseAdjustments: baseAdjustmentsFor(photo),
    lensProfile: lensCoefficientsFor(photo),
    outputColorSpaceId: thumbnailColorSpace(),
  };
  const sourceId = nextThumbSourceId();
  let maskIds: string[] = [];
  try {
    const spec = thumbnailGraph(job, builderSource);
    const plan = await compileThumbnailPlan(spec, (graph) => svc.compile(graph));
    if (!plan) return;
    await svc.bindSource(sourceId, raw16);
    const masks = await bindDocumentMasks(svc, spec.maskLayers, sourceId, px.width, px.height);
    maskIds = masks.boundIds;
    // Render runs at smart-preview resolution; the encoded thumb must not
    // (thumbMemCache is entry-count-capped, full-size JPEGs blow it up).
    const editBlob = await svc.renderToBlob(plan, sourceId, spec.params, {
      type: 'image/jpeg', quality: 0.7, maxDim: THUMB_LONG_EDGE,
    }, extraSourcesOf(masks));
    await storeEditThumbnail(photo, job.contentHash, editBlob);
    void svc.releasePlan(plan);
  } finally {
    void svc.unbindSource(sourceId);
    unbindDocumentMasks(svc, maskIds);
  }
}

async function storeEditThumbnail(photo: PhotoView, contentHash: string, blob: Blob): Promise<void> {
  const [{ thumbMemCache }, { getActiveRepos }] = await Promise.all([
    import('../cache/ThumbMemCache'),
    import('../storage/activeRepos'),
  ]);
  // Persist first so a tile mounted by the following React paint can recover
  // the developed thumbnail even after RAM eviction or an app restart.
  const key = editThumbnailKey(contentHash, thumbnailStampFor(photo));
  await getActiveRepos()?.thumbnails.set(key, blob);
  thumbMemCache.put(photo.id, blob);
}

function flush(): void {
  if (paused || pending.size === 0) return;

  const [key, job] = pending.entries().next().value as [string, ThumbJob];
  pending.delete(key);

  processJob(job).catch((e) => {
    console.error('[ThumbnailRenderer] processJob failed', e);
  }).finally(() => {
    if (pending.size > 0) {
      idleHandle = requestIdleCallback(flush, { timeout: FLUSH_DEADLINE_MS });
    }
  });
}

/**
 * Queue a background edit thumbnail render.
 * Call this when edits are persisted to DB or pulled from sync.
 * Only the latest job per contentHash is kept.
 */
export function queueEditThumbnail(contentHash: string, adjustments: Adjustments, document?: PhotoDocument): void {
  pending.set(contentHash, { contentHash, adjustments, document });
  if (paused) return;

  if (idleHandle) cancelIdleCallback(idleHandle);
  // With no deadline the browser can defer this for as long as the user keeps
  // interacting — which is exactly while a Quick Develop slider is moving.
  idleHandle = requestIdleCallback(flush, { timeout: FLUSH_DEADLINE_MS });
}

/**
 * Queue the developed thumbnail a gallery tile is missing.
 *
 * The trigger every other caller of `queueEditThumbnail` is not: those all
 * hang off a saved edit, so a RAW nobody has touched never got a developed
 * thumbnail and the tile kept showing the embedded camera JPEG - a different
 * picture than the editor, for the same photo, as soon as a base profile
 * existed.
 *
 * Rendering only ever happens from already-decoded pixels (`baseOnly`), so
 * this is cheap enough to raise from a tile: for a photo the editor has
 * opened before it costs one OPFS read plus a 300px render, and for one it
 * has not it costs a failed lookup and nothing else.
 *
 * A pending job from a real edit is never displaced - that one carries the
 * user's own work and may render by paths this one is not allowed to use.
 */
export function queueBaseThumbnail(contentHash: string, adjustments: Adjustments, document?: PhotoDocument): void {
  if (coldSkipped.has(contentHash)) return;
  const existing = pending.get(contentHash);
  if (existing && !existing.baseOnly) return;
  pending.set(contentHash, { contentHash, adjustments, document, baseOnly: true });
  if (paused) return;
  if (idleHandle) cancelIdleCallback(idleHandle);
  idleHandle = requestIdleCallback(flush, { timeout: FLUSH_DEADLINE_MS });
}

/** Render immediately when the caller already has decoded analysis pixels. */
export async function renderEditThumbnailNow(
  contentHash: string,
  adjustments: Adjustments,
  document?: PhotoDocument,
  source?: EditThumbnailSource,
): Promise<void> {
  await processJob({ contentHash, adjustments, document }, source);
}

/** Cancel any pending jobs. Pipeline resources are owned by PipelineService
 *  now and outlive the renderer; nothing GL-specific to free here. */
export function destroyThumbnailRenderer(): void {
  if (idleHandle) cancelIdleCallback(idleHandle);
  pending.clear();
}
