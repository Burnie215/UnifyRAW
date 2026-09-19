import { useEffect, useRef, useState } from 'react';
import { defaultAdjustments, type Adjustments } from '../types';
import { adjustmentsToDocument, type PhotoDocument } from '../engine/DocumentModel';
import type { RenderOverlay } from './useRenderPipeline';
import { getProofFilter, type ProofProfile } from '../image/proofFilter';
import { perfLog } from '../platform/perfLog';
import {
  buildDocumentGraph,
  needsDocumentGraph,
  preCurveStopNodeFor,
  type BuilderSourceSpec,
} from '../engine/graph';

interface UseWebGLRendererParams {
  canvas: {
    pipeline: {
      ready: boolean;
      error: unknown;
      render: (adj: Adjustments, overlay?: RenderOverlay) => Promise<ImageBitmap | null>;
      renderDocUpTo?: (doc: PhotoDocument, stopNodeId: string, overlay?: RenderOverlay) => Promise<ImageBitmap | null>;
      renderDoc?: (doc: PhotoDocument, overlay?: RenderOverlay) => Promise<ImageBitmap | null>;
      getBuilderSource?: () => BuilderSourceSpec | null;
    };
    glCanvasRef: React.RefObject<HTMLCanvasElement | null>;
    glCanvasEl: HTMLCanvasElement | null;
    glImageLoaded: boolean;
    loadedPhotoId: number | undefined;
    sourceLoadGen: number;
    useWebGL: boolean;
    setUseWebGL: (v: boolean) => void;
    setNativeImgDims: (fn: (prev: { w: number; h: number }) => { w: number; h: number }) => void;
    setImgDims: (fn: ((prev: { w: number; h: number }) => { w: number; h: number }) | { w: number; h: number }) => void;
    renderGen: number;
    setRenderGen: (fn: (prev: number) => number) => void;
  };
  adjustments: Adjustments;
  document?: PhotoDocument;
  activeLayerId: string | null;
  viewSelectedRange: { hueCenter: number; hueHalfWidth: number; feather?: number; satMin?: number; satMax?: number } | null;
  customHslSectors: { hueCenter: number; hueHalfWidth: number; feather: number; dH: number; dS: number; dL: number }[];
  softProofEnabled: boolean;
  softProofProfile: ProofProfile;
  compareActive: boolean;
}

export function useWebGLRenderer({
  canvas, adjustments, document: photoDoc, activeLayerId, viewSelectedRange, customHslSectors,
  softProofEnabled, softProofProfile, compareActive,
}: UseWebGLRendererParams) {
  const preCurveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const preCurveIdleRef = useRef<number>(0);
  const [preCurveCanvas, setPreCurveCanvas] = useState<HTMLCanvasElement | null>(null);
  const [preCurveGen, setPreCurveGen] = useState(0);
  const [beforeCanvas, setBeforeCanvas] = useState<HTMLCanvasElement | null>(null);
  const [beforeGen, setBeforeGen] = useState(0);
  const beforeSourceGenRef = useRef(0);
  const {
    pipeline,
    glCanvasRef,
    glCanvasEl,
    glImageLoaded,
    loadedPhotoId,
    sourceLoadGen,
    useWebGL,
    setUseWebGL,
    setNativeImgDims,
    setImgDims,
    setRenderGen,
  } = canvas;
  // Coalescing: every effect-fire bumps the generation; in-flight renders
  // drop their result if a newer gen is already pending. Keeps slider drags
  // smooth — only the most recent params reach the canvas.
  const renderGenRef = useRef(0);

  // ─── Render effect ───
  useEffect(() => {
    if (!pipeline.ready || pipeline.error || !glImageLoaded || !useWebGL) return;
    if (!glCanvasRef.current) return;

    const myGen = ++renderGenRef.current;
    let cancelled = false;
    (async () => {
      // Transient HSL overlay state (range visualization).
      // Custom-HSL sectors flow through adjustments.customHslSectors and
      // need no side channel.
      const overlay: RenderOverlay | undefined = viewSelectedRange
        ? {
            viewSelected: viewSelectedRange
              ? {
                  hue: viewSelectedRange.hueCenter,
                  halfWidth: viewSelectedRange.hueHalfWidth + (viewSelectedRange.feather ?? 10) * 0.5,
                  satMin: (viewSelectedRange.satMin ?? 0) / 100,
                  satMax: (viewSelectedRange.satMax ?? 0) / 100,
                }
              : undefined,
          }
        : undefined;

      // Document-based rendering covers everything the flat adjustments
      // cannot: the layer stack, the retouch spots, and — since step 4 of the
      // single-source-of-truth plan — a photo whose truth IS its stored
      // graph. For a graph-led photo the adjustments are the derived side, so
      // rendering them would show the wrong picture.
      const render = pipeline.render;
      const renderDoc = pipeline.renderDoc;
      const documentGraphRequired = needsDocumentGraph(photoDoc);
      const capturedDoc = documentGraphRequired
        ? photoDoc!
        : adjustmentsToDocument(adjustments);
      const bitmap = documentGraphRequired && renderDoc
        ? await renderDoc(photoDoc!, overlay)
        : await render(adjustments, overlay);
      // Stale-render guard: a newer fire already kicked off; drop our result.
      if (cancelled || myGen !== renderGenRef.current) {
        bitmap?.close();
        return;
      }
      if (!bitmap) throw new Error('Engine render returned no image');
      if (bitmap) {
        const canvasEl = glCanvasRef.current!;
        if (canvasEl.width !== bitmap.width || canvasEl.height !== bitmap.height) {
          canvasEl.width = bitmap.width;
          canvasEl.height = bitmap.height;
        }
        setNativeImgDims((prev) =>
          prev.w === bitmap.width && prev.h === bitmap.height ? prev : { w: bitmap.width, h: bitmap.height }
        );
        const ctx = canvasEl.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
          ctx.drawImage(bitmap, 0, 0);
        }
        bitmap.close();
        if (perfLog.has('image-load')) {
          perfLog.mark('image-load', 'render to canvas');
          perfLog.end('image-load');
        }
        setRenderGen((g) => g + 1);
        const cw = canvasEl.clientWidth;
        const ch = canvasEl.clientHeight;
        if (cw > 0 && ch > 0) {
          setImgDims((prev) => (prev.w === cw && prev.h === ch) ? prev : { w: cw, h: ch });
        }

        // Pre-curve snapshot for histogram — deferred to avoid blocking the
        // main render. Resolve the tap from the same document graph that the
        // canvas renders, including graph-led photos and the active layer.
        const renderDocUpTo = pipeline.renderDocUpTo;
        const builderSource = pipeline.getBuilderSource?.();
        if (renderDocUpTo && builderSource) {
          if (preCurveIdleRef.current) cancelIdleCallback(preCurveIdleRef.current);
          const stopNodeId = preCurveStopNodeFor(
            buildDocumentGraph(capturedDoc, builderSource),
            activeLayerId,
          );
          if (!stopNodeId) {
            preCurveCanvasRef.current = null;
            setPreCurveCanvas(null);
            return;
          }
          const capturedOverlay = overlay;
          preCurveIdleRef.current = requestIdleCallback(() => {
            preCurveIdleRef.current = 0;
            void (async () => {
              try {
                const preBitmap = await renderDocUpTo(capturedDoc, stopNodeId, capturedOverlay);
                if (!preBitmap) {
                  if (!cancelled && myGen === renderGenRef.current) {
                    preCurveCanvasRef.current = null;
                    setPreCurveCanvas(null);
                  }
                  return;
                }
                try {
                  if (cancelled || myGen !== renderGenRef.current) return;
                  const pc = preCurveCanvasRef.current ?? document.createElement('canvas');
                  if (pc.width !== preBitmap.width || pc.height !== preBitmap.height) {
                    pc.width = preBitmap.width; pc.height = preBitmap.height;
                  }
                  const pCtx = pc.getContext('2d');
                  if (!pCtx) {
                    preCurveCanvasRef.current = null;
                    setPreCurveCanvas(null);
                    return;
                  }
                  pCtx.clearRect(0, 0, pc.width, pc.height);
                  pCtx.drawImage(preBitmap, 0, 0);
                  preCurveCanvasRef.current = pc;
                  setPreCurveCanvas(pc);
                  setPreCurveGen((generation) => generation + 1);
                } finally {
                  preBitmap.close();
                }
              } catch { /* non-critical */ }
            })();
          });
        }
      }
    })().catch(() => {
      if (!cancelled) setUseWebGL(false);
    });

    return () => {
      cancelled = true;
      if (preCurveIdleRef.current) {
        cancelIdleCallback(preCurveIdleRef.current);
        preCurveIdleRef.current = 0;
      }
    };
  }, [
    pipeline, glCanvasRef, glCanvasEl, glImageLoaded, useWebGL,
    setUseWebGL, setNativeImgDims, setImgDims, setRenderGen,
    adjustments, photoDoc, activeLayerId, viewSelectedRange, customHslSectors, sourceLoadGen,
  ]);

  // The comparison's before surface is an engine render too. In particular,
  // RAW base development and lens correction stay active; only user edits are
  // reset. Cache it for the current photo because slider changes do not alter
  // the before image.
  useEffect(() => {
    if (!compareActive || !pipeline.ready || pipeline.error || !glImageLoaded || !useWebGL) return;
    if (loadedPhotoId === undefined || sourceLoadGen === 0 || beforeSourceGenRef.current === sourceLoadGen) return;
    let cancelled = false;
    void pipeline.render(defaultAdjustments).then((bitmap) => {
      if (cancelled) {
        bitmap?.close();
        return;
      }
      if (!bitmap) throw new Error('Engine before render returned no image');
      try {
        const target = document.createElement('canvas');
        target.width = bitmap.width;
        target.height = bitmap.height;
        const context = target.getContext('2d');
        if (!context) throw new Error('2D canvas unavailable for before render');
        context.drawImage(bitmap, 0, 0);
        beforeSourceGenRef.current = sourceLoadGen;
        setBeforeCanvas(target);
        setBeforeGen((generation) => generation + 1);
      } finally {
        bitmap.close();
      }
    }).catch(() => {
      if (!cancelled) setUseWebGL(false);
    });
    return () => { cancelled = true; };
  }, [compareActive, pipeline, glImageLoaded, loadedPhotoId, sourceLoadGen, useWebGL, setUseWebGL]);

  const proofCss = softProofEnabled ? getProofFilter(softProofProfile) : '';
  const currentBeforeCanvas = loadedPhotoId !== undefined && beforeSourceGenRef.current === sourceLoadGen
    ? beforeCanvas
    : null;

  return {
    proofCss,
    beforeCanvas: currentBeforeCanvas,
    beforeGen,
    preCurveCanvas,
    preCurveGen,
  };
}
