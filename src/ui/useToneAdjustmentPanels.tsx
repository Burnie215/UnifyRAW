import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdjustments } from '../contexts/AdjustmentsContext';
import { useEditor } from '../contexts/EditorContext';
import { useSettings } from '../contexts/SettingsContext';
import { CompactSlider as Slider } from './CompactSlider';
import { ToneCurve } from '../components/ToneCurve';
import { SpaceToggle } from '../components/SpaceToggle';
import { LevelsPanel } from '../components/LevelsPanel';
import { LayerBanner } from './LayerBanner';
import { AutoOptimizeButton } from '../components/AutoOptimizeButton';

interface TonePanelProps {
  wbPickerActive?: boolean;
  onWbPickerRequest?: (active: boolean) => void;
}

/**
 * Panels: basic, whitebalance, presence, tonecurve, levels
 */
export function useToneAdjustmentPanels(props?: TonePanelProps): Map<string, React.ReactNode> {
  const { t } = useTranslation();
  const { adjustments, set, onChange } = useAdjustments();
  const { displayUrl, isRaw, matchReference, rawPixels, glCanvasEl, preCurveCanvas, preCurveGen, renderGen } = useEditor();
  const histogramGeneration = preCurveCanvas ? preCurveGen : renderGen;
  const { histogramStyle } = useSettings();

  return useMemo(() => {
    const map = new Map<string, React.ReactNode>();

    // Basic (with Treatment toggle + Auto Optimize)
    map.set('basic', (
      <>
        <LayerBanner />
        <AutoOptimizeButton imageUrl={displayUrl} isRaw={isRaw} adjustments={adjustments} onChange={onChange} matchReference={matchReference} rawPixels={rawPixels} />
        <div className="treatment-toggle">
          <span className="treatment-label">{t('uiShell.toneAdjust.treatment')}</span>
          <div className="treatment-btns">
            <button className={`treatment-btn ${!adjustments.bwEnabled ? 'active' : ''}`}
              onClick={() => set('bwEnabled', false)}>{t('uiShell.toneAdjust.color')}</button>
            <button className={`treatment-btn ${adjustments.bwEnabled ? 'active' : ''}`}
              onClick={() => set('bwEnabled', true)}>{t('uiShell.toneAdjust.bw')}</button>
          </div>
        </div>
        <Slider label={t('panels.raw.exposure')} value={adjustments.exposure} min={-100} max={100} onChange={(v) => set('exposure', v)}
          trackGradient="linear-gradient(to right, #1a1a1a, #f0f0f0)" />
        <Slider label={t('panels.raw.contrast')} value={adjustments.contrast} min={-100} max={100} onChange={(v) => set('contrast', v)}
          trackGradient="linear-gradient(to right, #666, #1a1a1a 45%, #f0f0f0 55%, #666)" />
        <Slider label={t('panels.raw.highlights')} value={adjustments.highlights} min={-100} max={100} onChange={(v) => set('highlights', v)}
          trackGradient="linear-gradient(to right, #555, #f0f0f0)" />
        <Slider label={t('panels.raw.shadows')} value={adjustments.shadows} min={-100} max={100} onChange={(v) => set('shadows', v)}
          trackGradient="linear-gradient(to right, #1a1a1a, #888)" />
        <Slider label={t('panels.raw.whites')} value={adjustments.whites} min={-100} max={100} onChange={(v) => set('whites', v)}
          trackGradient="linear-gradient(to right, #aaa, #ffffff)" />
        <Slider label={t('panels.raw.blacks')} value={adjustments.blacks} min={-100} max={100} onChange={(v) => set('blacks', v)}
          trackGradient="linear-gradient(to right, #000000, #555)" />
      </>
    ));

    // White Balance
    map.set('whitebalance', (
      <>
        {props?.onWbPickerRequest && (
          <button
            className={`wb-picker-btn ${props.wbPickerActive ? 'active' : ''}`}
            onClick={() => props.onWbPickerRequest!(!props.wbPickerActive)}
            title={t('uiShell.toneAdjust.wbPickerTooltip')}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
              <path d="M2 12l3-3M5 9l5-5M10 4l-1.5-1.5M8 3l2-2 3 3-2 2" />
              <circle cx="3" cy="11" r="1" fill="currentColor" />
            </svg>
            {props.wbPickerActive ? t('uiShell.toneAdjust.wbPickerActive') : t('uiShell.toneAdjust.wbPickerIdle')}
          </button>
        )}
        <Slider label={t('panels.raw.temperature')} value={adjustments.temperature} min={-100} max={100} onChange={(v) => set('temperature', v)}
          trackGradient="linear-gradient(to right, #4a90d9, #e8a838)" />
        <Slider label={t('panels.raw.tint')} value={adjustments.tint} min={-100} max={100} onChange={(v) => set('tint', v)}
          trackGradient="linear-gradient(to right, #5cb85c, #d95ca0)" />
      </>
    ));

    // Impact
    map.set('presence', (
      <>
        <Slider label={t('panels.raw.texture')} value={adjustments.texture} min={-100} max={100} onChange={(v) => set('texture', v)}
          trackGradient="linear-gradient(to right, #444, #999)" />
        <Slider label={t('panels.raw.clarity')} value={adjustments.clarity} min={-100} max={100} onChange={(v) => set('clarity', v)}
          trackGradient="linear-gradient(to right, #555, #ccc)" />
        <Slider label={t('panels.raw.dehaze')} value={adjustments.dehaze} min={-100} max={100} onChange={(v) => set('dehaze', v)}
          trackGradient="linear-gradient(to right, rgba(180,200,220,0.4), rgba(80,130,180,0.6))" />
        <Slider label={t('panels.raw.vibrance')} value={adjustments.vibrance} min={-100} max={100} onChange={(v) => set('vibrance', v)}
          trackGradient="linear-gradient(to right, #666, #e67e22)" />
        <Slider label={t('panels.raw.saturation')} value={adjustments.saturation} min={-100} max={100} onChange={(v) => set('saturation', v)}
          trackGradient="linear-gradient(to right, #777, #e74c3c, #e67e22, #f1c40f, #2ecc71, #3498db, #9b59b6)" />
      </>
    ));

    // Tone Curve — uses pre-curve canvas so the histogram isn't affected by its own curve.
    // Phase 3 UI: Linear/Gamma toggle controls the per-pass color-space override.
    map.set('tonecurve', (
      <div>
        <SpaceToggle
          label="Tone Curve"
          value={adjustments.toneCurveSpace}
          onChange={(v) => set('toneCurveSpace', v)}
        />
        <ToneCurve curve={adjustments.toneCurve} onChange={(c) => set('toneCurve', c)} imageUrl={displayUrl}
          renderedCanvas={preCurveCanvas ?? glCanvasEl} renderGeneration={histogramGeneration} histogramStyle={histogramStyle} />
      </div>
    ));

    // Levels — also uses pre-curve canvas (not affected by tone curve)
    map.set('levels', (
      <LevelsPanel levels={adjustments.levels} onChange={(l) => set('levels', l)} imageUrl={displayUrl}
        renderedCanvas={preCurveCanvas ?? glCanvasEl} renderGeneration={histogramGeneration} histogramStyle={histogramStyle} />
    ));

    return map;
  }, [t, adjustments, set, onChange, displayUrl, isRaw, matchReference, rawPixels, glCanvasEl, preCurveCanvas, histogramGeneration, histogramStyle,
      props?.wbPickerActive, props?.onWbPickerRequest]);
}
