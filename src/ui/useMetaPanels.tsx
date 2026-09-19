import { useMemo } from 'react';
import type { PresetRow } from '../storage/repos';
import type { PresetImportResult } from '../hooks/usePresets';
import type { ExifData } from '../hooks/useExif';
import type { DocLayer, DocLayerType, BlendMode } from '../engine/DocumentModel';
import { useAdjustments } from '../contexts/AdjustmentsContext';
import { useEditor } from '../contexts/EditorContext';
import { useSettings } from '../contexts/SettingsContext';
import { Histogram } from '../components/Histogram';
import { MetadataPanel } from '../components/MetadataPanel';
import { PresetsPanel } from '../components/PresetsPanel';
import { usePresetThumbnails } from '../hooks/usePresetThumbnails';
import { HistoryPanel } from '../components/HistoryPanel';
import { LayerPanel } from '../components/LayerPanel';
import { Navigator } from '../components/Navigator';
import { LoupeView } from './LoupeView';

export interface MetaPanelProps {
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
  // RAW
}

/**
 * Panels: histogram, navigator, presets, history, layers, metadata, raw
 */
export function useMetaPanels(props: MetaPanelProps): Map<string, React.ReactNode> {
  const { adjustments, onChange, history, restoreToIndex } = useAdjustments();
  const { displayUrl, rawPixels, rawBaseAdjustments, rawLensProfile, glCanvasEl, renderGen, zoom, panX, panY, fitScale, displayImgW, displayImgH, handleOneToOne, onPanChange, setZoom, setPanX, setPanY } = useEditor();
  const { histogramStyle } = useSettings();
  const {
    exif,
    shadowClipping, highlightClipping, onToggleShadowClipping, onToggleHighlightClipping,
    presets, onApplyPreset, activePresetSyncId, presetStrength, onPresetStrengthChange,
    onSavePreset, onDeletePreset, onExportPreset, onImportPreset,
    layers, activeLayerId, onSelectLayer, onAddLayer, onDeleteLayer, onDuplicateLayer,
    onToggleLayerVisibility, onToggleLayerLock, onLayerOpacityChange, onLayerBlendModeChange,
    onReorderLayers, onRenameLayer,
    onAddMask, onRemoveMask,
  } = props;

  const presetThumbnails = usePresetThumbnails(
    displayUrl,
    presets ?? [],
    rawPixels ? { pixels: rawPixels, baseAdjustments: rawBaseAdjustments, lensProfile: rawLensProfile } : null,
  );

  return useMemo(() => {
    const map = new Map<string, React.ReactNode>();

    // Navigator
    if (displayUrl && onPanChange) {
      map.set('navigator', (
        <Navigator
          imageUrl={displayUrl}
          zoom={zoom}
          panX={panX}
          panY={panY}
          fitScale={fitScale}
          displayW={displayImgW}
          displayH={displayImgH}
          onZoomChange={(z) => { setZoom(z); if (z <= 1) { setPanX(0); setPanY(0); } }}
          onPanChange={onPanChange}
          onOneToOne={handleOneToOne}
          renderedCanvas={glCanvasEl}
          renderGeneration={renderGen}
        />
      ));
    }

    // Loupe - reads the rendered canvas straight from the editor context, so
    // it needs nothing drilled in and works for RAW, HEIF and JPEG alike.
    map.set('loupe', <LoupeView source={glCanvasEl} renderGeneration={renderGen} />);

    // Presets
    if (presets && onApplyPreset && onSavePreset && onDeletePreset) {
      map.set('presets', (
        <PresetsPanel
          presets={presets}
          onApply={onApplyPreset}
          onSave={onSavePreset}
          onDelete={onDeletePreset}
          onExport={onExportPreset ?? (() => {})}
          onImport={onImportPreset ?? (() => {})}
          imageUrl={displayUrl}
          presetThumbnails={presetThumbnails}
          activePresetSyncId={activePresetSyncId}
          presetStrength={presetStrength}
          onStrengthChange={onPresetStrengthChange}
        />
      ));
    }

    // History
    if (history && history.length > 0) {
      map.set('history', (
        <HistoryPanel history={history} currentAdjustments={adjustments} onRestore={onChange} onRestoreToIndex={restoreToIndex} />
      ));
    }

    // Layers
    if (layers && onSelectLayer && onAddLayer && onDeleteLayer && onDuplicateLayer &&
        onToggleLayerVisibility && onToggleLayerLock && onLayerOpacityChange &&
        onLayerBlendModeChange && onReorderLayers && onRenameLayer) {
      map.set('layers', (
        <LayerPanel
          layers={layers}
          activeLayerId={activeLayerId ?? null}
          onSelectLayer={onSelectLayer}
          onAddLayer={onAddLayer}
          onDeleteLayer={onDeleteLayer}
          onDuplicateLayer={onDuplicateLayer}
          onToggleVisibility={onToggleLayerVisibility}
          onToggleLock={onToggleLayerLock}
          onOpacityChange={onLayerOpacityChange}
          onBlendModeChange={onLayerBlendModeChange}
          onReorderLayers={onReorderLayers}
          onRenameLayer={onRenameLayer}
          onAddMask={onAddMask}
          onRemoveMask={onRemoveMask}
        />
      ));
    }

    // Histogram
    map.set('histogram', (
      <Histogram
        imageUrl={displayUrl ?? null}
        renderedCanvas={glCanvasEl}
        renderGeneration={renderGen}
        shadowClipping={shadowClipping}
        highlightClipping={highlightClipping}
        histogramStyle={histogramStyle}
        onToggleShadowClipping={onToggleShadowClipping}
        onToggleHighlightClipping={onToggleHighlightClipping}
      />
    ));

    // Metadata
    if (exif !== undefined) {
      map.set('metadata', <MetadataPanel exif={exif ?? null} />);
    }

    return map;
  }, [
    adjustments, onChange, history, restoreToIndex,
    displayUrl, glCanvasEl, renderGen, zoom, panX, panY, fitScale,
    displayImgW, displayImgH, handleOneToOne, onPanChange, setZoom, setPanX, setPanY,
    histogramStyle,
    exif, shadowClipping, highlightClipping, onToggleShadowClipping, onToggleHighlightClipping,
    presets, onApplyPreset, activePresetSyncId, presetStrength, onPresetStrengthChange,
    onSavePreset, onDeletePreset, onExportPreset, onImportPreset,
    presetThumbnails,
    layers, activeLayerId, onSelectLayer, onAddLayer, onDeleteLayer, onDuplicateLayer,
    onToggleLayerVisibility, onToggleLayerLock, onLayerOpacityChange, onLayerBlendModeChange,
    onReorderLayers, onRenameLayer, onAddMask, onRemoveMask,
  ]);
}
