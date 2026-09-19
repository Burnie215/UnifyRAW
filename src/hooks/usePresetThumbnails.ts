import { useEffect, useRef, useState } from 'react';
import { revokeBlobUrls } from '../platform/objectUrls';
import type { PresetRow } from '../storage/repos';
import {
  getDefaultPipelineService,
  buildDefaultGraph,
  adjustmentsToBuilderAdjustments,
  paramsByNodeFromAdjustments,
  type PlanHandle,
  type BuilderSourceSpec,
} from '../engine/graph';
import type { RawPixelData } from '../engine/raw/RawDecoderStrategy';
import { getOutputColorSpace } from '../engine/outputColorSpaces';
import {
  acquirePreviewSource,
  rawPreviewSourceSpec,
  type PreviewSourceLease,
} from './previewSource';

let _presetSourceCounter = 0;
function nextPresetSourceId(): string {
  return `preset-thumb-${++_presetSourceCounter}`;
}

const THUMB_SIZE = 120;

export interface PresetThumbRawSource {
  pixels: RawPixelData;
  outputColorSpaceId?: import('../engine/outputColorSpaces').OutputColorSpaceId;
  /**
   * The open photo's camera profile, or null. A preset thumbnail that skipped
   * it would promise a look the photo cannot reach: the preset is applied on
   * top of the base development, not instead of it.
   */
  baseAdjustments?: import('../engine/graph').BuilderAdjustments | null;
  /** The open photo's lens correction, or null. */
  lensProfile?: import('../engine/lensProfile').LensCoefficients | null;
}

/**
 * Renders preset thumbnails via the unified graph PipelineService. Each
 * preset becomes a per-node params override against a shared default-graph
 * plan, so all presets reuse the same compiled topology + FBO pool.
 *
 * For RAW sources, pass `rawSource` so the hook routes through the raw16
 * (HDR) plan with the camera's calibration baked in. Without `rawSource`,
 * RAW imageUrls are still decoded as the SDR smart-preview JPEG and won't
 * match the editor's HDR-linear output exactly.
 *
 * Returns Map<presetId, blobUrl> that updates when imageUrl, rawSource, or
 * presets change.
 */
export function usePresetThumbnails(
  imageUrl: string | null | undefined,
  presets: PresetRow[],
  rawSource?: PresetThumbRawSource | null,
): Map<number, string> {
  const [thumbnails, setThumbnails] = useState<Map<number, string>>(new Map());
  const currentSourceKey = useRef<string | null>(null);
  /** Worker-side source id currently bound. Cleared on unbind. */
  const sourceIdRef = useRef<string | null>(null);
  const rawSourceLeaseRef = useRef<PreviewSourceLease | null>(null);
  const planRef = useRef<PlanHandle | null>(null);
  const generationRef = useRef(0);
  /**
   * The URLs on screen, kept where an unmount cleanup can reach them. They
   * used to be released from inside a `setThumbnails` updater, and React never
   * runs an updater for a component that is gone - so closing the editor left
   * the whole preset panel's blobs alive for the life of the tab (F060).
   */
  const liveUrlsRef = useRef<string[]>([]);
  /** False once the panel is gone; a render still in flight has no screen. */
  const mountedRef = useRef(true);

  /** Show `next` and release whatever was on screen before it. */
  function publish(next: Map<number, string>): void {
    if (!mountedRef.current) { revokeBlobUrls(next.values()); return; }
    const previous = liveUrlsRef.current;
    liveUrlsRef.current = [...next.values()];
    setThumbnails(next);
    revokeBlobUrls(previous);
  }

  const rawPreviewSpec = rawSource?.pixels ? rawPreviewSourceSpec(rawSource.pixels) : null;
  const sourceKey: string | null = rawSource?.pixels ? rawPreviewSpec?.key ?? null : imageUrl ?? null;

  // Stabilise presets reference — re-render only when ID set or updatedAt change.
  const presetKey = presets.map((p) => `${p.id}:${p.updatedAt ?? 0}`).join(',');
  const presetsRef = useRef(presets);
  const lastKeyRef = useRef(presetKey);
  if (lastKeyRef.current !== presetKey) {
    presetsRef.current = presets;
    lastKeyRef.current = presetKey;
  }
  const stablePresets = presetsRef.current;

  // The default graph builder caches the chain shape by source spec — keep a
  // ref to the spec so renderAll uses the same shape paramsByNode was keyed on.
  const builderSourceRef = useRef<BuilderSourceSpec | null>(null);

  // Effect 1: (re)load the source + compile the plan when the source identity
  // changes (different RAW pixel buffer, or different imageUrl). Binds the
  // source into the worker so subsequent renders re-use it without re-transfer.
  useEffect(() => {
    if (!sourceKey) return;
    if (currentSourceKey.current === sourceKey) return;
    currentSourceKey.current = sourceKey;

    let cancelled = false;
    publish(new Map());

    const svc = getDefaultPipelineService();
    const prevSourceId = sourceIdRef.current;
    const prevRawLease = rawSourceLeaseRef.current;
    if (prevRawLease) prevRawLease.release();
    else if (prevSourceId) void svc.unbindSource(prevSourceId);
    rawSourceLeaseRef.current = null;
    sourceIdRef.current = null;
    planRef.current = null;
    builderSourceRef.current = null;

    (async () => {
      let rawLease: PreviewSourceLease | null = null;
      try {
        let builderSource: BuilderSourceSpec;
        let workerSource: ImageBitmap | null = null;
        let sourceId: string;

        if (rawSource?.pixels && rawPreviewSpec) {
          const px = rawSource.pixels;
          rawLease = await acquirePreviewSource(rawPreviewSpec);
          if (cancelled) { rawLease.release(); return; }
          sourceId = rawLease.sourceId;
          builderSource = {
            kind: 'raw16',
            geometry: { ...rawLease.dims, pixelRatio: 1 },
            channels: px.channels,
            calibration: {
              asShotNeutral: px.asShotNeutral ?? null,
              colorMatrix: px.colorMatrix ?? null,
            },
            baseAdjustments: rawSource.baseAdjustments ?? null,
            lensProfile: rawSource.lensProfile ?? null,
            outputColorSpaceId: rawSource.outputColorSpaceId ?? getOutputColorSpace(),
          };
        } else if (imageUrl) {
          const res = await fetch(imageUrl);
          const blob = await res.blob();
          const bitmap = await createImageBitmap(blob, {
            resizeWidth: THUMB_SIZE, resizeQuality: 'low',
          });
          if (cancelled) { bitmap.close(); return; }
          workerSource = bitmap;
          sourceId = nextPresetSourceId();
          builderSource = {
            kind: 'imageBitmap',
            geometry: { width: bitmap.width, height: bitmap.height, pixelRatio: 1 },
            outputColorSpaceId: getOutputColorSpace(),
          };
        } else {
          return;
        }

        const { graph } = buildDefaultGraph({}, builderSource);
        const plan = await svc.compile(graph);
        if (cancelled) { rawLease?.release(); return; }

        if (workerSource) await svc.bindSource(sourceId, workerSource);
        if (cancelled) {
          if (rawLease) rawLease.release();
          else void svc.unbindSource(sourceId);
          return;
        }

        rawSourceLeaseRef.current = rawLease;
        sourceIdRef.current = sourceId;
        builderSourceRef.current = builderSource;
        planRef.current = plan;

        void renderAll();
      } catch (e) {
        rawLease?.release();
        console.error('[PresetThumb] source load failed', e);
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  // Effect 2: re-render when the preset set changes (and the source is ready).
  useEffect(() => {
    if (!planRef.current || !sourceIdRef.current) return;
    void renderAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stablePresets]);

  // Cleanup on unmount: unbind worker source + release object URLs.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const sid = sourceIdRef.current;
      const rawLease = rawSourceLeaseRef.current;
      if (rawLease) rawLease.release();
      else if (sid) void getDefaultPipelineService().unbindSource(sid);
      rawSourceLeaseRef.current = null;
      sourceIdRef.current = null;
      revokeBlobUrls(liveUrlsRef.current);
      liveUrlsRef.current = [];
    };
  }, []);

  async function renderAll(): Promise<void> {
    const plan = planRef.current;
    const builderSource = builderSourceRef.current;
    const sourceId = sourceIdRef.current;
    if (!plan || !builderSource || !sourceId || stablePresets.length === 0) return;

    const gen = ++generationRef.current;
    const svc = getDefaultPipelineService();
    const results = new Map<number, string>();

    for (const preset of stablePresets) {
      // A newer generation owns the panel now; these renders are nobody's.
      if (!preset.id || gen !== generationRef.current) { revokeBlobUrls(results.values()); return; }
      try {
        const builderAdj = adjustmentsToBuilderAdjustments(preset.adjustments);
        // Chain-shape must match the one in builderSource — the raw16 chain
        // emits 3 extra HDR nodes that the SDR chain doesn't have.
        const params = paramsByNodeFromAdjustments(builderAdj, builderSource);
        const blob = await svc.renderToBlob(plan, sourceId, params, {
          maxDim: THUMB_SIZE * 2,
          type: 'image/jpeg', quality: 0.7,
        });
        if (gen !== generationRef.current) { revokeBlobUrls(results.values()); return; }
        results.set(preset.id, URL.createObjectURL(blob));
      } catch (e) {
        console.error('[PresetThumb] render failed for', preset.name, e);
      }
    }

    if (gen === generationRef.current) publish(results);
    else revokeBlobUrls(results.values());
  }

  return thumbnails;
}
