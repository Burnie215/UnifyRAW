import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useRenderPipeline } from './useRenderPipeline';
import type { RawPixelData } from '../engine/raw/RawDecoderStrategy';
import type { BuilderAdjustments } from '../engine/graph';
import type { LensCoefficients } from '../engine/lensProfile';
import { perfLog } from '../platform/perfLog';

/**
 * Whether the canvas shows these pixels through the 16-bit path. Both load
 * effects ask it, so exactly one of them loads a photo.
 */
export function takesRaw16Path(
  rawPixels: RawPixelData | null | undefined,
  hdr: boolean,
): rawPixels is RawPixelData {
  return !!rawPixels && hdr && rawPixels.bits === 16;
}

/** What a 16-bit upload was made from. */
export interface Raw16Load {
  pixels: RawPixelData;
  base: BuilderAdjustments | null;
  lens: LensCoefficients | null;
  photoId: number | undefined;
}

/** The same four objects again: the canvas already shows them. */
export function sameRaw16Load(loaded: Raw16Load | null, next: Raw16Load): boolean {
  return !!loaded && loaded.pixels === next.pixels && loaded.base === next.base
    && loaded.lens === next.lens && loaded.photoId === next.photoId;
}

/**
 * Encapsulates all canvas rendering, zoom/pan, and fitScale logic.
 * Uses WebGL2 for rendering.
 */
export function useEditorCanvas(
  displayUrl: string | null,
  displayBlob?: Blob | null,
  rawPixels?: RawPixelData | null,
  photoId?: number,
  /** The photo's camera base development, or null when it has none. */
  rawBaseAdjustments?: BuilderAdjustments | null,
  /** The photo's lens correction, or null when the lens is unknown. */
  rawLensProfile?: LensCoefficients | null,
) {
  const webgl = useRenderPipeline();
  const {
    ready: pipelineReady,
    error: pipelineError,
    hdr: pipelineHdr,
    setImage: setPipelineImage,
    setImageRaw: setPipelineRawImage,
    retryInitialization: retryPipelineInitialization,
  } = webgl;

  // Canvas refs and state
  const glCanvasRef = useRef<HTMLCanvasElement>(null);
  const [glCanvasEl, setGlCanvasEl] = useState<HTMLCanvasElement | null>(null);
  const [useWebGL, setUseWebGL] = useState(true);
  const [glImageLoaded, setGlImageLoaded] = useState(false);

  // Which photo's pixels are currently on the canvas. Set together with
  // glImageLoaded=true and reset on every (re-)load. Consumers compare this
  // against their notion of the "current" photo before persisting derived
  // artefacts (edit-thumbnails, exports), so async work that resolves after
  // a photo switch cannot attribute stale pixels to the new id.
  const [loadedPhotoId, setLoadedPhotoId] = useState<number | undefined>(undefined);
  const [sourceLoadGen, setSourceLoadGen] = useState(0);

  // Image dimensions
  const [nativeImgDims, setNativeImgDims] = useState({ w: 0, h: 0 });
  const [containerDims, setContainerDims] = useState({ w: 0, h: 0 });
  const [imgDims, setImgDims] = useState({ w: 0, h: 0 });

  // Zoom/Pan
  const [zoom, setZoom] = useState(1);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);

  // Render generation counter
  const [renderGen, setRenderGen] = useState(0);
  const [loadAttempt, setLoadAttempt] = useState(0);

  // Fit scale — stable ref to prevent jitter
  const fitScaleRef = useRef(0);
  const fitScale = useMemo(() => {
    if (!nativeImgDims.w || !nativeImgDims.h || !containerDims.w || !containerDims.h) return fitScaleRef.current || 1;
    const newScale = Math.min(containerDims.w / nativeImgDims.w, containerDims.h / nativeImgDims.h);
    if (fitScaleRef.current === 0 || Math.abs(newScale - fitScaleRef.current) / fitScaleRef.current > 0.02) {
      fitScaleRef.current = newScale;
    }
    return fitScaleRef.current;
  }, [nativeImgDims, containerDims]);

  // Container ref callback
  const imgContainerRef = useRef<HTMLDivElement>(null);
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const containerRefCb = useCallback((el: HTMLDivElement | null) => {
    imgContainerRef.current = el;
    setContainerEl(el);
    if (el) setContainerDims({ w: el.clientWidth, h: el.clientHeight });
  }, []);

  // Track container dimensions via ResizeObserver
  useEffect(() => {
    if (!containerEl) return;
    const ro = new ResizeObserver(([entry]) => {
      setContainerDims({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    ro.observe(containerEl);
    return () => ro.disconnect();
  }, [containerEl]);

  // Canvas ref callback
  const canvasRefCb = useCallback((el: HTMLCanvasElement | null) => {
    glCanvasRef.current = el;
    setGlCanvasEl(el);
  }, []);

  // Load image into WebGL pipeline — only when we have the full-res blob (not thumbnails).
  // Falls back to displayUrl only if no blob is provided (remote sources).
  const loadedBlobRef = useRef<Blob | null>(null);
  const loadedRawRef = useRef<Raw16Load | null>(null);

  const retryRender = useCallback(() => {
    // Force the appropriate source effect through its same-source guard. This
    // retries both upload failures and later render failures in a fresh engine
    // attempt while keeping the original preview available.
    loadedBlobRef.current = null;
    loadedRawRef.current = null;
    setGlImageLoaded(false);
    setLoadedPhotoId(undefined);
    setUseWebGL(true);
    setRenderGen((generation) => generation + 1);
    setLoadAttempt((attempt) => attempt + 1);
    if (pipelineError) retryPipelineInitialization();
  }, [pipelineError, retryPipelineInitialization]);

  // 16-bit RAW path. It takes priority when both are available — we want the
  // full editing precision, not the downcast preview JPEG. It does not listen
  // to displayUrl/displayBlob: the host mirrors the RAW's preview URL into its
  // own state one render after the pixels arrive, and that echo used to upload
  // the 16-bit pixels a second time.
  useEffect(() => {
    if (!pipelineReady || pipelineError) return;
    if (!takesRaw16Path(rawPixels, pipelineHdr)) return;
    const load: Raw16Load = {
      pixels: rawPixels, base: rawBaseAdjustments ?? null, lens: rawLensProfile ?? null, photoId,
    };
    if (sameRaw16Load(loadedRawRef.current, load)) {
      perfLog.mark('image-load', 'canvas effect SKIP (same raw)');
      return;
    }
    perfLog.mark('image-load', `canvas effect (16-bit raw ${rawPixels.width}x${rawPixels.height})`);
    setGlImageLoaded(false);
    setLoadedPhotoId(undefined);
    setRenderGen(0);
    setUseWebGL(true);
    loadedBlobRef.current = null;
    let cancelled = false;
    setPipelineRawImage(rawPixels, load.base, load.lens).then((dims) => {
      if (cancelled) return;
      loadedRawRef.current = load;
      perfLog.mark('image-load', `pipeline done 16-bit (${dims.w}x${dims.h})`);
      setNativeImgDims(dims);
      setLoadedPhotoId(load.photoId);
      setSourceLoadGen((generation) => generation + 1);
      setGlImageLoaded(true);
      setRenderGen((g) => g + 1);
    }).catch((e) => {
      perfLog.mark('image-load', `16-bit pipeline FAILED: ${e instanceof Error ? e.message : 'unknown'}`);
      if (!cancelled) setUseWebGL(false);
    });
    return () => { cancelled = true; };
  }, [
    rawPixels, rawBaseAdjustments, rawLensProfile, photoId,
    pipelineReady, pipelineError, pipelineHdr, setPipelineRawImage, loadAttempt,
  ]);

  useEffect(() => {
    if (!pipelineReady || pipelineError) {
      perfLog.mark('image-load', `canvas effect SKIP (ready=${pipelineReady}, error=${pipelineError})`);
      return;
    }
    // The 16-bit effect owns this photo. rawPixels stays a dependency so that
    // pixels arriving mid-load cancel the blob load below.
    if (takesRaw16Path(rawPixels, pipelineHdr)) return;

    const blob = displayBlob;
    if (!blob && !displayUrl) return;
    if (blob && blob === loadedBlobRef.current) {
      perfLog.mark('image-load', 'canvas effect SKIP (same blob)');
      return;
    }
    if (!blob && !displayUrl) return;

    const source = blob || displayUrl!;
    perfLog.mark('image-load', `canvas effect (${source instanceof Blob ? `Blob ${Math.round((source as Blob).size / 1024)}KB` : 'URL'})`);
    setGlImageLoaded(false);
    setLoadedPhotoId(undefined);
    setRenderGen(0);
    setUseWebGL(true);
    loadedBlobRef.current = blob ?? null;
    loadedRawRef.current = null;
    const loadFor = photoId;
    let cancelled = false;

    setPipelineImage(source).then((dims) => {
      if (cancelled) return;
      perfLog.mark('image-load', `pipeline done (${dims.w}x${dims.h})`);
      setNativeImgDims(dims);
      setLoadedPhotoId(loadFor);
      setSourceLoadGen((generation) => generation + 1);
      setGlImageLoaded(true);
      setRenderGen((g) => g + 1);
    }).catch(() => {
      perfLog.mark('image-load', 'pipeline FAILED');
      if (!cancelled) setUseWebGL(false);
    });
    return () => { cancelled = true; };
  }, [
    displayBlob, displayUrl, rawPixels, photoId,
    pipelineReady, pipelineError, pipelineHdr, setPipelineImage, loadAttempt,
  ]);

  // Reset pan when zoom returns to fit
  useEffect(() => { if (zoom <= 1) { setPanX(0); setPanY(0); } }, [zoom]);

  // 1:1 zoom handler
  const handleOneToOne = useCallback(() => {
    if (fitScale <= 0) return;
    setZoom(1 / fitScale);
  }, [fitScale]);

  const pipeline = useMemo(() => ({
    ...webgl,
    renderDoc: webgl.renderDoc,
  }), [webgl]);

  return {
    pipeline,
    useWebGL,
    glImageLoaded,
    loadedPhotoId,
    sourceLoadGen,
    glCanvasRef,
    glCanvasEl,
    canvasRefCb,
    imgContainerRef,
    containerRefCb,
    containerEl,
    containerDims,
    nativeImgDims,
    setNativeImgDims,
    imgDims,
    setImgDims,
    zoom,
    setZoom,
    panX,
    setPanX,
    panY,
    setPanY,
    fitScale,
    handleOneToOne,
    transform: useMemo(() => {
      const s = fitScale * zoom;
      return `scale(${s}) translate(${panX / s}px, ${panY / s}px)`;
    }, [fitScale, zoom, panX, panY]),
    renderGen,
    setRenderGen,
    setUseWebGL,
    retryRender,
  };
}
