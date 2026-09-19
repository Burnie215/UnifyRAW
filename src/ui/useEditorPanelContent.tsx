import { useMemo } from 'react';
import type { Adjustments } from '../types';
import type { ExifData } from '../hooks/useExif';
import type { MaskDefinition, SpotRemoval } from '../engine/Mask';
import type { DocLayer, DocLayerType, BlendMode } from '../engine/DocumentModel';
import type { ProofProfile } from '../image/proofFilter';
import type { PresetRow } from '../storage/repos';
import type { PresetImportResult } from '../hooks/usePresets';

import { useToneAdjustmentPanels } from './useToneAdjustmentPanels';
import { useColorPanels, type ColorPanelProps } from './useColorPanels';
import { useToolPanels, type ToolPanelProps } from './useToolPanels';
import { useMetaPanels, type MetaPanelProps } from './useMetaPanels';

/**
 * Slim props interface — most data now comes from contexts
 * (AdjustmentsContext, EditorContext, SettingsContext).
 * Only panel-specific props that aren't in any context remain here.
 */
export interface EditorPanelContentProps {
  exif?: ExifData | null;
  // Histogram clipping
  shadowClipping?: boolean;
  highlightClipping?: boolean;
  onToggleShadowClipping?: () => void;
  onToggleHighlightClipping?: () => void;
  // Presets
  presets?: PresetRow[];
  onApplyPreset?: (preset: PresetRow, strength: number) => void;
  activePresetSyncId?: string | null;
  presetStrength?: number;
  onPresetStrengthChange?: (strength: number) => void;
  onSavePreset?: (name: string, category?: string, groups?: string[]) => void;
  onDeletePreset?: (id: number) => void;
  onExportPreset?: (preset: PresetRow) => void;
  onImportPreset?: (contents: string, fileName?: string) => PresetImportResult | void;
  // Masks
  masks?: MaskDefinition[];
  spots?: SpotRemoval[];
  activeMaskId?: string | null;
  onSelectMask?: (id: string | null) => void;
  onDeleteMask?: (id: string) => void;
  onToggleMaskVisibility?: (id: string) => void;
  maskLayerAdjustments?: Partial<Adjustments>;
  onMaskLayerAdjustmentChange?: (id: string, adj: Partial<Adjustments>) => void;
  onMaskPropertyChange?: (id: string, props: Partial<MaskDefinition>) => void;
  onDeleteSpot?: (id: string) => void;
  // Soft Proofing
  softProofEnabled?: boolean;
  softProofProfile?: ProofProfile;
  softProofGamutWarning?: boolean;
  onSoftProofToggle?: () => void;
  onSoftProofProfileChange?: (p: ProofProfile) => void;
  onSoftProofGamutWarningToggle?: () => void;
  // Layers
  layers?: DocLayer[];
  activeLayerId?: string | null;
  onSelectLayer?: (id: string | null) => void;
  onAddLayer?: (type: DocLayerType) => void;
  onDeleteLayer?: (id: string) => void;
  onDuplicateLayer?: (id: string) => void;
  onToggleLayerVisibility?: (id: string) => void;
  onToggleLayerLock?: (id: string) => void;
  onLayerOpacityChange?: (id: string, opacity: number) => void;
  onLayerBlendModeChange?: (id: string, mode: BlendMode) => void;
  onReorderLayers?: (from: number, to: number) => void;
  onRenameLayer?: (id: string, name: string) => void;
  onAddMask?: (layerId: string, type: import('../engine/Mask').MaskType) => void;
  onRemoveMask?: (layerId: string) => void;
  // AI Denoise (DENOISE_PLAN Phase 3)
  setCleanPreview?: (data: Float32Array | Uint8Array, w: number, h: number) => void;
  clearCleanPreview?: () => void;
  hasCleanPreview?: () => boolean;
  /** False while the render engine has no AI-denoise mix support. */
  cleanPreviewSupported?: boolean;
  onRequestRender?: () => void;
  // Transform — straighten line-pick mode toggle (mirrors ToolStrip button)
  onActivateStraighten?: () => void;
  straightenActive?: boolean;
  // Sky Replacement
  skyBlob?: Blob | null;
  skyOpacity?: number;
  skyEdgeFeather?: number;
  skyHorizonOffset?: number;
  skyFlip?: boolean;
  onSkyBlobChange?: (blob: Blob | null) => void;
  onSkyOpacityChange?: (v: number) => void;
  onSkyEdgeFeatherChange?: (v: number) => void;
  onSkyHorizonOffsetChange?: (v: number) => void;
  onSkyFlipChange?: (v: boolean) => void;
  onDetectSky?: () => void;
  skyAiLoading?: boolean;
  // Color picker
  colorPickerActive?: boolean;
  onColorPickerRequest?: (active: boolean) => void;
  // WB picker
  wbPickerActive?: boolean;
  onWbPickerRequest?: (active: boolean) => void;
  pickedColor?: { h: number; s: number; l: number } | null;
  onViewSelectedRange?: (range: { hueCenter: number; hueHalfWidth: number; feather?: number } | null) => void;
  onCustomSectorsUpdate?: (sectors: { hueCenter: number; hueHalfWidth: number; feather: number; dH: number; dS: number; dL: number }[]) => void;
}

/**
 * Facade: orchestrates 4 specialized panel hooks.
 * Each sub-hook reads from contexts (AdjustmentsContext, EditorContext, SettingsContext)
 * and only receives panel-specific props that aren't available via context.
 */
export function useEditorPanelContent(props: EditorPanelContentProps): Map<string, React.ReactNode> {
  // 1. Tone panels (basic, whitebalance, presence, tonecurve, levels)
  const tonePanels = useToneAdjustmentPanels({
    wbPickerActive: props.wbPickerActive,
    onWbPickerRequest: props.onWbPickerRequest,
  });

  // 2. Color panels (hsl, colorgrading, bw) — color picker props
  const colorPanels = useColorPanels({
    colorPickerActive: props.colorPickerActive,
    onColorPickerRequest: props.onColorPickerRequest,
    pickedColor: props.pickedColor,
    onViewSelectedRange: props.onViewSelectedRange,
    onCustomSectorsUpdate: props.onCustomSectorsUpdate,
  } satisfies ColorPanelProps);

  // 3. Tool panels (detail, effects, transform, masking, softproof, toolstrip)
  const toolPanels = useToolPanels({
    masks: props.masks,
    spots: props.spots,
    activeMaskId: props.activeMaskId,
    onSelectMask: props.onSelectMask,
    onDeleteMask: props.onDeleteMask,
    onToggleMaskVisibility: props.onToggleMaskVisibility,
    maskLayerAdjustments: props.maskLayerAdjustments,
    onMaskLayerAdjustmentChange: props.onMaskLayerAdjustmentChange,
    onMaskPropertyChange: props.onMaskPropertyChange,
    onDeleteSpot: props.onDeleteSpot,
    setCleanPreview: props.setCleanPreview,
    clearCleanPreview: props.clearCleanPreview,
    hasCleanPreview: props.hasCleanPreview,
    cleanPreviewSupported: props.cleanPreviewSupported,
    onRequestRender: props.onRequestRender,
    onActivateStraighten: props.onActivateStraighten,
    straightenActive: props.straightenActive,
    skyBlob: props.skyBlob,
    skyOpacity: props.skyOpacity,
    skyEdgeFeather: props.skyEdgeFeather,
    skyHorizonOffset: props.skyHorizonOffset,
    skyFlip: props.skyFlip,
    onSkyBlobChange: props.onSkyBlobChange,
    onSkyOpacityChange: props.onSkyOpacityChange,
    onSkyEdgeFeatherChange: props.onSkyEdgeFeatherChange,
    onSkyHorizonOffsetChange: props.onSkyHorizonOffsetChange,
    onSkyFlipChange: props.onSkyFlipChange,
    onDetectSky: props.onDetectSky,
    skyAiLoading: props.skyAiLoading,
    softProofEnabled: props.softProofEnabled,
    softProofProfile: props.softProofProfile,
    softProofGamutWarning: props.softProofGamutWarning,
    onSoftProofToggle: props.onSoftProofToggle,
    onSoftProofProfileChange: props.onSoftProofProfileChange,
    onSoftProofGamutWarningToggle: props.onSoftProofGamutWarningToggle,
  } satisfies ToolPanelProps);

  // 4. Meta panels (histogram, navigator, presets, history, layers, metadata, raw)
  const metaPanels = useMetaPanels({
    exif: props.exif,
    shadowClipping: props.shadowClipping,
    highlightClipping: props.highlightClipping,
    onToggleShadowClipping: props.onToggleShadowClipping,
    onToggleHighlightClipping: props.onToggleHighlightClipping,
    presets: props.presets,
    onApplyPreset: props.onApplyPreset,
    activePresetSyncId: props.activePresetSyncId,
    presetStrength: props.presetStrength,
    onPresetStrengthChange: props.onPresetStrengthChange,
    onSavePreset: props.onSavePreset,
    onDeletePreset: props.onDeletePreset,
    onExportPreset: props.onExportPreset,
    onImportPreset: props.onImportPreset,
    layers: props.layers,
    activeLayerId: props.activeLayerId,
    onSelectLayer: props.onSelectLayer,
    onAddLayer: props.onAddLayer,
    onDeleteLayer: props.onDeleteLayer,
    onDuplicateLayer: props.onDuplicateLayer,
    onToggleLayerVisibility: props.onToggleLayerVisibility,
    onToggleLayerLock: props.onToggleLayerLock,
    onLayerOpacityChange: props.onLayerOpacityChange,
    onLayerBlendModeChange: props.onLayerBlendModeChange,
    onReorderLayers: props.onReorderLayers,
    onRenameLayer: props.onRenameLayer,
    onAddMask: props.onAddMask,
    onRemoveMask: props.onRemoveMask,
  } satisfies MetaPanelProps);

  // Merge all panel maps
  return useMemo(() => {
    const merged = new Map<string, React.ReactNode>();
    for (const [k, v] of tonePanels) merged.set(k, v);
    for (const [k, v] of colorPanels) merged.set(k, v);
    for (const [k, v] of toolPanels) merged.set(k, v);
    for (const [k, v] of metaPanels) merged.set(k, v);
    return merged;
  }, [tonePanels, colorPanels, toolPanels, metaPanels]);
}
