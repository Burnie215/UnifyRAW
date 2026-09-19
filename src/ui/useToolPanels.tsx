import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Adjustments, CropAspect } from '../types';
import type { MaskDefinition, SpotRemoval } from '../engine/Mask';
import type { ProofProfile } from '../image/proofFilter';
import { useAdjustments } from '../contexts/AdjustmentsContext';
import { useEditor } from '../contexts/EditorContext';
import { CompactSlider as Slider } from './CompactSlider';
import { ToolStrip } from './ToolStrip';
import { MaskList } from '../components/MaskList';
import { SoftProofing } from '../components/SoftProofing';
import { SkyReplacementPanel } from '../components/SkyReplacementPanel';
import { AIDenoisePanel } from '../components/AIDenoisePanel';
import './TransformPanel.css';

// Crop aspect options. `label` for 'free' is an i18n key resolved at render time;
// the others are numeric ratios that stay literal.
const cropOptions: { value: CropAspect; label: string; isKey?: boolean }[] = [
  { value: 'free', label: 'uiShell.toolPanels.cropFree', isKey: true },
  { value: '1:1', label: '1:1' },
  { value: '4:3', label: '4:3' },
  { value: '3:2', label: '3:2' },
  { value: '16:9', label: '16:9' },
  { value: '5:4', label: '5:4' },
];

export interface ToolPanelProps {
  // Masking
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
  // AI Denoise (Phase 3 of DENOISE_PLAN)
  setCleanPreview?: (data: Float32Array | Uint8Array, w: number, h: number) => void;
  clearCleanPreview?: () => void;
  hasCleanPreview?: () => boolean;
  /** False while the render engine has no AI-denoise mix support. */
  cleanPreviewSupported?: boolean;
  onRequestRender?: () => void;
  // Transform — activate the click-line "straighten" mode from the panel
  // (mirror of the ToolStrip's straighten button).
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
  // Soft Proofing
  softProofEnabled?: boolean;
  softProofProfile?: ProofProfile;
  softProofGamutWarning?: boolean;
  onSoftProofToggle?: () => void;
  onSoftProofProfileChange?: (p: ProofProfile) => void;
  onSoftProofGamutWarningToggle?: () => void;
}

/**
 * Panels: detail, effects, transform, masking, softproof, toolstrip
 */
export function useToolPanels(props: ToolPanelProps): Map<string, React.ReactNode> {
  const { t } = useTranslation();
  const { adjustments, set } = useAdjustments();
  const { activeTool, onToolChange } = useEditor();
  const {
    masks, spots, activeMaskId, onSelectMask, onDeleteMask,
    onToggleMaskVisibility, maskLayerAdjustments, onMaskLayerAdjustmentChange, onMaskPropertyChange, onDeleteSpot,
    setCleanPreview, clearCleanPreview, hasCleanPreview, cleanPreviewSupported, onRequestRender,
    onActivateStraighten, straightenActive,
    skyBlob, skyOpacity, skyEdgeFeather, skyHorizonOffset, skyFlip,
    onSkyBlobChange, onSkyOpacityChange, onSkyEdgeFeatherChange,
    onSkyHorizonOffsetChange, onSkyFlipChange, onDetectSky, skyAiLoading,
    softProofEnabled, softProofProfile, softProofGamutWarning,
    onSoftProofToggle, onSoftProofProfileChange, onSoftProofGamutWarningToggle,
  } = props;

  return useMemo(() => {
    const map = new Map<string, React.ReactNode>();

    // ToolStrip
    if (onToolChange) {
      map.set('toolstrip', (
        <ToolStrip activeTool={activeTool ?? null} onToolChange={onToolChange} />
      ));
    }

    // Detail
    map.set('detail', (
      <>
        <Slider label={t('uiShell.toolPanels.sharpness')} value={adjustments.sharpness} min={0} max={150} onChange={(v) => set('sharpness', v)} />
        <Slider label={t('uiShell.toolPanels.radius')} value={adjustments.sharpenRadius} min={0.5} max={3} step={0.1} defaultValue={1} onChange={(v) => set('sharpenRadius', v)} />
        <Slider label={t('uiShell.toolPanels.masking')} value={adjustments.sharpenMasking} min={0} max={100} onChange={(v) => set('sharpenMasking', v)} />
        <Slider label={t('uiShell.toolPanels.denoiseLuma')} value={adjustments.denoiseLuma} min={0} max={100} onChange={(v) => set('denoiseLuma', v)} />
        <Slider label={t('uiShell.toolPanels.denoiseChroma')} value={adjustments.denoiseChroma} min={0} max={100} onChange={(v) => set('denoiseChroma', v)} />
        <Slider label={t('uiShell.toolPanels.denoiseDetail')} value={adjustments.denoiseDetail} min={0} max={100} defaultValue={50} onChange={(v) => set('denoiseDetail', v)} />
        <AIDenoisePanel
          setCleanPreview={setCleanPreview}
          clearCleanPreview={clearCleanPreview}
          hasCleanPreview={hasCleanPreview}
          mixSupported={cleanPreviewSupported}
          onRequestRender={onRequestRender}
        />
      </>
    ));

    // Effects
    map.set('effects', (
      <>
        <Slider label={t('uiShell.toolPanels.vignette')} value={adjustments.vignette} min={-100} max={100} onChange={(v) => set('vignette', v)} />
        <Slider label={t('uiShell.toolPanels.vignetteFeather')} value={adjustments.vignetteFeather} min={0} max={100} defaultValue={50} onChange={(v) => set('vignetteFeather', v)} />
        <Slider label={t('uiShell.toolPanels.grain')} value={adjustments.grain} min={0} max={100} onChange={(v) => set('grain', v)} />
        <Slider label={t('uiShell.toolPanels.grainSize')} value={adjustments.grainSize} min={1} max={100} defaultValue={25} onChange={(v) => set('grainSize', v)} />
      </>
    ));

    // Sky Replacement
    if (onSkyBlobChange) {
      map.set('sky', (
        <SkyReplacementPanel
          skyBlob={skyBlob ?? null}
          skyOpacity={skyOpacity ?? 1}
          skyEdgeFeather={skyEdgeFeather ?? 15}
          skyHorizonOffset={skyHorizonOffset ?? 0}
          skyFlip={skyFlip ?? false}
          onSkyBlobChange={onSkyBlobChange}
          onSkyOpacityChange={onSkyOpacityChange ?? (() => {})}
          onSkyEdgeFeatherChange={onSkyEdgeFeatherChange ?? (() => {})}
          onSkyHorizonOffsetChange={onSkyHorizonOffsetChange ?? (() => {})}
          onSkyFlipChange={onSkyFlipChange ?? (() => {})}
          onDetectSky={onDetectSky}
          aiLoading={skyAiLoading}
        />
      ));
    }

    // Transform
    map.set('transform', (
      <>
        {/* 1. Rotation + Straighten */}
        <div className="transform-section">
          <div className="transform-section-title">{t('uiShell.toolPanels.rotation')}</div>
          <Slider label={t('uiShell.toolPanels.angle')} value={adjustments.rotation} min={-45} max={45} step={0.1} onChange={(v) => set('rotation', v)} />
          {onActivateStraighten && (
            <div className="transform-inline-actions">
              <button
                className={`transform-icon-btn ${straightenActive ? 'active' : ''}`}
                onClick={() => onActivateStraighten()}
                title={t('uiShell.toolPanels.straightenHint')}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                  <path d="M2 11l12-6" /><circle cx="2" cy="11" r="1.5" /><circle cx="14" cy="5" r="1.5" />
                </svg>
                {t('uiShell.toolPanels.straighten')}
              </button>
            </div>
          )}
        </div>

        {/* 2. Crop — aspect ratio + flip */}
        <div className="transform-section">
          <div className="transform-section-title">{t('uiShell.toolPanels.cropAspect')}</div>
          <div className="transform-chip-row">
            {cropOptions.map(({ value, label, isKey }) => (
              <button
                key={value}
                className={`transform-chip ${adjustments.cropAspect === value ? 'active' : ''}`}
                onClick={() => set('cropAspect', value)}
              >
                {isKey ? t(label) : label}
              </button>
            ))}
          </div>
          <div className="transform-flip-row">
            <button className={`transform-flip-btn ${adjustments.flipH ? 'active' : ''}`} onClick={() => set('flipH', !adjustments.flipH)}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M7 1v12M3 4l-2 3 2 3M11 4l2 3-2 3" />
              </svg>
              {t('uiShell.toolPanels.horizontal')}
            </button>
            <button className={`transform-flip-btn ${adjustments.flipV ? 'active' : ''}`} onClick={() => set('flipV', !adjustments.flipV)}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M1 7h12M4 3L7 1l3 2M4 11l3 2 3-2" />
              </svg>
              {t('uiShell.toolPanels.vertical')}
            </button>
          </div>
        </div>

        {/* 3. Geometry — perspective + distortion */}
        <div className="transform-section">
          <div className="transform-section-title">{t('uiShell.toolPanels.geometry')}</div>
          <Slider label={t('uiShell.toolPanels.perspectiveV')} value={adjustments.perspectiveV} min={-100} max={100} onChange={(v) => set('perspectiveV', v)} />
          <Slider label={t('uiShell.toolPanels.perspectiveH')} value={adjustments.perspectiveH} min={-100} max={100} onChange={(v) => set('perspectiveH', v)} />
          <Slider label={t('uiShell.toolPanels.distortion')} value={adjustments.distortion} min={-100} max={100} onChange={(v) => set('distortion', v)} />
        </div>
      </>
    ));

    // Masking
    if (masks && onSelectMask && onDeleteMask && onToggleMaskVisibility && onMaskLayerAdjustmentChange && onDeleteSpot) {
      map.set('masking', (
        <MaskList
          masks={masks}
          spots={spots ?? []}
          activeMaskId={activeMaskId ?? null}
          onSelectMask={onSelectMask}
          onDeleteMask={onDeleteMask}
          onToggleMaskVisibility={onToggleMaskVisibility}
          maskLayerAdjustments={maskLayerAdjustments ?? {}}
          onMaskLayerAdjustmentChange={onMaskLayerAdjustmentChange}
          onMaskPropertyChange={onMaskPropertyChange}
          onDeleteSpot={onDeleteSpot}
        />
      ));
    }

    // Soft Proofing
    if (onSoftProofToggle && onSoftProofProfileChange && onSoftProofGamutWarningToggle) {
      map.set('softproof', (
        <SoftProofing
          enabled={softProofEnabled ?? false}
          profile={softProofProfile ?? 'srgb'}
          gamutWarning={softProofGamutWarning ?? false}
          onToggle={onSoftProofToggle}
          onProfileChange={onSoftProofProfileChange}
          onGamutWarningToggle={onSoftProofGamutWarningToggle}
        />
      ));
    }

    return map;
  }, [
    t, adjustments, set, activeTool, onToolChange,
    masks, spots, activeMaskId, onSelectMask, onDeleteMask, onToggleMaskVisibility,
    maskLayerAdjustments, onMaskLayerAdjustmentChange, onMaskPropertyChange, onDeleteSpot,
    setCleanPreview, clearCleanPreview, hasCleanPreview, cleanPreviewSupported, onRequestRender,
    onActivateStraighten, straightenActive,
    skyBlob, skyOpacity, skyEdgeFeather, skyHorizonOffset, skyFlip,
    onSkyBlobChange, onSkyOpacityChange, onSkyEdgeFeatherChange,
    onSkyHorizonOffsetChange, onSkyFlipChange, onDetectSky, skyAiLoading,
    softProofEnabled, softProofProfile, softProofGamutWarning,
    onSoftProofToggle, onSoftProofProfileChange, onSoftProofGamutWarningToggle,
  ]);
}
