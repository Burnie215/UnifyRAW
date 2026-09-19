import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { baseAdjustmentsFor, developProfileRevision } from '../engine/developProfileStore';
import { lensCoefficientsFor, lensProfileRevision } from '../engine/lensProfileStore';
import type { Adjustments } from '../types';
import type { PhotoView, PresetRow } from '../storage/repos';
import type { PresetImportResult } from '../hooks/usePresets';
import { isMeasurableName } from '../data/rawPairing';
import { useExif } from '../hooks/useExif';
import type { CompareMode } from './BeforeAfter';
import { CropOverlay } from './CropOverlay';
import { CropTool, type CropRect } from './CropTool';
import { RetouchTool } from './RetouchTool';
import { MaskOverlay } from './MaskOverlay';
import { EditorToolbar } from './EditorToolbar';
import { EditorPanelWrapper } from './EditorPanelWrapper';
import { ClippingOverlay } from './ClippingOverlay';
import { EditorRenderFailure } from './EditorRenderFailure';
import { EditorCompareOverlay, EditorImageStage, EditorModeSurface } from './EditorCompareOverlay';
import { type MaskType, createMask } from '../engine/Mask';
import { useRawImage } from '../hooks/useRawImage';
import { useThumbnail } from '../hooks/useThumbnail';
import { RawDecoder } from '../engine/RawDecoder';
import { HeifDecoder, heifDecoder, getHeifMode } from '../engine/HeifDecoder';
import type { RawPixelData } from '../engine/raw/RawDecoderStrategy';
import { prefetchManager, SMART_PREVIEW_SIZES, getSmartPreviewSize } from '../engine/raw';
import { makeRawCacheKey } from '../engine/raw/cacheKey';
import { localRawPrefetchManager } from '../engine/raw/LocalRawPrefetchManager';
import { isLocalRawSourceType } from '../engine/raw/sourcePolicy';
import { sourceManager } from '../sources';
import type { ProofProfile } from '../image/proofFilter';
import { StatusBar } from '../ui/StatusBar';
import { EditorDisplayControls } from '../ui/EditorDisplayControls';
import { useEditorCanvas } from '../hooks/useEditorCanvas';
import { perfLog } from '../platform/perfLog';
import { editorHistoryShortcut } from './editorHistoryShortcut';
import { revokeBlobUrls } from '../platform/objectUrls';
import { normalizeRotation, straightenRotation } from '../image/straighten';
import { useCropController } from '../hooks/useCropController';
import { useRetouchController } from '../hooks/useRetouchController';
import { useMaskTool } from '../hooks/useMaskTool';
import { layerIdOfMask, masksOfDocument } from '../engine/layerMasks';
import { useDocumentLayers } from '../hooks/useDocumentLayers';
import { documentOwnedFields, splitPanelChange, type DocFinalEffects, type DocumentUpdate, type PhotoDocument } from '../engine/DocumentModel';
import { usePanelAdjustments } from '../hooks/usePanelAdjustments';
import { normalizeCropRect, persistedCropRect } from '../engine/Crop';
import { EditorLoadOverlay, type EditorLoadStep } from './EditorLoadOverlay';
import { EditorDepthNotice } from './EditorDepthNotice';
import { deriveEditorSourceDepth, depthNoticeFor } from '../engine/raw/depthFallback';
import { useWebGLRenderer } from '../hooks/useWebGLRenderer';
import { editorIsSupported, editorUnsupportedMessage, buildDefaultGraph, buildLayeredGraph, graphMatchesLayers, syncDefaultNodeParams, syncLayeredNodeParams, withDocumentRetouch, withDocumentCrop, cropFromGraph, hydrateGraph, serializeGraph, isGraphLed, documentAfterGraphEdit, documentAfterReturnToClassic, withStoredLayout, builderBaseForDocument, builderLayersForDocument, maskLayersForDocument, type BlockedNodeGroup } from '../engine/graph';
import { GraphEditor } from './GraphEditor';
import type { PreviewMaskLayer } from '../hooks/usePreviewTapRenderer';
import type { RenderGraph, BuilderLayer, BuilderSourceSpec } from '../engine/graph';
import type { EditorTool } from '../ui/ToolStrip';
import { AdjustmentsProvider } from '../contexts/AdjustmentsContext';
import { EditorProvider, type EditorContextValue } from '../contexts/EditorContext';
import { useSourceContext } from '../contexts/SourceContext';
import {
  createHeifMatchReferenceResource,
  type HeifMatchReferenceResource,
} from './heifMatchReference';
import './PhotoEditor.css';

interface PhotoEditorProps {
  photo: PhotoView;
  /** The RAW/JPEG sibling of `photo`, when the library found one. */
  pairPartner?: PhotoView | null;
  onSwitchPairPartner?: (photo: PhotoView) => void;
  adjustments: Adjustments;
  photoDocument: PhotoDocument;
  onDocumentChange: (next: DocumentUpdate) => void;
  onAdjustmentsChange: (adjustments: Adjustments) => void;
  onBack: () => void;
  saving: boolean;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  history?: Adjustments[];
  restoreToIndex?: (index: number) => void;
  presets?: PresetRow[];
  onApplyPreset?: (preset: PresetRow, strength: number) => void;
  activePresetSyncId?: string | null;
  presetStrength?: number;
  onPresetStrengthChange?: (strength: number) => void;
  onSavePreset?: (name: string, category?: string, groups?: string[]) => void;
  onDeletePreset?: (id: number) => void;
  onExportPreset?: (preset: PresetRow) => void;
  onImportPreset?: (contents: string, fileName?: string) => PresetImportResult | void;
  onExport?: () => void;
  photos?: PhotoView[];
  onSelectPhoto?: (photo: PhotoView) => void;
  /** Called when the full-res file is loaded — used to compute contentHash without re-reading */
  onFileLoaded?: (photo: PhotoView, file: File) => void;
  /**
   * The encoded precision this open actually measured. Opening a photo is the
   * one moment a remote HEIF is on this device without a bulk download, so it
   * is also where a catalog row that no scan could probe gets corrected.
   * 0 means the file was read and reported no plausible depth.
   */
  onSourceBitsMeasured?: (photo: PhotoView, bits: number) => void;
}

const EMPTY_LAYER_ADJUSTMENTS: Partial<Adjustments> = {};

export function PhotoEditor({
  photo, pairPartner, onSwitchPairPartner,
  adjustments, photoDocument, onDocumentChange, onAdjustmentsChange, onBack, saving,
  canUndo, canRedo, onUndo, onRedo,
  history, restoreToIndex,
  presets, onApplyPreset, activePresetSyncId, presetStrength, onPresetStrengthChange,
  onSavePreset, onDeletePreset, onExportPreset, onImportPreset,
  onExport,
  photos: filmstripPhotos,
  onSelectPhoto,
  onFileLoaded,
  onSourceBitsMeasured,
}: PhotoEditorProps) {
  const { t } = useTranslation();
  // ─── Contexts ───
  const { getDisplayUrl, getFile } = useSourceContext();

  // ─── Local state ───
  const [displayUrl, setDisplayUrl] = useState<string | null>(null);
  const [displayBlob, setDisplayBlob] = useState<Blob | null>(null);
  /** Scene-linear 16-bit HEIF pixels, when that mode is on and the decode worked. */
  const [heifPixels, setHeifPixels] = useState<RawPixelData | null>(null);
  /** This photo is a HEIF (by name or by sniffing the bytes). */
  const [isHeifSource, setIsHeifSource] = useState(false);
  /** Photo the 8-bit fallback notice was closed for. Per photo on purpose -
   *  the condition is real, so the next photo with a fallback says so again. */
  const [dismissedDepthNoteFor, setDismissedDepthNoteFor] = useState<number | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [compareMode, setCompareMode] = useState<CompareMode>('off');
  // Phase 4: render-mode toggle. 'classic' = legacy tabs; 'graph' = node-editor.
  // The document is the truth in both; what of a graph edit reaches it is
  // decided by `documentAfterGraphEdit`: a projectable change lands as
  // adjustments and layers with the bare layout beside them, a blocking one
  // as the stored graph plus the flag. This state is the VIEW of it.
  const [renderMode, setRenderMode] = useState<'classic' | 'graph'>('classic');
  const [graphResetToken, setGraphResetToken] = useState(0);
  const [pipelineGraph, setPipelineGraph] = useState<RenderGraph | null>(() => {
    return photoDocument?.pipelineGraph ? hydrateGraph(photoDocument.pipelineGraph) : null;
  });
  /** What stands in the way of writing the graph back, from the last edit. */
  const [gateBlocks, setGateBlocks] = useState<BlockedNodeGroup[]>([]);
  /** The document the graph in `pipelineGraph` already depicts: the one this
   *  editor wrote, or the one it built the graph from. Anything else that
   *  arrives came from outside — undo, history panel, copy switch, sync — and
   *  has to be played back into the editor. */
  const depictedDocRef = useRef<PhotoDocument | null>(null);
  const [shadowClipping, setShadowClipping] = useState(false);
  const [highlightClipping, setHighlightClipping] = useState(false);
  const [softProofEnabled, setSoftProofEnabled] = useState(false);
  const [softProofProfile, setSoftProofProfile] = useState<ProofProfile>('srgb');
  const [softProofGamut, setSoftProofGamut] = useState(false);

  // Color picker & WB picker
  const [colorPickerActive, setColorPickerActive] = useState(false);
  const [wbPickerActive, setWbPickerActive] = useState(false);
  const [pickedColor, setPickedColor] = useState<{ h: number; s: number; l: number } | null>(null);
  const [viewSelectedRange, setViewSelectedRange] = useState<{ hueCenter: number; hueHalfWidth: number; feather?: number; satMin?: number; satMax?: number } | null>(null);
  const [customHslSectors, setCustomHslSectors] = useState<{ hueCenter: number; hueHalfWidth: number; feather: number; dH: number; dS: number; dL: number }[]>([]);

  // Editor-level load phase, drives the loading overlay. RAW-specific stages
  // come from useRawImage.stage further below; these capture the wrapping
  // file-fetch and HEIF-decode phases that happen in PhotoEditor itself.
  const [editorLoadPhase, setEditorLoadPhase] = useState<'idle' | 'getFile' | 'heif' | 'rendering' | 'done'>('idle');

  // Auto-upgrade preview resolution when the user actually zooms in past
  // fit — the lower-tier smart preview is grand for sliders, but at >1.5×
  // fit the user is pixel-peeping and the upscaling becomes visible.
  // Sticky for the lifetime of the photo: once we've upgraded, we keep
  // the higher-res preview even if they zoom back out (no point burning
  // GPU cycles toggling back and forth, the bigger texture is already
  // cached). Reset on photo change.
  const ORIGINAL_PREVIEW_SIZE = SMART_PREVIEW_SIZES[SMART_PREVIEW_SIZES.length - 1];
  const [upgradedSize, setUpgradedSize] = useState<number | null>(null);
  const activePreviewSize = upgradedSize ?? getSmartPreviewSize();

  // ─── Composed hooks ───
  // RAW handling is hoisted above useEditorCanvas so its rawPixels can feed
  // the 16-bit upload path directly when available.
  const isRawFile = RawDecoder.isRawFile(photo.name);
  const rawCacheKey = useMemo(
    () => makeRawCacheKey(photo),
    [photo],
  );
  const rawSourceType = sourceManager.get(photo.sourceId)?.type;
  // Server-side fetch hint: when the source provider knows how to be
  // re-fetched without browser-only state (Immich, Lychee, …), the
  // backend can pull the RAW directly and we skip routing 25-50 MB
  // through the user's network on every cold open.
  const fetchHint = useMemo(() => {
    if (!isRawFile) return null;
    const src = sourceManager.get(photo.sourceId);
    return src?.getRemoteFetchHint?.({
      sourcePhotoId: photo.sourcePhotoId, sourceId: photo.sourceId, name: photo.name,
    }) ?? null;
  }, [isRawFile, photo.sourceId, photo.sourcePhotoId, photo.name]);
  const rawPreviewHint = useMemo(() => {
    if (!isRawFile) return null;
    const src = sourceManager.get(photo.sourceId);
    return src?.getRawPreviewHint?.({
      sourcePhotoId: photo.sourcePhotoId, sourceId: photo.sourceId, name: photo.name,
    }) ?? null;
  }, [isRawFile, photo.sourceId, photo.sourcePhotoId, photo.name]);
  // Pass photo.name as filename so useRawImage can run its cache-only fast
  // path even before `file` is fetched — avoids redownloading the source
  // RAW from Immich/Lychee on every re-open.
  const rawImage = useRawImage(isRawFile ? file : null, {
    identity: photo, filename: photo.name, fetchHint, rawPreviewHint, size: activePreviewSize,
    sourceType: rawSourceType,
  });

  // Keep a small window around the current local RAW warm. Work starts only
  // after the current image is ready and runs one-at-a-time during idle time.
  useEffect(() => {
    if (!isRawFile || rawImage.loading || !rawImage.displayUrl || !filmstripPhotos) return;
    if (!isLocalRawSourceType(rawSourceType)) return;
    localRawPrefetchManager.scheduleNeighbors(photo, filmstripPhotos, activePreviewSize, 2);
  }, [isRawFile, rawImage.loading, rawImage.displayUrl, rawSourceType, photo, filmstripPhotos, activePreviewSize]);

  // The camera's base development for this photo. Resolved once here and
  // handed to every surface that renders it - canvas, preset thumbnails,
  // export - so all of them show the same picture.
  // Read during render, not inside the memo: it is what makes the memo notice
  // that a profile was saved. The storage revision that carries the write
  // re-renders this tree anyway, so the new value arrives with it.
  const profileRevision = developProfileRevision();
  const lensRevision = lensProfileRevision();
  const rawLensProfile = useMemo(
    () => lensCoefficientsFor({ lens: photo.lens, focalLength: photo.focalLength }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [photo.lens, photo.focalLength, lensRevision],
  );
  const rawBaseAdjustments = useMemo(
    () => baseAdjustmentsFor({ name: photo.name, camera: photo.camera, iso: photo.iso }),
    // profileRevision is not read inside, which is exactly why it is listed:
    // it is the signal that the answer changed even though the photo did not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [photo.name, photo.camera, photo.iso, profileRevision],
  );
  const canvas = useEditorCanvas(
    displayUrl, displayBlob, rawImage.rawPixels ?? heifPixels, photo.id,
    rawBaseAdjustments, rawLensProfile,
  );
  const glCanvasRef = canvas.glCanvasRef;
  const imageContainerRef = canvas.imgContainerRef;
  const canvasContainerEl = canvas.containerEl;
  const setCanvasZoom = canvas.setZoom;
  const setCanvasPanX = canvas.setPanX;
  const setCanvasPanY = canvas.setPanY;
  const crop = useCropController();
  const retouch = useRetouchController(photoDocument, onDocumentChange);
  const layer = useDocumentLayers(photoDocument, onDocumentChange);
  const setRenderGen = canvas.setRenderGen;
  const setStraightenMode = crop.setStraightenMode;
  const setLayerMask = layer.setLayerMask;

  // Bridge: mask operations write to document layers
  const maskBridge = useMemo(() => ({
    document: photoDocument,
    activeLayer: layer.activeLayer,
    addMaskToActiveLayer: layer.addMaskToActiveLayer,
    setActiveLayerId: layer.setActiveLayerId,
    setLayerMask: layer.setLayerMask,
    updateMaskProperties: layer.updateMaskProperties,
    addBrushStroke: layer.addBrushStroke,
    setGradient: layer.setGradient,
    setRadial: layer.setRadial,
  }), [photoDocument, layer.activeLayer, layer.addMaskToActiveLayer, layer.setActiveLayerId,
       layer.setLayerMask, layer.updateMaskProperties,
       layer.addBrushStroke, layer.setGradient, layer.setRadial]);
  const mask = useMaskTool(maskBridge);
  const handleAIMask = mask.handleAIMask;
  const documentMasks = useMemo(() => masksOfDocument(photoDocument), [photoDocument]);

  /**
   * The mask list's eight quick sliders. They write the adjustments of the
   * layer the mask gates — the same field the regular panels write — so they
   * reach canvas, thumbnail, export and sync alike.
   */
  const setLayerAdjustmentsForMask = layer.setLayerAdjustments;
  const handleMaskLayerAdjustmentChange = useCallback((maskId: string, adj: Partial<Adjustments>) => {
    const layerId = layerIdOfMask(photoDocument, maskId);
    if (layerId) setLayerAdjustmentsForMask(layerId, adj);
  }, [photoDocument, setLayerAdjustmentsForMask]);

  // Sky Replacement state
  const [skyBlob, setSkyBlob] = useState<Blob | null>(photoDocument?.finalEffects?.skyBlob ?? null);
  const [skyOpacity, setSkyOpacity] = useState(photoDocument?.finalEffects?.skyOpacity ?? 1);
  const [skyEdgeFeather, setSkyEdgeFeather] = useState(photoDocument?.finalEffects?.skyEdgeFeather ?? 15);
  const [skyHorizonOffset, setSkyHorizonOffset] = useState(photoDocument?.finalEffects?.skyHorizonOffset ?? 0);
  const [skyFlip, setSkyFlip] = useState(photoDocument?.finalEffects?.skyFlip ?? false);
  const [skyAiLoading, setSkyAiLoading] = useState(false);

  const writeFinalEffects = useCallback((patch: Partial<DocFinalEffects>) => {
    onDocumentChange((prev) => ({ ...prev, finalEffects: { ...prev.finalEffects, ...patch } }));
  }, [onDocumentChange]);

  const handleSkyBlobChange = useCallback((blob: Blob | null) => {
    setSkyBlob(blob);
    writeFinalEffects({ skyBlob: blob ?? undefined });
  }, [writeFinalEffects]);

  const handleDetectSky = useCallback(async () => {
    if (!displayUrl || skyAiLoading) return;
    setSkyAiLoading(true);
    try {
      await handleAIMask(displayUrl, 'sky');
    } catch (e) {
      console.error('Sky detection failed:', e);
    } finally {
      setSkyAiLoading(false);
    }
  }, [displayUrl, skyAiLoading, handleAIMask]);

  // ─── Active layer adjustments routing ───
  // When an adjustment layer is selected, panels show/edit that layer's adjustments.
  // When base layer (or no layer) is selected, panels show the base adjustments.
  const activeLayer = layer.activeLayer;
  const activeLayerId = layer.activeLayerId;
  const setLayerAdjustments = layer.setLayerAdjustments;
  const activeIsAdjLayer = activeLayer?.type === 'adjustment';
  // The panel shows the DOCUMENT's own vignette/grain/geometry even here, not
  // the defaults - a document at vignette 40 used to read 0 and spring back.
  const panelAdjustments = usePanelAdjustments(activeIsAdjLayer, activeLayer, adjustments);
  const handlePanelChange = useCallback((adj: Adjustments) => {
    if (activeIsAdjLayer && activeLayerId) {
      // Document-level fields (transform, finalEffects) MUST NOT reach a
      // layer: if they leak in, LayerCompositor re-applies e.g. flipH on every
      // layer and the image flips once per adjustment layer (regression
      // 2026-05-17). The same set decides what `panelAdjustments` shows from
      // the document, so what the panel displays is what it writes back.
      const excludedFields = documentOwnedFields(activeLayer?.presetSyncId);
      // `adj` is the panel: the layer's per-layer fields plus the document's
      // values for the excluded ones. Handing that whole object to
      // onAdjustmentsChange wrote the layer's values into the base layer, so
      // only the excluded fields the user actually moved go there.
      const { layerDelta, documentAdjustments } = splitPanelChange(adj, adjustments, excludedFields);
      setLayerAdjustments(activeLayerId, layerDelta);
      if (documentAdjustments) onAdjustmentsChange(documentAdjustments);
    } else {
      onAdjustmentsChange(adj);
    }
  }, [activeIsAdjLayer, activeLayerId, activeLayer?.presetSyncId, adjustments, setLayerAdjustments, onAdjustmentsChange]);

  const dragging = useRef(false);
  const lastPointer = useRef({ x: 0, y: 0 });
  const touchPointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchGesture = useRef({
    active: false,
    distance: 0,
    centerX: 0,
    centerY: 0,
  });

  const exif = useExif(file);
  // Thumbnail from the catalog — shown immediately while the full-res
  // decode runs, so the editor never starts on a blank screen.
  const thumbnail = useThumbnail(photo, 'source');

  /** The crop tool edits the full pre-crop picture. A graph-led document keeps
   * the crop in its stored graph, so both document spellings are neutralized
   * for this transient preview; confirm writes one real history entry. */
  const cropEditingDocument = useMemo<PhotoDocument>(() => {
    if (!crop.cropMode) return photoDocument;
    const { crop: _crop, ...transform } = photoDocument.transform;
    if (!isGraphLed(photoDocument)) return { ...photoDocument, transform };
    const graph = withDocumentCrop(hydrateGraph(photoDocument.pipelineGraph!), undefined);
    return { ...photoDocument, transform, pipelineGraph: serializeGraph(graph) };
  }, [crop.cropMode, photoDocument]);

  const activeCrop = useMemo<CropRect>(() => {
    if (isGraphLed(photoDocument)) {
      const graph = pipelineGraph ?? hydrateGraph(photoDocument.pipelineGraph!);
      return normalizeCropRect(cropFromGraph(graph));
    }
    return normalizeCropRect(photoDocument.transform.crop);
  }, [photoDocument, pipelineGraph]);

  // ─── WebGL rendering + CSS filter memos ───
  const renderer = useWebGLRenderer({
    canvas, adjustments, document: cropEditingDocument, activeLayerId, viewSelectedRange, customHslSectors,
    softProofEnabled, softProofProfile, compareActive: compareMode !== 'off',
  });

  // ─── Edit Thumbnail Generation ───
  // Save a thumbnail of the rendered result for the Library grid (debounced).
  // Gated on canvas.loadedPhotoId === photo.id so the snapshot can never be
  // attributed to the wrong photo when async loads or photo switches overlap.
  const editThumbTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (crop.cropMode || !glCanvasRef.current || !canvas.glImageLoaded || canvas.renderGen < 1) return;
    if (!photo.id || canvas.loadedPhotoId !== photo.id) return;

    clearTimeout(editThumbTimerRef.current);
    const photoId = photo.id;
    editThumbTimerRef.current = setTimeout(async () => {
      const canvasEl = glCanvasRef.current;
      if (!canvasEl || canvasEl.width === 0) return;
      try {
        const { saveEditThumbnail } = await import('../hooks/useThumbnail');
        await saveEditThumbnail(photoId, canvasEl);
      } catch { /* non-critical */ }
    }, 2000);

    return () => clearTimeout(editThumbTimerRef.current);
  }, [crop.cropMode, canvas.renderGen, canvas.glImageLoaded, canvas.loadedPhotoId, photo.id, glCanvasRef]);

  // ─── Effects ───

  // Load image — single effect for file, display URL, and blob to avoid redundant disk reads
  const prevBlobUrlRef = useRef<string | null>(null);
  const matchReferenceResourceRef = useRef<HeifMatchReferenceResource | null>(null);
  // The editor remounts per photo (App keys it on photo.id), so the URL each
  // instance last showed is its own to release - JPEG/HEIF blob, display-URL
  // fallback or the RAW preview handed over by useRawImage. Without this a
  // filmstrip walk over 50 photos pinned every one of them until the tab was
  // reloaded (F060).
  useEffect(() => () => {
    revokeBlobUrls([prevBlobUrlRef.current]);
  }, []);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    // Never show the previous image's metadata while the new source file is
    // still being fetched (or when that fetch eventually fails).
    setFile(null);

    // Revoke previous blob URL (from a different photo, not StrictMode re-mount)
    if (prevBlobUrlRef.current && prevBlobUrlRef.current !== displayUrl) {
      URL.revokeObjectURL(prevBlobUrlRef.current);
      prevBlobUrlRef.current = null;
    }

    async function load() {
      if (!perfLog.has('image-load')) {
        perfLog.start('image-load');
        perfLog.mark('image-load', 'load() effect fired (NEW timer)');
      } else {
        perfLog.mark('image-load', 'load() effect fired (existing timer)');
      }

      // Fast path A: Smart Preview is already cached locally.
      // Fast path B: source has a server-side fetch hint → useRawImage
      // tells the backend to pull the RAW itself, skipping the user's
      // network entirely.
      // Both paths are driven by useRawImage's cache-only effect; here we
      // just need to NOT block on getFile. Kick it off in the background
      // for EXIF / RAW-reprocess / contentHash.
      const isRaw = RawDecoder.isRawFile(photo.name);
      const isCached = isRaw && prefetchManager.isCompleted(rawCacheKey);
      const hasFetchHint = isRaw && (fetchHint !== null || rawPreviewHint !== null);
      if (isCached || hasFetchHint) {
        perfLog.mark('image-load', `raw fast-path: cached=${isCached} hint=${hasFetchHint}`);
        setEditorLoadPhase('getFile');
        if (getFile) {
          getFile(photo, controller.signal).then((f) => {
            if (cancelled || !f) return;
            setFile(f);
            if (onFileLoaded) onFileLoaded(photo, f);
          }).catch(() => { /* tolerated; the fast-path display doesn't need it */ });
        }
        return;
      }
      setEditorLoadPhase('getFile');

      if (getFile) {
        try {
          const f = await getFile(photo, controller.signal);
          perfLog.mark('image-load', `getFile (${f ? Math.round(f.size / 1024) + 'KB' : 'null'})`);
          if (cancelled) { perfLog.mark('image-load', 'cancelled'); perfLog.end('image-load'); return; }
          if (f) {
            setFile(f);

            // RAW: don't set a blob URL of the raw bytes — the browser can't
            // decode CR3/NEF/ARW/etc. `useRawImage` runs in parallel and a
            // separate effect (below) picks up its decoded JPEG.
            if (RawDecoder.isRawFile(photo.name)) {
              perfLog.mark('image-load', 'raw — waiting for useRawImage');
              if (onFileLoaded) onFileLoaded(photo, f);
              return;
            }

            // HEIF/HEIC/HIF: browsers can't render these directly. Which way it
            // is decoded is a user setting - see HeifMode. `linear16` also
            // produces 16-bit pixels for the RAW path; a failure there is not
            // fatal, it just leaves the 8-bit blob in place.
            let displayBlob: Blob = f;
            const isHeif = HeifDecoder.isHeifFile(photo.name) || await HeifDecoder.sniffHeif(f);
            if (isHeif && !cancelled) {
              setIsHeifSource(true);
              setEditorLoadPhase('heif');
              const mode = getHeifMode();
              // What this open measured, so a row no scan could probe gets
              // the real number instead of the extension's assumption.
              let measuredBits: number | null = null;
              if (mode === 'linear16') {
                try {
                  const pixels = await heifDecoder.decode16(f, activePreviewSize);
                  if (pixels && !cancelled) {
                    measuredBits = pixels.sourceBits ?? null;
                    setHeifPixels(pixels);
                    perfLog.mark('image-load', `HEIF 16-bit (${pixels.width}x${pixels.height})`);
                  } else if (!pixels) {
                    // decode16 returns null when the C-API has no 16-bit path.
                    // It threw nothing, so only the notice reports this.
                    perfLog.mark('image-load', 'HEIF 16-bit unavailable, staying 8-bit');
                  }
                } catch (e) {
                  console.warn('HEIF 16-bit decode failed, falling back to 8-bit:', e);
                  perfLog.mark('image-load', 'HEIF 16-bit failed');
                }
              }
              try {
                // Always produce the 8-bit blob too: it backs the histogram,
                // before/after and the auto-optimize sampling, and it is the
                // fallback whenever the 16-bit decode did not deliver.
                displayBlob = mode === 'jpeg'
                  ? await heifDecoder.decode(f)
                  : await heifDecoder.decodeLossless(f);
                perfLog.mark('image-load', `HEIF decoded ${mode} (${Math.round(displayBlob.size / 1024)}KB)`);
              } catch (e) {
                console.error('HEIF decode failed:', e);
                perfLog.mark('image-load', 'HEIF decode failed');
              }
              if (photo.sourceBits == null && !cancelled) {
                // The other two modes never decode 16-bit, so they pay for one
                // container parse; linear16 already carries the answer.
                if (measuredBits == null) measuredBits = await heifDecoder.probeSourceBits(f);
                // 0, not "report nothing": a null would send the next open
                // through the same fruitless read.
                if (!cancelled) onSourceBitsMeasured?.(photo, measuredBits ?? 0);
              }
            }
            if (cancelled) { perfLog.end('image-load'); return; }

            setDisplayBlob(displayBlob);
            const blobUrl = URL.createObjectURL(displayBlob);
            if (prevBlobUrlRef.current && prevBlobUrlRef.current !== blobUrl) {
              URL.revokeObjectURL(prevBlobUrlRef.current);
            }
            prevBlobUrlRef.current = blobUrl;
            setDisplayUrl(blobUrl);
            setEditorLoadPhase('rendering');
            perfLog.mark('image-load', 'displayUrl set');
            // Notify parent so it can compute contentHash with this file (no re-read)
            if (onFileLoaded) onFileLoaded(photo, f);
            return;
          }
        } catch { /* */ }
      }

      try {
        const u = await getDisplayUrl(photo);
        perfLog.mark('image-load', 'getDisplayUrl');
        if (cancelled) { if (u?.startsWith('blob:')) URL.revokeObjectURL(u); return; }
        if (u) {
          if (prevBlobUrlRef.current) URL.revokeObjectURL(prevBlobUrlRef.current);
          if (u.startsWith('blob:')) prevBlobUrlRef.current = u;
          setDisplayUrl(u);
          setDisplayBlob(null);
          setEditorLoadPhase('rendering');
          return;
        }
      } catch { /* */ }

      perfLog.mark('image-load', 'all sources failed');
      perfLog.end('image-load');
    }
    load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchHint changes with photo; rawCacheKey derived from photo
  }, [photo, getDisplayUrl, getFile]);

  // Reset load phase whenever the photo changes. load() effect will pick
  // it back up to 'getFile' (or skip straight to background mode on a RAW
  // cache hit). The overlay is gated on this phase + the canvas-side
  // signal `loadedPhotoId === photo.id` (set by useEditorCanvas after the
  // WebGL upload succeeds for THIS specific photo).
  useEffect(() => {
    setEditorLoadPhase('idle');
    setUpgradedSize(null); // reset auto-upgrade for the new photo
    setHeifPixels(null);
    setIsHeifSource(false);
  }, [photo.id]);

  // Auto-trigger original-size preview decode when the user zooms in past
  // ~1.5× fit (any further past that wastes upscaling artifacts on screen).
  // Only fires for RAW because non-RAW already decodes at native resolution.
  // Latched so we don't oscillate when the user pans/zooms back and forth.
  useEffect(() => {
    if (!isRawFile) return;
    if (upgradedSize !== null) return;
    if (canvas.zoom >= 1.5) {
      setUpgradedSize(ORIGINAL_PREVIEW_SIZE);
    }
  }, [isRawFile, upgradedSize, canvas.zoom, ORIGINAL_PREVIEW_SIZE]);

  // Hide overlay once useEditorCanvas confirms the WebGL pipeline has
  // accepted the bitmap/raw-pixels for the *current* photo. Comparing
  // loadedPhotoId === photo.id is robust to renderGen being reset to 0
  // on each new photo (which broke the previous renderGen-baseline check
  // and caused the overlay to either never appear or stay forever).
  useEffect(() => {
    if (
      canvas.loadedPhotoId === photo.id
      && editorLoadPhase !== 'idle'
      && editorLoadPhase !== 'done'
    ) {
      setEditorLoadPhase('done');
    }
  }, [canvas.loadedPhotoId, photo.id, editorLoadPhase]);

  // Once useRawImage finishes decoding, push the resulting JPEG blob-URL into
  // the editor's displayUrl so the canvas + previews can actually render it.
  useEffect(() => {
    if (!isRawFile) return;
    if (!rawImage.displayUrl) return;
    if (prevBlobUrlRef.current && prevBlobUrlRef.current !== rawImage.displayUrl) {
      URL.revokeObjectURL(prevBlobUrlRef.current);
    }
    prevBlobUrlRef.current = rawImage.displayUrl;
    setDisplayUrl(rawImage.displayUrl);
    setDisplayBlob(null);
    perfLog.mark('image-load', 'raw displayUrl set');
  }, [isRawFile, rawImage.displayUrl]);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      // `key` is 'Z' while Shift is held, so the two cases cannot be told
      // apart by the letter — redo never fired before this.
      const historyDirection = editorHistoryShortcut(e);
      if (historyDirection) {
        e.preventDefault();
        if (historyDirection === 'redo') onRedo?.(); else onUndo?.();
      }
      else if (e.key === '\\') setCompareMode((prev) => prev === 'off' ? 'split' : 'off');
      else if (e.key === 'o' || e.key === 'O') {
        if (e.shiftKey) crop.cycleSpiral();
        else crop.cycleCropOverlay();
      }
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); setCanvasZoom((z) => Math.min(8, z + 0.5)); }
      else if (e.key === '-') { e.preventDefault(); setCanvasZoom((z) => Math.max(1, z - 0.5)); }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onUndo, onRedo, setCanvasZoom, crop]);

  // Scroll zoom
  useEffect(() => {
    if (!canvasContainerEl) return;
    const handler = (e: WheelEvent) => {
      if (crop.cropMode || retouch.retouchMode || crop.straightenMode) return;
      e.preventDefault();
      setCanvasZoom((z) => Math.max(1, Math.min(8, z - e.deltaY * 0.002)));
    };
    canvasContainerEl.addEventListener('wheel', handler, { passive: false });
    return () => canvasContainerEl.removeEventListener('wheel', handler);
  }, [canvasContainerEl, setCanvasZoom, crop.cropMode, retouch.retouchMode, crop.straightenMode]);

  // ─── Mask/Tool interop ───

  const handleMaskToolSelect = useCallback((tool: MaskType | 'spot-heal' | 'spot-clone' | null) => {
    if (tool === 'spot-heal' || tool === 'spot-clone') {
      retouch.setRetouchMode(tool === 'spot-heal' ? 'heal' : 'clone');
      mask.setMaskTool(tool);
    } else if (tool && tool !== mask.maskTool) {
      mask.addMask(tool);
    } else {
      mask.setMaskTool(null);
      retouch.setRetouchMode(null);
    }
  }, [mask, retouch]);

  // ─── Pointer handlers ───

  // Snapshot the WebGL canvas to a 2D-readable canvas (cached per renderGen)
  const readbackRef = useRef<{ canvas: HTMLCanvasElement; gen: number } | null>(null);
  const getReadbackCanvas = useCallback((): HTMLCanvasElement | null => {
    const src = canvas.glCanvasRef.current;
    if (!src || src.width === 0) {
      const img = canvas.imgContainerRef.current?.querySelector('img.editor-image') as HTMLImageElement | null;
      if (!img) return null;
      const tmp = document.createElement('canvas');
      tmp.width = img.naturalWidth; tmp.height = img.naturalHeight;
      tmp.getContext('2d', { willReadFrequently: true })!.drawImage(img, 0, 0);
      return tmp;
    }
    const gen = canvas.renderGen;
    if (readbackRef.current && readbackRef.current.gen === gen) return readbackRef.current.canvas;
    const tmp = document.createElement('canvas');
    tmp.width = src.width; tmp.height = src.height;
    tmp.getContext('2d', { willReadFrequently: true })!.drawImage(src, 0, 0);
    readbackRef.current = { canvas: tmp, gen };
    return tmp;
  }, [canvas.glCanvasRef, canvas.imgContainerRef, canvas.renderGen]);

  const sampleColorFromCanvas = useCallback((e: React.PointerEvent) => {
    const canvasEl = getReadbackCanvas();
    if (!canvasEl) return;
    const rect = (canvas.glCanvasRef.current ?? canvas.imgContainerRef.current?.querySelector('.editor-image'))?.getBoundingClientRect();
    if (!rect) return;
    const relX = (e.clientX - rect.left) / rect.width;
    const relY = (e.clientY - rect.top) / rect.height;
    const x = Math.round(relX * canvasEl.width), y = Math.round(relY * canvasEl.height);
    if (x < 0 || y < 0 || x >= canvasEl.width || y >= canvasEl.height) return;
    const ctx = canvasEl.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    const pixel = ctx.getImageData(x, y, 1, 1).data;
    const r = pixel[0] / 255, g = pixel[1] / 255, b = pixel[2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const l = (mx + mn) / 2;
    let h = 0, s = 0;
    if (mx !== mn) {
      const d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (mx === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    setPickedColor({ h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) });
  }, [getReadbackCanvas, canvas.glCanvasRef, canvas.imgContainerRef]);

  const sampleWbFromCanvas = useCallback((e: React.PointerEvent) => {
    const canvasEl = getReadbackCanvas();
    if (!canvasEl) return;
    const rect = (canvas.glCanvasRef.current ?? canvas.imgContainerRef.current?.querySelector('.editor-image'))?.getBoundingClientRect();
    if (!rect) return;
    const relX = (e.clientX - rect.left) / rect.width;
    const relY = (e.clientY - rect.top) / rect.height;
    // Sample a 5x5 area around the click for stability
    const cx = Math.round(relX * canvasEl.width), cy = Math.round(relY * canvasEl.height);
    const ctx = canvasEl.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    const radius = 2;
    const x0 = Math.max(0, cx - radius), y0 = Math.max(0, cy - radius);
    const x1 = Math.min(canvasEl.width, cx + radius + 1), y1 = Math.min(canvasEl.height, cy + radius + 1);
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return;
    const pixels = ctx.getImageData(x0, y0, w, h).data;
    let rSum = 0, gSum = 0, bSum = 0, count = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      rSum += pixels[i]; gSum += pixels[i + 1]; bSum += pixels[i + 2]; count++;
    }
    if (count === 0) return;
    const rAvg = rSum / count, gAvg = gSum / count, bAvg = bSum / count;
    // The clicked area should be neutral gray — compute correction to make it neutral
    // Temperature: R vs B deviation from G (warm/cool cast)
    // Tint: G vs average of R+B (green/magenta cast)
    const gray = (rAvg + gAvg + bAvg) / 3;
    const tempCorr = gray > 0 ? -((rAvg - bAvg) / gray) * 50 : 0;
    const tintCorr = gray > 0 ? -((gAvg - (rAvg + bAvg) / 2) / gray) * 40 : 0;
    onAdjustmentsChange({
      ...adjustments,
      temperature: Math.round(Math.max(-100, Math.min(100, tempCorr))),
      tint: Math.round(Math.max(-100, Math.min(100, tintCorr))),
    });
    setWbPickerActive(false);
  }, [getReadbackCanvas, canvas.glCanvasRef, canvas.imgContainerRef, adjustments, onAdjustmentsChange]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (wbPickerActive) { sampleWbFromCanvas(e); return; }
    if (colorPickerActive) { sampleColorFromCanvas(e); return; }
    const canvasGestureEnabled = !mask.maskTool
      && !crop.straightenMode
      && !crop.cropMode
      && !retouch.retouchMode;
    if (e.pointerType === 'touch' && canvasGestureEnabled) {
      touchPointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      if (touchPointers.current.size >= 2) {
        const [first, second] = Array.from(touchPointers.current.values());
        pinchGesture.current = {
          active: true,
          distance: Math.hypot(second.x - first.x, second.y - first.y),
          centerX: (first.x + second.x) / 2,
          centerY: (first.y + second.y) / 2,
        };
        dragging.current = false;
        e.preventDefault();
        return;
      }
    }
    if (mask.maskTool && mask.maskTool !== 'spot-heal' && mask.maskTool !== 'spot-clone') return;
    if (crop.straightenMode) {
      const rect = imageContainerRef.current!.getBoundingClientRect();
      const pos = { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
      crop.setStraightenStart(pos); crop.setStraightenEnd(pos);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    if (crop.cropMode || retouch.retouchMode) return;
    if (canvas.zoom <= 1) return;
    dragging.current = true;
    lastPointer.current = { x: e.clientX, y: e.clientY };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [canvas.zoom, crop, retouch.retouchMode, mask.maskTool, colorPickerActive, wbPickerActive, sampleColorFromCanvas, sampleWbFromCanvas, imageContainerRef]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === 'touch' && touchPointers.current.has(e.pointerId)) {
      touchPointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinchGesture.current.active && touchPointers.current.size >= 2) {
        const [first, second] = Array.from(touchPointers.current.values());
        const distance = Math.hypot(second.x - first.x, second.y - first.y);
        const centerX = (first.x + second.x) / 2;
        const centerY = (first.y + second.y) / 2;
        const previous = pinchGesture.current;
        if (previous.distance > 0 && distance > 0) {
          const scale = distance / previous.distance;
          setCanvasZoom((zoom) => Math.max(1, Math.min(8, zoom * scale)));
          setCanvasPanX((pan) => pan + centerX - previous.centerX);
          setCanvasPanY((pan) => pan + centerY - previous.centerY);
        }
        pinchGesture.current = { active: true, distance, centerX, centerY };
        e.preventDefault();
        return;
      }
    }
    if (crop.straightenMode && crop.straightenStart) {
      const rect = imageContainerRef.current!.getBoundingClientRect();
      crop.setStraightenEnd({ x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height });
      return;
    }
    if (!dragging.current) return;
    const dx = e.clientX - lastPointer.current.x, dy = e.clientY - lastPointer.current.y;
    lastPointer.current = { x: e.clientX, y: e.clientY };
    setCanvasPanX((x) => x + dx); setCanvasPanY((y) => y + dy);
  }, [crop, imageContainerRef, setCanvasZoom, setCanvasPanX, setCanvasPanY]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === 'touch' && touchPointers.current.has(e.pointerId)) {
      const pinchWasActive = pinchGesture.current.active;
      touchPointers.current.delete(e.pointerId);
      if (pinchWasActive) {
        if (touchPointers.current.size === 0) {
          pinchGesture.current = { active: false, distance: 0, centerX: 0, centerY: 0 };
        }
        dragging.current = false;
        return;
      }
    }
    if (crop.straightenMode && crop.straightenStart && crop.straightenEnd) {
      // Back to pixels before measuring: the points are normalized per axis, so
      // the raw deltas carry the container's aspect ratio, not the drawn angle.
      const rect = imageContainerRef.current?.getBoundingClientRect();
      const dxPx = (crop.straightenEnd.x - crop.straightenStart.x) * (rect?.width ?? 0);
      const dyPx = (crop.straightenEnd.y - crop.straightenStart.y) * (rect?.height ?? 0);
      // The line was drawn on the photo as it looks right now, so the result is
      // a correction on top of the rotation already applied - not a new absolute
      // angle, which would undo an existing 90 or 180 degree orientation fix.
      const correction = straightenRotation(dxPx, dyPx);
      if (correction !== null) {
        const rotation = normalizeRotation(adjustments.rotation + correction);
        if (rotation !== adjustments.rotation) {
          onAdjustmentsChange({ ...adjustments, rotation });
          crop.activateRotationCrop();
        }
      }
      crop.resetStraighten();
      return;
    }
    dragging.current = false;
  }, [crop, adjustments, onAdjustmentsChange, imageContainerRef]);

  // ─── Tool derivation ───

  const activeTool: EditorTool = crop.cropMode ? 'crop'
    : retouch.retouchMode === 'heal' ? 'heal'
    : retouch.retouchMode === 'clone' ? 'clone'
    : crop.straightenMode ? 'straighten'
    : mask.maskTool === 'brush' ? 'brush'
    : mask.maskTool === 'linear-gradient' ? 'gradient'
    : mask.maskTool === 'radial-gradient' ? 'radial'
    : 'edit';

  /**
   * The adjustment layers the graph has to depict — the same function the
   * canvas, the thumbnails and the exporter ask, so all four describe one
   * stack. A preset is one of these layers (`applyPresetAsLayer`), not a
   * special case.
   */
  const graphLayers = useMemo<BuilderLayer[]>(
    () => (photoDocument ? builderLayersForDocument(photoDocument) : []),
    [photoDocument],
  );

  /**
   * The mask SHAPES the layered graph's `mask:<layerId>` source nodes need.
   * They live on the document, not in the graph, so every renderer has to be
   * handed them explicitly.
   */
  const previewMaskLayers = useMemo<PreviewMaskLayer[]>(
    () => (photoDocument ? maskLayersForDocument(photoDocument) : []),
    [photoDocument],
  );

  /**
   * The source spec the graph is built from — taken from the canvas pipeline,
   * which owns it, rather than assembled a second time here. It decides the
   * shape of the chain: a RAW file renders as `raw16`, which prepends
   * WhiteBalanceRaw and ColorMatrix and drops the SDR WhiteBalance node, and
   * it carries the camera calibration and the chosen output color space.
   * Hard-coding `imageBitmap` here showed a chain for RAW files that the
   * classic canvas never computes.
   *
   * The fallback only covers "no image loaded yet", where the old hard-coded
   * spec was all there ever was.
   */
  const graphSourceSpec = useCallback((): BuilderSourceSpec => {
    const fromPipeline = canvas.pipeline.getBuilderSource?.();
    if (fromPipeline) return fromPipeline;
    return {
      kind: 'imageBitmap',
      geometry: {
        width: canvas.nativeImgDims.w || 1024,
        height: canvas.nativeImgDims.h || 1024,
        pixelRatio: 1,
      },
    };
  }, [canvas.pipeline, canvas.nativeImgDims.w, canvas.nativeImgDims.h]);

  /**
   * The one write path out of the graph editor.
   *
   * `documentAfterGraphEdit` decides what a change means — projected into the
   * document while the gate is open, stored as a graph when it closes — and
   * answers with the gate's verdict in the same breath, so the button and the
   * document can never disagree about it. A change that says nothing new
   * comes back as the same document object, and the writer takes that as "no
   * write": a re-selected node costs no history entry.
   *
   * The updater runs synchronously, exactly once, inside the document writer
   * (documentWriter.ts:31-38) — that is what makes reading the result out of
   * it safe, and it is not a React state updater.
   *
   * Measured under the perfLog tag `graph-edit`: past ~16 ms per change the
   * live projection would have to become a return-trip-only one (AP08).
   */
  const applyGraphEdit = useCallback((graph: RenderGraph) => {
    const source = graphSourceSpec();
    let blocks: BlockedNodeGroup[] = [];
    perfLog.start('graph-edit');
    onDocumentChange((prev) => {
      const edit = documentAfterGraphEdit(prev, graph, source);
      blocks = edit.blocked;
      depictedDocRef.current = edit.document;
      return edit.document;
    });
    perfLog.mark('graph-edit', 'projected');
    perfLog.end('graph-edit');
    setGateBlocks(blocks);
  }, [graphSourceSpec, onDocumentChange]);

  /** The same verdict without the write, for a graph nobody edited: entering
   *  the graph view, and a graph played back from the document. */
  const gateFor = useCallback((graph: RenderGraph | null): BlockedNodeGroup[] => (
    graph && photoDocument
      ? documentAfterGraphEdit(photoDocument, graph, graphSourceSpec()).blocked
      : []
  ), [photoDocument, graphSourceSpec]);

  /**
   * The graph that depicts the current document — the one place that decides
   * between the three cases, so the mode switch and the play-back effect
   * cannot drift apart.
   *
   *  - graph-led  → the STORED graph, params baked into its nodes.
   *  - `prev` given and its layer stack still matches → `prev` with the
   *    builder-owned params re-synced from the document. Topology and
   *    user-added nodes survive; classic edits made in between show up.
   *  - otherwise → freshly built, wearing the layout the document remembers.
   *    A changed stack is topology, not params.
   */
  const graphForDocument = useCallback((prev: RenderGraph | null): RenderGraph | null => {
    try {
      if (isGraphLed(photoDocument)) return hydrateGraph(photoDocument.pipelineGraph!);
      const builderAdj = builderBaseForDocument(photoDocument);
      const source = graphSourceSpec();
      // The retouch node is not builder-owned: its params come from the
      // document, not from the adjustments, so neither the sync nor the
      // builder puts it there. Without this the graph view is the one surface
      // that does not show the spots the canvas next to it renders.
      if (prev && graphMatchesLayers(prev, graphLayers)) {
        return withDocumentCrop(withDocumentRetouch(graphLayers.length === 0
          ? syncDefaultNodeParams(prev, builderAdj, source)
          : syncLayeredNodeParams(prev, builderAdj, graphLayers, source), photoDocument.retouch), photoDocument.transform.crop);
      }
      return withStoredLayout(
        withDocumentCrop(withDocumentRetouch(graphLayers.length === 0
          ? buildDefaultGraph(builderAdj, source).graph
          : buildLayeredGraph(builderAdj, graphLayers, source).graph, photoDocument.retouch), photoDocument.transform.crop),
        photoDocument,
      );
    } catch (e) {
      console.warn('[PhotoEditor] graph for document failed:', e);
      return prev;
    }
  }, [graphLayers, graphSourceSpec, photoDocument]);

  /**
   * Document → editor. Undo, the history panel, a copy switch and a sync pull
   * all change the document behind the editor's back; without this the graph
   * would keep showing the state they stepped away from.
   *
   * `prev` is deliberately NOT handed in here. A document that is not
   * graph-led says nothing about topology beyond the chain it builds, so
   * syncing params onto the topology in hand would keep the very node an undo
   * just removed — and the next `onChange` would write it straight back.
   */
  useEffect(() => {
    if (renderMode !== 'graph') return;
    if (photoDocument === depictedDocRef.current) return;
    const next = graphForDocument(null);
    if (!next) return;
    depictedDocRef.current = photoDocument;
    setPipelineGraph(next);
    setGateBlocks(gateFor(next));
  }, [renderMode, photoDocument, graphForDocument, gateFor]);

  /**
   * A graph-led photo opens in the graph (plan AP08, decision 3): its sliders
   * are the derived side and do not move the picture, and the classic view
   * showing them would only raise the question why. Once, on the first
   * document that says so — walking back to classic must stick.
   */
  const openedInGraphRef = useRef(false);
  useEffect(() => {
    if (openedInGraphRef.current) return;
    if (!isGraphLed(photoDocument)) return;
    openedInGraphRef.current = true;
    setRenderMode('graph');
  }, [photoDocument]);

  /**
   * Switching to the graph needs a graph: on the first switch one is built from
   * the current adjustments, so the nodes mirror the classic edits instead of
   * starting at identity. Without it the view falls back to classic and only
   * the right panel disappears.
   *
   * With adjustment layers it is the layered graph — base chain, one branch
   * per layer straight off the source, and a compositor cascade carrying
   * opacity, blend mode and mask. Without layers it stays the flat chain,
   * byte for byte what it was before.
   *
   * On every later switch the builder-owned params are re-synced from the
   * adjustments (`graphForDocument`): an existing graph was built from
   * whatever the sliders said back then, so classic edits made in between
   * would otherwise never show up in the graph view — it kept rendering the
   * older state, which reads as "the graph output is wrong/darker".
   */
  const handleRenderModeChange = useCallback((mode: 'classic' | 'graph') => {
    if (mode === 'classic') {
      // The button is disabled in this state; the guard is here as well so a
      // keyboard path or a stale render cannot walk past the gate.
      if (gateBlocks.length > 0) return;
      // The classic view owns the truth again. The edits themselves are
      // already in the document — every change went through the projection —
      // so all this settles is the flag and the layout.
      const source = graphSourceSpec();
      onDocumentChange((prev) => {
        const back = documentAfterReturnToClassic(prev, pipelineGraph, source);
        const changed = back.pipelineMode !== prev.pipelineMode
          || back.pipelineGraph !== prev.pipelineGraph
          || back.graphLayout !== prev.graphLayout;
        if (changed) depictedDocRef.current = back;
        return changed ? back : prev;
      });
      setGateBlocks([]);
    }
    if (mode === 'graph') {
      // Entering the graph changes nothing about the document, so this asks
      // the gate for its verdict without writing.
      const next = graphForDocument(pipelineGraph);
      if (next) {
        // This graph depicts the document as it stands, so the play-back
        // effect has nothing to do for it — without this note it would
        // rebuild and throw the re-synced arrangement away.
        depictedDocRef.current = photoDocument;
        setPipelineGraph(next);
        setGateBlocks(gateFor(next));
      }
    }
    setRenderMode(mode);
  }, [graphSourceSpec, gateBlocks, pipelineGraph, photoDocument, onDocumentChange, graphForDocument, gateFor]);

  /** Rebuilds the default pipeline from the current adjustments. The way out of
   *  a graph that was wired into an invalid state. Rebuilds the layer stack
   *  too — a reset that dropped the layers would hand back a graph that shows
   *  less than the document holds. */
  const handleGraphReset = useCallback(() => {
    try {
      const builderAdj = builderBaseForDocument(photoDocument);
      const source = graphSourceSpec();
      const { graph: built } = graphLayers.length > 0
        ? buildLayeredGraph(builderAdj, graphLayers, source)
        : buildDefaultGraph(builderAdj, source);
      const graph = withDocumentCrop(withDocumentRetouch(built, photoDocument.retouch), photoDocument.transform.crop);
      setPipelineGraph(graph);
      setGraphResetToken((token) => token + 1);
      applyGraphEdit(graph);
    } catch (e) {
      console.warn('[PhotoEditor] graph reset failed:', e);
    }
  }, [photoDocument, graphLayers, graphSourceSpec, applyGraphEdit]);

  const handleCropConfirm = useCallback((rect: CropRect) => {
    const nextCrop = persistedCropRect(rect);
    if (isGraphLed(photoDocument)) {
      const currentGraph = pipelineGraph ?? hydrateGraph(photoDocument.pipelineGraph!);
      const graph = withDocumentCrop(currentGraph, nextCrop);
      setPipelineGraph(graph);
      applyGraphEdit(graph);
    } else {
      onDocumentChange((prev) => {
        const previous = persistedCropRect(prev.transform.crop);
        if (JSON.stringify(previous) === JSON.stringify(nextCrop)) return prev;
        const transform = { ...prev.transform };
        if (nextCrop) transform.crop = nextCrop;
        else delete transform.crop;
        return { ...prev, transform };
      });
    }
    crop.setCropMode(false);
  }, [applyGraphEdit, crop, onDocumentChange, photoDocument, pipelineGraph]);

  const handleToolChange = useCallback((tool: EditorTool) => {
    crop.setCropMode(false); retouch.setRetouchMode(null); crop.setStraightenMode(false); mask.setMaskTool(null);
    switch (tool) {
      case 'crop': crop.setCropMode(true); break;
      case 'heal': retouch.setRetouchMode('heal'); break;
      case 'clone': retouch.setRetouchMode('clone'); break;
      case 'straighten': crop.setStraightenMode(true); break;
      case 'brush': handleMaskToolSelect('brush'); break;
      case 'gradient': handleMaskToolSelect('linear-gradient'); break;
      case 'radial': handleMaskToolSelect('radial-gradient'); break;
    }
  }, [crop, retouch, mask, handleMaskToolSelect]);

  const handlePanChange = useCallback((x: number, y: number) => {
    setCanvasPanX(x);
    setCanvasPanY(y);
  }, [setCanvasPanX, setCanvasPanY]);

  // ─── Context values ───

  // The Auto button's second half optimizes the RAW towards its camera JPEG.
  // Rides on the existing RAW+JPEG pairing; only offered when the sibling is a
  // format we can measure, and resolved lazily so opening a RAW never fetches
  // the sibling on spec. A HIF/HEIC sibling (Fuji, iPhone) goes through the
  // same decoder the editor uses for the main image — the browser cannot read
  // those pixels on its own.
  const matchReference = useMemo(() => {
    if (!isRawFile || !pairPartner || !isMeasurableName(pairPartner.name)) return null;
    const partner = pairPartner;
    const needsDecode = HeifDecoder.isHeifFile(partner.name);
    if (!needsDecode) {
      return {
        name: partner.name,
        resolveUrl: () => getDisplayUrl(partner),
      };
    }
    // Decoding needs the original bytes; a source that cannot hand them over
    // has no measurable reference, so the button stays undivided.
    if (!getFile) return null;
    return {
      name: partner.name,
      resolveUrl: () => {
        matchReferenceResourceRef.current ??= createHeifMatchReferenceResource(partner, {
          getFile: (candidate, signal) => getFile(candidate, signal),
          decode: (candidate) => heifDecoder.decode(candidate),
          createObjectUrl: (blob) => URL.createObjectURL(blob),
          revokeObjectUrl: (url) => URL.revokeObjectURL(url),
        });
        return matchReferenceResourceRef.current.reference.resolveUrl();
      },
    };
  }, [isRawFile, pairPartner, getDisplayUrl, getFile]);
  useEffect(() => () => {
    matchReferenceResourceRef.current?.dispose();
    matchReferenceResourceRef.current = null;
  }, [matchReference]);

  const editorContextValue = useMemo<EditorContextValue>(() => ({
    zoom: canvas.zoom, panX: canvas.panX, panY: canvas.panY,
    setZoom: canvas.setZoom, setPanX: canvas.setPanX, setPanY: canvas.setPanY,
    fitScale: canvas.fitScale, containerDims: canvas.containerDims,
    nativeImgDims: canvas.nativeImgDims, imgDims: canvas.imgDims,
    displayImgW: canvas.nativeImgDims.w * canvas.fitScale,
    displayImgH: canvas.nativeImgDims.h * canvas.fitScale,
    renderGen: canvas.renderGen, glCanvasEl: canvas.glCanvasEl,
    preCurveCanvas: renderer.preCurveCanvas,
    preCurveGen: renderer.preCurveGen,
    displayUrl,
    isRaw: isRawFile,
    matchReference,
    // Whatever the canvas renders from, so the auto modes analyse the same
    // pixels the sliders will act on — HEIF included.
    rawPixels: rawImage.rawPixels ?? heifPixels,
    rawBaseAdjustments,
    rawLensProfile,
    activeTool, onToolChange: handleToolChange,
    handleOneToOne: canvas.handleOneToOne, onPanChange: handlePanChange,
  }), [canvas.zoom, canvas.panX, canvas.panY, canvas.setZoom, canvas.setPanX, canvas.setPanY,
       canvas.fitScale, canvas.containerDims, canvas.nativeImgDims, canvas.imgDims,
       canvas.renderGen, canvas.glCanvasEl, renderer.preCurveCanvas, renderer.preCurveGen, canvas.handleOneToOne,
       displayUrl, isRawFile, matchReference, rawImage.rawPixels, heifPixels, rawBaseAdjustments, rawLensProfile,
       activeTool, handleToolChange, handlePanChange]);

  // ─── Panel content props ───

  const handleToggleShadowClipping = useCallback(() => {
    setShadowClipping((enabled) => !enabled);
  }, []);
  const handleToggleHighlightClipping = useCallback(() => {
    setHighlightClipping((enabled) => !enabled);
  }, []);
  const handleRequestRender = useCallback(() => {
    setRenderGen((generation) => generation + 1);
  }, [setRenderGen]);
  const handleActivateStraighten = useCallback(() => {
    setStraightenMode((active) => !active);
  }, [setStraightenMode]);
  const handleSkyOpacityChange = useCallback((value: number) => {
    setSkyOpacity(value);
    writeFinalEffects({ skyOpacity: value });
  }, [writeFinalEffects]);
  const handleSkyEdgeFeatherChange = useCallback((value: number) => {
    setSkyEdgeFeather(value);
    writeFinalEffects({ skyEdgeFeather: value });
  }, [writeFinalEffects]);
  const handleSkyHorizonOffsetChange = useCallback((value: number) => {
    setSkyHorizonOffset(value);
    writeFinalEffects({ skyHorizonOffset: value });
  }, [writeFinalEffects]);
  const handleSkyFlipChange = useCallback((value: boolean) => {
    setSkyFlip(value);
    writeFinalEffects({ skyFlip: value });
  }, [writeFinalEffects]);
  const handleSoftProofToggle = useCallback(() => {
    setSoftProofEnabled((enabled) => !enabled);
  }, []);
  const handleSoftProofGamutWarningToggle = useCallback(() => {
    setSoftProofGamut((enabled) => !enabled);
  }, []);
  const handleAddMask = useCallback((layerId: string, type: MaskType) => {
    setLayerMask(layerId, createMask(type));
  }, [setLayerMask]);

  const panelContentProps = useMemo(() => ({
    exif,
    shadowClipping, highlightClipping,
    onToggleShadowClipping: handleToggleShadowClipping,
    onToggleHighlightClipping: handleToggleHighlightClipping,
    presets, onApplyPreset, activePresetSyncId, presetStrength, onPresetStrengthChange,
    onSavePreset, onDeletePreset, onExportPreset, onImportPreset,
    masks: documentMasks, spots: retouch.retouchSpots, activeMaskId: mask.activeMaskId,
    onSelectMask: mask.selectMask, onDeleteMask: mask.deleteMask,
    onToggleMaskVisibility: mask.toggleMaskVisibility,
    maskLayerAdjustments: layer.activeLayer?.adjustments ?? EMPTY_LAYER_ADJUSTMENTS,
    onMaskLayerAdjustmentChange: handleMaskLayerAdjustmentChange,
    onMaskPropertyChange: mask.updateMaskProperties,
    onDeleteSpot: retouch.deleteSpot,
    setCleanPreview: canvas.pipeline.setCleanPreview,
    clearCleanPreview: canvas.pipeline.clearCleanPreview,
    hasCleanPreview: canvas.pipeline.hasCleanPreview,
    cleanPreviewSupported: canvas.pipeline.cleanPreviewSupported,
    onRequestRender: handleRequestRender,
    onActivateStraighten: handleActivateStraighten,
    straightenActive: crop.straightenMode,
    skyBlob, skyOpacity, skyEdgeFeather, skyHorizonOffset, skyFlip,
    onSkyBlobChange: handleSkyBlobChange,
    onSkyOpacityChange: handleSkyOpacityChange,
    onSkyEdgeFeatherChange: handleSkyEdgeFeatherChange,
    onSkyHorizonOffsetChange: handleSkyHorizonOffsetChange,
    onSkyFlipChange: handleSkyFlipChange,
    onDetectSky: handleDetectSky, skyAiLoading,
    softProofEnabled, softProofProfile, softProofGamutWarning: softProofGamut,
    onSoftProofToggle: handleSoftProofToggle,
    onSoftProofProfileChange: setSoftProofProfile,
    onSoftProofGamutWarningToggle: handleSoftProofGamutWarningToggle,
    layers: layer.layers, activeLayerId: layer.activeLayerId,
    onSelectLayer: layer.setActiveLayerId, onAddLayer: layer.addLayer,
    onDeleteLayer: layer.deleteLayer, onDuplicateLayer: layer.duplicateLayer,
    onToggleLayerVisibility: layer.toggleVisibility, onToggleLayerLock: layer.toggleLock,
    onLayerOpacityChange: layer.setOpacity, onLayerBlendModeChange: layer.setBlendMode,
    onReorderLayers: layer.reorderLayers, onRenameLayer: layer.renameLayer,
    onAddMask: handleAddMask,
    onRemoveMask: layer.removeLayerMask,
    colorPickerActive, onColorPickerRequest: setColorPickerActive, pickedColor,
    wbPickerActive, onWbPickerRequest: setWbPickerActive,
    onViewSelectedRange: setViewSelectedRange, onCustomSectorsUpdate: setCustomHslSectors,
  }), [exif, shadowClipping, highlightClipping, handleToggleShadowClipping,
       handleToggleHighlightClipping, presets, onApplyPreset, activePresetSyncId,
       presetStrength, onPresetStrengthChange, onSavePreset, onDeletePreset,
       onExportPreset, onImportPreset, documentMasks, retouch.retouchSpots,
       mask.activeMaskId, mask.selectMask, mask.deleteMask, mask.toggleMaskVisibility,
       layer.activeLayer?.adjustments, handleMaskLayerAdjustmentChange,
       mask.updateMaskProperties, retouch.deleteSpot, canvas.pipeline.setCleanPreview,
       canvas.pipeline.clearCleanPreview, canvas.pipeline.hasCleanPreview,
       canvas.pipeline.cleanPreviewSupported, handleRequestRender,
       handleActivateStraighten, crop.straightenMode,
       skyBlob, skyOpacity, skyEdgeFeather, skyHorizonOffset, skyFlip, skyAiLoading,
       handleSkyBlobChange, handleSkyOpacityChange, handleSkyEdgeFeatherChange,
       handleSkyHorizonOffsetChange, handleSkyFlipChange, handleDetectSky,
       softProofEnabled, softProofProfile, softProofGamut, handleSoftProofToggle,
       handleSoftProofGamutWarningToggle, layer.layers, layer.activeLayerId,
       layer.setActiveLayerId, layer.addLayer, layer.deleteLayer, layer.duplicateLayer,
       layer.toggleVisibility, layer.toggleLock, layer.setOpacity, layer.setBlendMode,
       layer.reorderLayers, layer.renameLayer, handleAddMask, layer.removeLayerMask,
       colorPickerActive, pickedColor, wbPickerActive]);

  // ─── Loading overlay step ───
  // Visibility gate: show the overlay any time the WebGL pipeline hasn't
  // yet accepted the bitmap for the current photo. Phase + RAW stage drive
  // the label so the user sees where in the pipeline we are.
  const loadStep: EditorLoadStep | null = useMemo(() => {
    if (canvas.loadedPhotoId === photo.id) return null; // image is ready
    const isHeif = HeifDecoder.isHeifFile(photo.name);
    if (isRawFile) {
      const stages = ['Datei laden', 'Cache prüfen', 'RAW aufbereiten', 'TIFF dekodieren', 'Vorschau bauen', 'Rendern'];
      let idx = 1; // default: still in 'Datei laden'
      const stageKind = rawImage.stage?.kind;
      if (stageKind === 'cache-check') idx = 2;
      else if (stageKind === 'fetch') idx = 3;
      else if (stageKind === 'decode') idx = 4;
      else if (stageKind === 'preview') idx = 5;
      else if (editorLoadPhase === 'rendering' || stageKind === 'done') idx = 6;
      const reportedLabel = stageKind && stageKind !== 'done' ? rawImage.stage?.label : null;
      const reportedNext = rawImage.stage && 'next' in rawImage.stage ? rawImage.stage.next : null;
      return {
        index: idx,
        total: stages.length,
        label: reportedLabel ?? stages[idx - 1],
        next: reportedNext ?? (idx < stages.length ? stages[idx] : null),
      };
    }
    if (isHeif) {
      const stages = ['Datei laden', 'HEIF dekodieren', 'Rendern'];
      const idx = editorLoadPhase === 'heif' ? 2 : editorLoadPhase === 'rendering' ? 3 : 1;
      return { index: idx, total: stages.length, label: stages[idx - 1], next: idx < stages.length ? stages[idx] : null };
    }
    const stages = ['Datei laden', 'Rendern'];
    const idx = editorLoadPhase === 'rendering' ? 2 : 1;
    return { index: idx, total: stages.length, label: stages[idx - 1], next: idx < stages.length ? stages[idx] : null };
  }, [canvas.loadedPhotoId, photo.id, editorLoadPhase, isRawFile, photo.name, rawImage.stage]);

  // ─── 8-bit fallback notice (F039) ───
  // What the editor is really editing. `null` until the pixels are on the
  // canvas: before that there is no fact to report.
  const sourceDepth = useMemo(() => deriveEditorSourceDepth({
    isRaw: isRawFile,
    rawBits: rawImage.bits,
    rawSource: rawImage.decodeSource,
    isHeif: isHeifSource,
    heifMode: getHeifMode(),
    heifPixels16: heifPixels !== null,
    loaded: !rawImage.loading && canvas.loadedPhotoId === photo.id,
  }), [
    isRawFile, rawImage.bits, rawImage.decodeSource, rawImage.loading,
    isHeifSource, heifPixels, canvas.loadedPhotoId, photo.id,
  ]);
  const depthFallback = depthNoticeFor(sourceDepth, photo.id, dismissedDepthNoteFor);

  // ─── Render ───

  // Phase 1.D: WebGL2 + half-float gate. Without both the worker can't
  // run the HDR pipeline and the editor can't render. Bail with a clear
  // message instead of mounting into a broken state.
  if (!editorIsSupported()) {
    return (
      <div className="editor-unsupported" style={{
        padding: 32, maxWidth: 600, margin: '64px auto', textAlign: 'center',
      }}>
        <h2>Editor nicht verfügbar</h2>
        <p>{editorUnsupportedMessage()}</p>
        <button onClick={onBack}>Zurück zur Bibliothek</button>
      </div>
    );
  }

  return (
    <AdjustmentsProvider adjustments={panelAdjustments} onChange={handlePanelChange}
      canUndo={canUndo} canRedo={canRedo} onUndo={onUndo} onRedo={onRedo} history={history} restoreToIndex={restoreToIndex}
      activeLayerName={activeIsAdjLayer ? layer.activeLayer?.name ?? null : null}>
    <EditorProvider value={editorContextValue}>
    <EditorPanelWrapper
      panelContentProps={panelContentProps}
      toolbar={
        <EditorToolbar
          photoName={photo.name} onBack={onBack} onExport={onExport} saving={saving}
          pairPartner={pairPartner ?? null}
          onSwitchPairPartner={onSwitchPairPartner}
          compareMode={compareMode} onCompareModeChange={setCompareMode}
          maskTool={mask.maskTool} masksExist={documentMasks.length > 0}
          onMaskToolSelect={handleMaskToolSelect}
          brushRadius={mask.brushRadius} brushFeather={mask.brushFeather}
          brushFlow={mask.brushFlow} brushErase={mask.brushErase}
          onBrushRadiusChange={mask.setBrushRadius} onBrushFeatherChange={mask.setBrushFeather}
          onBrushFlowChange={mask.setBrushFlow} onBrushEraseToggle={() => mask.setBrushErase(!mask.brushErase)}
          showMaskOverlay={mask.showMaskOverlay}
          onToggleMaskOverlay={() => mask.setShowMaskOverlay(!mask.showMaskOverlay)}
          onAIMask={(type) => mask.handleAIMask(displayUrl, type)} aiLoading={mask.aiLoading}
          activeLayerName={activeIsAdjLayer ? layer.activeLayer?.name : undefined}
          zoom={canvas.zoom} fitScale={canvas.fitScale}
          onZoomChange={canvas.setZoom}
          onPanReset={() => { canvas.setPanX(0); canvas.setPanY(0); }}
          renderMode={renderMode}
          onRenderModeChange={handleRenderModeChange}
        />
      }
      activeTool={activeTool} photo={photo} exif={exif} onBack={onBack}
      filmstripPhotos={filmstripPhotos} onSelectPhoto={onSelectPhoto}
      statusBar={(
        <StatusBar
          exif={exif} fileName={photo.name} zoom={canvas.fitScale * canvas.zoom} photo={photo}
          displayControls={(
            <EditorDisplayControls
              compareMode={compareMode} onCompareModeChange={setCompareMode}
              zoom={canvas.zoom} onZoomChange={canvas.setZoom}
              onPanReset={() => { canvas.setPanX(0); canvas.setPanY(0); }}
              renderMode={renderMode} onRenderModeChange={handleRenderModeChange}
              classicBlockedCount={gateBlocks.length}
              classicBlockedReason={gateBlocks[0]?.reasons[0]}
            />
          )}
        />
      )}
      hideRightZone={renderMode === 'graph'}
    >
      {/* Outside the mode switch below on purpose: the notice states what the
          editor is really editing, which is as true of the node editor as of
          the canvas. Anchored in .ps-canvas, the box .editor-image-container
          fills, so it keeps the position it had while it lived inside it.
          Graph-led photos open straight into the graph (AP08), so a notice
          only the classic surface shows is a notice most RAWs never get. */}
      {depthFallback && (
        <EditorDepthNotice fallback={depthFallback} onDismiss={() => setDismissedDepthNoteFor(photo.id)} />
      )}
      <EditorModeSurface
        renderMode={renderMode}
        compareMode={compareMode}
        graphAvailable={!!pipelineGraph}
        cropActive={crop.cropMode}
        graphEditor={pipelineGraph ? <GraphEditor
          // Remount on reset: the editor clones the graph on mount, so a new
          // one only reaches it through a fresh instance.
          key={graphResetToken}
          graph={pipelineGraph}
          previewSourceUrl={displayUrl}
          // Whatever the canvas renders from, so the previews show the
          // document's own pixels - HEIF included.
          previewRawPixels={rawImage.rawPixels ?? heifPixels}
          previewMaskLayers={previewMaskLayers}
          onReset={handleGraphReset}
          blocked={gateBlocks}
          onChange={(g) => {
            setPipelineGraph(g);
            applyGraphEdit(g);
          }}
        /> : null}
      >
      <div
        className={`editor-image-container ${crop.straightenMode ? 'straighten-cursor' : ''}`}
        ref={canvas.containerRefCb}
        onPointerDown={handlePointerDown} onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp}
        style={{ cursor: wbPickerActive || colorPickerActive ? 'crosshair' : crop.straightenMode ? 'crosshair' : canvas.zoom > 1 ? 'grab' : 'default' }}
      >
        {exif && (
          <div className="exif-overlay">
            <div className="exif-overlay-name">{photo.name}</div>
            <div className="exif-overlay-line">
              {exif.exposureTime && `${exif.exposureTime}s`}
              {exif.fNumber && ` bei f/${exif.fNumber}`}
              {exif.iso && `, ISO ${exif.iso}`}
            </div>
            {exif.focalLength && <div className="exif-overlay-line">{exif.focalLength}mm</div>}
          </div>
        )}

        {displayUrl ? (
          <EditorImageStage
            width={canvas.nativeImgDims.w || undefined}
            height={canvas.nativeImgDims.h || undefined}
            transform={canvas.transform}
            compare={compareMode !== 'off' && canvas.useWebGL && canvas.glImageLoaded && renderer.beforeCanvas ? (
              <EditorCompareOverlay
                before={renderer.beforeCanvas}
                after={canvas.glCanvasEl}
                beforeGeneration={renderer.beforeGen}
                renderGeneration={canvas.renderGen}
                proofFilter={renderer.proofCss}
                mode={compareMode}
                onModeChange={setCompareMode}
                zoom={canvas.zoom}
                displayWidth={canvas.nativeImgDims.w * canvas.fitScale * canvas.zoom}
                displayHeight={canvas.nativeImgDims.h * canvas.fitScale * canvas.zoom}
                panX={canvas.panX}
                panY={canvas.panY}
              />
            ) : null}
          >
              <canvas
                ref={canvas.canvasRefCb}
                className="editor-image"
                data-editor-render="current"
                style={{
                  width: canvas.nativeImgDims.w || undefined,
                  height: canvas.nativeImgDims.h || undefined,
                  filter: renderer.proofCss,
                  visibility: !canvas.useWebGL || canvas.pipeline.error ? 'hidden' : undefined,
                }}
              />
              {!canvas.glImageLoaded && canvas.useWebGL && !canvas.pipeline.error && (
                <img src={displayUrl} alt="" className="editor-image editor-image-preview"
                  style={{ width: canvas.nativeImgDims.w || '100%', height: canvas.nativeImgDims.h || '100%' }} />
              )}
              {(!canvas.useWebGL || !!canvas.pipeline.error) && (
                <EditorRenderFailure
                  imageUrl={displayUrl}
                  imageName={photo.name}
                  width={canvas.nativeImgDims.w || undefined}
                  height={canvas.nativeImgDims.h || undefined}
                  onRetry={canvas.retryRender}
                  onImageLoad={(image) => {
                    canvas.setNativeImgDims((previous) => previous.w === image.naturalWidth && previous.h === image.naturalHeight
                      ? previous
                      : { w: image.naturalWidth, h: image.naturalHeight });
                    canvas.setImgDims({ w: image.clientWidth, h: image.clientHeight });
                  }}
                />
              )}
              {(shadowClipping || highlightClipping) && canvas.useWebGL && canvas.glImageLoaded && (
                <ClippingOverlay source={canvas.glCanvasEl} renderGeneration={canvas.renderGen}
                  showShadows={shadowClipping} showHighlights={highlightClipping} />
              )}
              {crop.cropOverlay !== 'none' && canvas.imgDims.w > 0 && (
                <CropOverlay type={crop.cropOverlay} width={canvas.imgDims.w} height={canvas.imgDims.h} spiralRotation={crop.spiralRot} />
              )}
              {crop.cropMode && canvas.imgDims.w > 0 && (
                <CropTool imageWidth={canvas.imgDims.w} imageHeight={canvas.imgDims.h} aspect={adjustments.cropAspect}
                  initialCrop={activeCrop}
                  onCropChange={() => {}} onCropConfirm={handleCropConfirm} onCancel={() => crop.setCropMode(false)}
                  rotation={adjustments.rotation}
                  actionsContainer={canvasContainerEl}
                  onRotationChange={renderMode === 'classic'
                    ? (v) => onAdjustmentsChange({ ...adjustments, rotation: v })
                    : undefined} />
              )}
              <RetouchTool active={retouch.retouchMode !== null} mode={retouch.retouchMode ?? 'heal'}
                spots={retouch.retouchSpots} brushRadius={retouch.retouchRadius}
                onBrushRadiusChange={retouch.setRetouchRadius}
                onSpotAdd={retouch.addSpot} onSpotDelete={retouch.deleteSpot}
                imageWidth={canvas.imgDims.w} imageHeight={canvas.imgDims.h} />
              {(mask.showMaskOverlay || mask.maskTool) && canvas.imgDims.w > 0 && (
                <MaskOverlay
                  mask={mask.activeMask}
                  spotRemovals={retouch.retouchSpots} width={canvas.imgDims.w} height={canvas.imgDims.h}
                  visible={mask.showMaskOverlay}
                  activeTool={mask.maskTool === 'spot-heal' || mask.maskTool === 'spot-clone' ? null : mask.maskTool}
                  brushRadius={mask.brushRadius} brushFeather={mask.brushFeather}
                  brushFlow={mask.brushFlow} brushErase={mask.brushErase}
                  onStrokeAdd={(stroke) => mask.addBrushStroke(mask.activeMaskId, stroke)}
                  onGradientChange={(s, e) => mask.setGradient(mask.activeMaskId, s, e)}
                  onRadialChange={(c, rx, ry) => mask.setRadial(mask.activeMaskId, c, rx, ry)}
                  onSpotAdd={retouch.addSpot}
                  activeSpotTool={mask.maskTool === 'spot-heal' || mask.maskTool === 'spot-clone' ? (mask.maskTool === 'spot-heal' ? 'spot-heal' : 'spot-clone') : null}
                />
              )}
          </EditorImageStage>
        ) : thumbnail.url ? (
          <div className="editor-loading-thumb">
            <img src={thumbnail.url} alt={photo.name} className="editor-image" />
            <div className="editor-loading-overlay">{t('editor.loadingImage')}</div>
          </div>
        ) : (
          <div className="editor-loading">{t('editor.loadingImageDots')}</div>
        )}
        {/* Drawn in the container the pointer is measured against, not inside the
            zoomed/panned image wrapper — otherwise the line drifts away from the
            cursor as soon as the view is scaled. */}
        {crop.straightenMode && crop.straightenStart && crop.straightenEnd && (
          <svg className="straighten-line-svg" viewBox="0 0 1 1" preserveAspectRatio="none">
            <line x1={crop.straightenStart.x} y1={crop.straightenStart.y} x2={crop.straightenEnd.x} y2={crop.straightenEnd.y}
              stroke="rgba(74, 158, 255, 0.9)" strokeWidth="0.003" />
            <circle cx={crop.straightenStart.x} cy={crop.straightenStart.y} r="0.008" fill="rgba(74, 158, 255, 0.9)" />
            <circle cx={crop.straightenEnd.x} cy={crop.straightenEnd.y} r="0.008" fill="rgba(74, 158, 255, 0.9)" />
          </svg>
        )}
        <EditorLoadOverlay step={loadStep} />
      </div>
      </EditorModeSurface>
    </EditorPanelWrapper>
    </EditorProvider>
    </AdjustmentsProvider>
  );
}
