import { useState, useCallback } from 'react';
import { type MaskDefinition, type MaskType, type BrushStroke, createMask } from '../engine/Mask';
import type { DocLayer, PhotoDocument } from '../engine/DocumentModel';
import { layerIdOfMask } from '../engine/layerMasks';
import type { SegmentationType } from '../engine/ai';

interface LayerMaskBridge {
  /** The document the masks live in — the only place they do. */
  document: PhotoDocument;
  /** The layer the panels are editing; its mask is the active one. */
  activeLayer: DocLayer | null;
  /** Put a mask on the active adjustment layer (or a fresh one) and select it. */
  addMaskToActiveLayer: (mask: MaskDefinition) => string;
  setActiveLayerId: (id: string | null) => void;
  /** Set/replace mask on a layer */
  setLayerMask: (layerId: string, mask: MaskDefinition | null) => void;
  /** Update mask properties on a layer */
  updateMaskProperties: (layerId: string, props: Partial<MaskDefinition>) => void;
  /** Add brush stroke to a layer's mask */
  addBrushStroke: (layerId: string, stroke: BrushStroke) => void;
  /** Set gradient on a layer's mask */
  setGradient: (layerId: string, start: { x: number; y: number }, end: { x: number; y: number }) => void;
  /** Set radial on a layer's mask */
  setRadial: (layerId: string, center: { x: number; y: number }, rx: number, ry: number) => void;
}

/**
 * Tool and brush state for masking.
 *
 * The masks themselves are not here: a mask is `DocLayer.mask` of an
 * adjustment layer and nothing else (F001). This hook says which tool is
 * armed and how the brush is set, and routes every mask edit to the layer
 * that owns it — so the canvas, the thumbnail, the export and the sync all
 * see the same mask.
 */
export function useMaskTool(bridge: LayerMaskBridge) {
  const [maskTool, setMaskTool] = useState<MaskType | 'spot-heal' | 'spot-clone' | null>(null);
  const [showMaskOverlay, setShowMaskOverlay] = useState(false);
  const [brushRadius, setBrushRadius] = useState(30);
  const [brushFeather, setBrushFeather] = useState(0.5);
  const [brushFlow, setBrushFlow] = useState(0.8);
  const [brushErase, setBrushErase] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);

  const activeMask = bridge.activeLayer?.mask ?? null;
  const activeMaskId = activeMask?.id ?? null;

  const addMask = useCallback((type: MaskType) => {
    bridge.addMaskToActiveLayer(createMask(type));
    setMaskTool(type);
  }, [bridge]);

  /** Selecting a mask selects its layer, so the panels edit what it gates. */
  const selectMask = useCallback((id: string | null) => {
    bridge.setActiveLayerId(id ? layerIdOfMask(bridge.document, id) : null);
  }, [bridge]);

  const deleteMask = useCallback((id: string) => {
    const layerId = layerIdOfMask(bridge.document, id);
    if (layerId) bridge.setLayerMask(layerId, null);
  }, [bridge]);

  const toggleMaskVisibility = useCallback((id: string) => {
    const layer = bridge.document.layers.find((l) => l.mask?.id === id);
    if (layer?.mask) bridge.updateMaskProperties(layer.id, { visible: !layer.mask.visible });
  }, [bridge]);

  const updateMaskProperties = useCallback((id: string, props: Partial<MaskDefinition>) => {
    const layerId = layerIdOfMask(bridge.document, id);
    if (layerId) bridge.updateMaskProperties(layerId, props);
  }, [bridge]);

  const addBrushStroke = useCallback((maskId: string | null, stroke: BrushStroke) => {
    const layerId = layerIdOfMask(bridge.document, maskId);
    if (layerId) bridge.addBrushStroke(layerId, stroke);
  }, [bridge]);

  const setGradient = useCallback((maskId: string | null, start: { x: number; y: number }, end: { x: number; y: number }) => {
    const layerId = layerIdOfMask(bridge.document, maskId);
    if (layerId) bridge.setGradient(layerId, start, end);
  }, [bridge]);

  const setRadial = useCallback((maskId: string | null, center: { x: number; y: number }, rx: number, ry: number) => {
    const layerId = layerIdOfMask(bridge.document, maskId);
    if (layerId) bridge.setRadial(layerId, center, rx, ry);
  }, [bridge]);

  const handleAIMask = useCallback(async (displayUrl: string | null, type: SegmentationType) => {
    if (!displayUrl || aiLoading) return;
    setAiLoading(true);
    try {
      const { segmentImage } = await import('../engine/ai');
      const result = await segmentImage(displayUrl, type);
      if (result.confidence > 0) {
        const typeLabels: Record<SegmentationType, string> = {
          sky: 'Himmel', person: 'Person', subject: 'Subjekt',
          background: 'Hintergrund', foreground: 'Vordergrund', animal: 'Tier',
        };
        const newMask = createMask('ai-segment', `AI: ${typeLabels[type]}`, {
          alphaMap: result.mask,
          width: result.width,
          height: result.height,
        });
        bridge.addMaskToActiveLayer(newMask);
        setShowMaskOverlay(true);
      }
    } catch (e) {
      console.error('AI mask failed:', e);
    } finally {
      setAiLoading(false);
    }
  }, [aiLoading, bridge]);

  return {
    activeMask, activeMaskId, maskTool, showMaskOverlay,
    brushRadius, brushFeather, brushFlow, brushErase,
    aiLoading,
    selectMask, setMaskTool, setShowMaskOverlay,
    setBrushRadius, setBrushFeather, setBrushFlow, setBrushErase,
    addMask, deleteMask, toggleMaskVisibility,
    updateMaskProperties,
    addBrushStroke, setGradient, setRadial,
    handleAIMask,
  };
}
