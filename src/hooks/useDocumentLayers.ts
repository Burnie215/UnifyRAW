import { useState, useCallback } from 'react';
import type { PhotoDocument, DocLayer, DocLayerType, DocumentUpdate, BlendMode } from '../engine/DocumentModel';
import { createDocLayer } from '../engine/DocumentModel';
import type { MaskDefinition, BrushStroke } from '../engine/Mask';
import { addMaskToDocument } from '../engine/layerMasks';

/**
 * Manages layers and masks directly on the PhotoDocument, which is the only
 * place either of them lives. `useMaskTool` keeps the brush/tool state and
 * writes through here; it holds no mask of its own.
 *
 * All operations write through `setDocument(prev => …)`, which triggers:
 * - Re-rendering (via useWebGLRenderer)
 * - Persistence (via usePhotoEdits debounced DB write)
 * - Undo/redo history (via usePhotoEdits document history)
 */
export function useDocumentLayers(
  document: PhotoDocument,
  setDocument: (next: DocumentUpdate) => void,
) {
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null);

  // ─── Helper: update layers array in document ─────────────────

  const updateLayers = useCallback((updater: (layers: DocLayer[]) => DocLayer[]) => {
    setDocument((prev) => ({ ...prev, layers: updater(prev.layers) }));
  }, [setDocument]);

  const updateLayer = useCallback((id: string, updater: (layer: DocLayer) => DocLayer) => {
    updateLayers((layers) => layers.map((l) => l.id === id ? updater(l) : l));
  }, [updateLayers]);

  // ─── Layer CRUD ──────────────────────────────────────────────

  const addLayer = useCallback((type: DocLayerType) => {
    const layer = createDocLayer(type);
    updateLayers((layers) => [...layers, layer]);
    setActiveLayerId(layer.id);
  }, [updateLayers]);

  const deleteLayer = useCallback((id: string) => {
    // Read, not written: a layer's type never changes, so the rendered layers
    // know the base as well as the newest document does, and the selection
    // below needs the answer outside the write (the delete button is offered
    // for a selected base layer too).
    const layer = document.layers.find((l) => l.id === id);
    if (layer?.type === 'base') return; // Can't delete base layer
    updateLayers((layers) => layers.filter((l) => l.id !== id));
    setActiveLayerId((prev) => prev === id ? null : prev);
  }, [document.layers, updateLayers]);

  const duplicateLayer = useCallback((id: string) => {
    updateLayers((layers) => {
      const idx = layers.findIndex((l) => l.id === id);
      if (idx < 0) return layers;
      const source = layers[idx];
      const dup: DocLayer = {
        ...source,
        id: crypto.randomUUID(),
        name: `${source.name} (Kopie)`,
        mask: source.mask ? { ...source.mask, id: crypto.randomUUID() } : null,
      };
      const next = [...layers];
      next.splice(idx + 1, 0, dup);
      return next;
    });
  }, [updateLayers]);

  const toggleVisibility = useCallback((id: string) => {
    updateLayer(id, (l) => ({ ...l, visible: !l.visible }));
  }, [updateLayer]);

  const toggleLock = useCallback((id: string) => {
    updateLayer(id, (l) => ({ ...l, locked: !l.locked }));
  }, [updateLayer]);

  const setOpacity = useCallback((id: string, opacity: number) => {
    updateLayer(id, (l) => ({ ...l, opacity }));
  }, [updateLayer]);

  const setBlendMode = useCallback((id: string, blendMode: BlendMode) => {
    updateLayer(id, (l) => ({ ...l, blendMode }));
  }, [updateLayer]);

  const reorderLayers = useCallback((from: number, to: number) => {
    updateLayers((layers) => {
      const next = [...layers];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, [updateLayers]);

  const renameLayer = useCallback((id: string, name: string) => {
    updateLayer(id, (l) => ({ ...l, name }));
  }, [updateLayer]);

  // ─── Layer Adjustments ───────────────────────────────────────

  const setLayerAdjustments = useCallback((id: string, adjustments: Partial<import('../types').Adjustments>) => {
    updateLayer(id, (l) => ({ ...l, adjustments }));
  }, [updateLayer]);

  // ─── Mask Operations (per layer) ─────────────────────────────

  const setLayerMask = useCallback((layerId: string, mask: MaskDefinition | null) => {
    updateLayer(layerId, (l) => ({ ...l, mask }));
  }, [updateLayer]);

  /**
   * Put a mask on the active adjustment layer, or on a fresh one, and select
   * the layer that got it. ONE updater, so the id the caller gets back and the
   * layer in the document are the same one: `createDocumentWriter` resolves an
   * updater exactly once and on the spot.
   */
  const addMaskToActiveLayer = useCallback((mask: MaskDefinition): string => {
    let layerId = '';
    setDocument((prev) => {
      const result = addMaskToDocument(prev, activeLayerId, mask);
      layerId = result.layerId;
      return result.document;
    });
    setActiveLayerId(layerId);
    return layerId;
  }, [setDocument, activeLayerId]);

  const removeLayerMask = useCallback((layerId: string) => {
    updateLayer(layerId, (l) => ({ ...l, mask: null }));
  }, [updateLayer]);

  const updateMaskProperties = useCallback((layerId: string, props: Partial<MaskDefinition>) => {
    updateLayer(layerId, (l) => {
      if (!l.mask) return l;
      return { ...l, mask: { ...l.mask, ...props } };
    });
  }, [updateLayer]);

  const addBrushStroke = useCallback((layerId: string, stroke: BrushStroke) => {
    updateLayer(layerId, (l) => {
      if (!l.mask || l.mask.type !== 'brush') return l;
      return { ...l, mask: { ...l.mask, strokes: [...(l.mask.strokes ?? []), stroke] } };
    });
  }, [updateLayer]);

  const setGradient = useCallback((layerId: string, start: { x: number; y: number }, end: { x: number; y: number }) => {
    updateLayer(layerId, (l) => {
      if (!l.mask) return l;
      return { ...l, mask: { ...l.mask, gradientStart: start, gradientEnd: end } };
    });
  }, [updateLayer]);

  const setRadial = useCallback((layerId: string, center: { x: number; y: number }, rx: number, ry: number) => {
    updateLayer(layerId, (l) => {
      if (!l.mask) return l;
      return { ...l, mask: { ...l.mask, center, radiusX: rx, radiusY: ry } };
    });
  }, [updateLayer]);

  // ─── Derived state ───────────────────────────────────────────

  const activeLayer = document.layers.find((l) => l.id === activeLayerId) ?? null;
  const layers = document.layers;

  return {
    // Layer state
    layers,
    activeLayerId,
    activeLayer,
    setActiveLayerId,

    // Layer CRUD
    addLayer,
    deleteLayer,
    duplicateLayer,
    toggleVisibility,
    toggleLock,
    setOpacity,
    setBlendMode,
    reorderLayers,
    renameLayer,
    setLayerAdjustments,

    // Mask operations (per layer)
    addMaskToActiveLayer,
    setLayerMask,
    removeLayerMask,
    updateMaskProperties,
    addBrushStroke,
    setGradient,
    setRadial,
  };
}
