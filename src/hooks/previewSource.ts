/**
 * The graph editor's preview source: the photo loaded once, downscaled to
 * PREVIEW_SOURCE_MAX_DIM and bound once in the pipeline worker, shared by
 * every preview surface that renders the same photo (the preview taps in the
 * graph and the output panel). Reference-counted per source; the last release
 * unbinds it.
 *
 * WHICH KIND gets bound follows the document's graph, not the surface. A RAW
 * document's graph carries a raw16 source node, and binding the 8-bit display
 * JPEG to it throws in the worker ("bound external data must be a
 * Raw16SourceData"), which left every preview on a RAW empty. So a RAW
 * preview downscales the 16-bit linear pixels and binds those - the same
 * pixels, and therefore the same picture, the document itself renders.
 */
import {
  getDefaultPipelineService,
  KIND_RAW16_SOURCE,
  type Raw16SourceData,
  type RenderGraph,
} from '../engine/graph';
import { resizeRaw16LongEdge } from '../engine/raw/resizeRaw16';
import type { RawPixelData } from '../engine/raw/RawDecoderStrategy';

export const PREVIEW_SOURCE_MAX_DIM = 512;

/** What a preview surface has to bind, keyed for the shared per-source cache. */
export type PreviewSourceSpec =
  | { kind: 'imageBitmap'; key: string; url: string }
  | { kind: 'raw16'; key: string; pixels: RawPixelData };

export interface PreviewSource {
  sourceId: string;
  /** The downscaled size; previewSubgraph rewrites the source nodes to it. */
  dims: { width: number; height: number };
}

export interface PreviewSourceLease extends PreviewSource {
  /** Idempotent. The last release of a source unbinds it. */
  release(): void;
}

interface Entry {
  refs: number;
  ready: Promise<PreviewSource>;
}

const entries = new Map<string, Entry>();
// Every load binds under its own id: the unbind of a released load may still
// be on its way when the same source is loaded again, and must not hit the new
// binding.
let loadSeq = 0;

// Stable per-buffer id, so the key tracks buffer IDENTITY - dimensions alone
// collide across photos from the same camera.
let nextBufferId = 0;
const bufferIds = new WeakMap<object, number>();
function bufferIdentity(data: object): number {
  let id = bufferIds.get(data);
  if (id === undefined) {
    id = ++nextBufferId;
    bufferIds.set(data, id);
  }
  return id;
}

/**
 * The source this graph's own source node will accept, or null when the
 * preview cannot render yet: a RAW whose 16-bit pixels are still decoding has
 * nothing the graph takes, and the 8-bit display JPEG is not a substitute for
 * it - binding that is what made every RAW preview fail.
 */
export function previewSourceSpecFor(
  graph: RenderGraph | null,
  sourceUrl: string | null,
  rawPixels?: RawPixelData | null,
): PreviewSourceSpec | null {
  if (!graph) return null;
  let wantsRaw16 = false;
  for (const node of graph.nodes.values()) {
    if (node.kind === KIND_RAW16_SOURCE) { wantsRaw16 = true; break; }
  }
  if (!wantsRaw16) {
    return sourceUrl ? { kind: 'imageBitmap', key: sourceUrl, url: sourceUrl } : null;
  }
  return rawPreviewSourceSpec(rawPixels);
}

export function rawPreviewSourceSpec(
  rawPixels?: RawPixelData | null,
): PreviewSourceSpec | null {
  if (!rawPixels || rawPixels.bits !== 16 || !(rawPixels.data instanceof Uint16Array)) return null;
  return {
    kind: 'raw16',
    key: `raw16:${bufferIdentity(rawPixels.data)}:${rawPixels.width}x${rawPixels.height}`,
    pixels: rawPixels,
  };
}

/**
 * Preview-sized 16-bit pixels. Always a FRESH buffer (resizeRaw16LongEdge
 * copies even when it does not resize): bindSource TRANSFERS what it is given,
 * and detaching the editor's own buffer would blank the canvas it renders.
 */
export function downscaleRaw16(pixels: RawPixelData, maxDim: number): Raw16SourceData {
  const frame = resizeRaw16LongEdge({
    data: pixels.data as Uint16Array,
    width: pixels.width,
    height: pixels.height,
    channels: pixels.channels,
  }, maxDim);
  return {
    pixels: frame.data, width: frame.width, height: frame.height, channels: frame.channels,
  };
}

export function acquirePreviewSource(spec: PreviewSourceSpec): Promise<PreviewSourceLease> {
  let entry = entries.get(spec.key);
  if (!entry) {
    const created: Entry = { refs: 0, ready: loadPreviewSource(spec, `preview-src:${++loadSeq}`) };
    created.ready.catch(() => {
      if (entries.get(spec.key) === created) entries.delete(spec.key);
    });
    entries.set(spec.key, created);
    entry = created;
  }
  const owned = entry;
  owned.refs++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    owned.refs--;
    if (owned.refs > 0) return;
    if (entries.get(spec.key) === owned) entries.delete(spec.key);
    void owned.ready
      .then((source) => getDefaultPipelineService().unbindSource(source.sourceId))
      .catch(() => { /* never bound, or the worker is gone */ });
  };
  return owned.ready.then(
    (source) => ({ ...source, release }),
    (e: unknown) => { release(); throw e; },
  );
}

/**
 * Holds one lease between a hook's render cycles, so a param change renders
 * against the bound source instead of loading it again. `keep(spec)` moves to
 * another source, `keep(null)` lets go - the owner calls that on unmount. A
 * lease that is still loading is released as soon as it arrives.
 */
export interface PreviewSourceKeeper {
  keep(spec: PreviewSourceSpec | null): void;
}

export function createPreviewSourceKeeper(): PreviewSourceKeeper {
  let kept: { key: string; lease: Promise<PreviewSourceLease> } | null = null;
  return {
    keep(spec) {
      if (kept && kept.key === spec?.key) return;
      const previous = kept;
      kept = null;
      previous?.lease.then((lease) => lease.release(), () => { /* a failed load holds nothing */ });
      if (!spec) return;
      const next = { key: spec.key, lease: acquirePreviewSource(spec) };
      next.lease.catch(() => { if (kept === next) kept = null; });
      kept = next;
    },
  };
}

async function loadPreviewSource(spec: PreviewSourceSpec, sourceId: string): Promise<PreviewSource> {
  if (spec.kind === 'raw16') {
    const data = downscaleRaw16(spec.pixels, PREVIEW_SOURCE_MAX_DIM);
    const dims = { width: data.width, height: data.height };
    await getDefaultPipelineService().bindSource(sourceId, data);
    return { sourceId, dims };
  }
  const blob = await (await fetch(spec.url)).blob();
  const bitmap = await createDownscaledBitmap(blob, PREVIEW_SOURCE_MAX_DIM);
  // Read before bindSource: the bitmap is transferred to the worker
  // (detached), after which width/height read as 0.
  const dims = { width: bitmap.width, height: bitmap.height };
  try {
    await getDefaultPipelineService().bindSource(sourceId, bitmap);
  } catch (e) {
    bitmap.close();
    throw e;
  }
  return { sourceId, dims };
}

export async function createDownscaledBitmap(blob: Blob, maxDim: number): Promise<ImageBitmap> {
  const full = await createImageBitmap(blob);
  if (full.width <= maxDim && full.height <= maxDim) return full;
  const scale = Math.min(maxDim / full.width, maxDim / full.height);
  const w = Math.max(1, Math.round(full.width * scale));
  const h = Math.max(1, Math.round(full.height * scale));
  const scaled = await createImageBitmap(full, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' });
  full.close();
  return scaled;
}
