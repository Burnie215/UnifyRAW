import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { HSLAdjustments } from '../types';
import {
  type Sector, BASIC, makeSector, getPickAbs, hueDiff,
  buildColorImageData,
} from './hslUtils';
import { HSLWheel } from './HSLWheel';
import { HSLControls, ArcSlider } from './HSLControls';
import './HSLPanel.css';

interface HSLPanelProps {
  hsl: HSLAdjustments;
  onChange: (hsl: HSLAdjustments) => void;
  pickedColor?: { h: number; s: number; l: number } | null;
  onPickerRequest?: (active: boolean) => void;
  pickerActive?: boolean;
  onViewSelectedRange?: (range: { hueCenter: number; hueHalfWidth: number; feather?: number; satMin?: number; satMax?: number } | null) => void;
  onCustomSectorsUpdate?: (sectors: { hueCenter: number; hueHalfWidth: number; feather: number; dH: number; dS: number; dL: number }[]) => void;
  colorEditorMode?: 'basic' | 'advanced' | 'skin-tone';
  onColorEditorModeChange?: (mode: 'basic' | 'advanced' | 'skin-tone') => void;
  advancedSectors?: Sector[];
  onAdvancedSectorsChange?: (sectors: Sector[]) => void;
  skinToneSector?: Sector;
  onSkinToneSectorChange?: (sector: Sector) => void;
  skinToneSectors?: Sector[];
  onSkinToneSectorsChange?: (sectors: Sector[]) => void;
  skinToneUniformity?: { hue: number; saturation: number; luminance: number };
  onSkinToneUniformityChange?: (u: { hue: number; saturation: number; luminance: number }) => void;
}

type Mode = 'basic' | 'advanced' | 'skin-tone';

const EMPTY_SECTORS: Sector[] = [];
const DEFAULT_SKIN_SECTOR = makeSector(25, 20, 40);
const DEFAULT_UNIFORMITY = { hue: 0, saturation: 0, luminance: 0 };

export function HSLPanel({
  hsl, onChange, pickedColor, onPickerRequest, pickerActive,
  onViewSelectedRange, onCustomSectorsUpdate,
  colorEditorMode: propMode, onColorEditorModeChange,
  advancedSectors: propAdvSectors, onAdvancedSectorsChange,
  skinToneSector: propSkinSector, onSkinToneSectorChange,
  skinToneSectors: propSkinSectors, onSkinToneSectorsChange,
  skinToneUniformity: propUniformity, onSkinToneUniformityChange,
}: HSLPanelProps) {
  const { t } = useTranslation();
  // ─── Mode ───
  const [localMode, setLocalMode] = useState<Mode>('basic');
  const mode = propMode ?? localMode;
  const setMode = useCallback((m: Mode) => { setLocalMode(m); onColorEditorModeChange?.(m); }, [onColorEditorModeChange]);

  const [viewSelected, setViewSelected] = useState(false);
  const [basicHW, setBasicHW] = useState(() => BASIC.map((b) => b.hw));
  const [basicFeather, setBasicFeather] = useState(12);
  const [selectedBasicIdx, setSelectedBasicIdx] = useState(0);

  // Advanced — persisted via props
  const advSectors = propAdvSectors ?? EMPTY_SECTORS;
  const setAdvSectors = useCallback((fn: Sector[] | ((prev: Sector[]) => Sector[])) => {
    const next = typeof fn === 'function' ? fn(propAdvSectors ?? []) : fn;
    onAdvancedSectorsChange?.(next);
  }, [propAdvSectors, onAdvancedSectorsChange]);
  const [selectedAdvIdx, setSelectedAdvIdx] = useState(-1);

  // Skin tone — persisted via props
  const skinSector = propSkinSector ?? DEFAULT_SKIN_SECTOR;
  const setSkinSector = useCallback((fn: Sector | ((prev: Sector) => Sector)) => {
    const next = typeof fn === 'function' ? fn(propSkinSector ?? DEFAULT_SKIN_SECTOR) : fn;
    onSkinToneSectorChange?.(next);
  }, [propSkinSector, onSkinToneSectorChange]);
  const skinSectors = propSkinSectors ?? EMPTY_SECTORS;
  const setSkinSectors = useCallback((fn: Sector[] | ((prev: Sector[]) => Sector[])) => {
    const next = typeof fn === 'function' ? fn(propSkinSectors ?? []) : fn;
    onSkinToneSectorsChange?.(next);
  }, [propSkinSectors, onSkinToneSectorsChange]);
  const [selectedSkinIdx, setSelectedSkinIdx] = useState(-1);
  const uniformity = propUniformity ?? DEFAULT_UNIFORMITY;
  const setUniformity = useCallback((fn: typeof uniformity | ((prev: typeof uniformity) => typeof uniformity)) => {
    const next = typeof fn === 'function' ? fn(propUniformity ?? DEFAULT_UNIFORMITY) : fn;
    onSkinToneUniformityChange?.(next);
  }, [propUniformity, onSkinToneUniformityChange]);

  // ─── Handle color picked from image ───
  const processedPickedColorRef = useRef<typeof pickedColor>(null);
  useEffect(() => {
    if (!pickedColor) {
      processedPickedColorRef.current = null;
      return;
    }
    if (processedPickedColorRef.current === pickedColor) return;
    processedPickedColorRef.current = pickedColor;
    const { h, s } = pickedColor;
    if (mode === 'basic') {
      let best = 0, bestD = 999;
      for (let i = 0; i < BASIC.length; i++) {
        const d = Math.abs(hueDiff(h, BASIC[i].hue));
        if (d < bestD) { bestD = d; best = i; }
      }
      setSelectedBasicIdx(best);
    } else if (mode === 'advanced') {
      if (advSectors.length < 24) {
        const ns = makeSector(Math.round(h), 18, Math.round(s));
        setAdvSectors((prev) => [...prev, ns]);
        setSelectedAdvIdx(advSectors.length);
      }
    } else if (mode === 'skin-tone') {
      setSkinSector((prev) => {
        const satMin = Math.max(0, s - 20), satMax = Math.min(100, s + 20);
        return { ...prev, hueCenter: Math.round(h), satMin, satMax, pickRelSat: (s - satMin) / (satMax - satMin) };
      });
    }
    onPickerRequest?.(false);
  }, [pickedColor, mode, advSectors, setAdvSectors, setSkinSector, onPickerRequest]);

  // ─── Build sector list ───
  const allSectors: Sector[] = useMemo(() => {
    if (mode === 'basic') {
      return BASIC.map((b, i) => ({
        id: b.key, hueCenter: b.hue, hueHalfWidth: basicHW[i],
        satMin: 8, satMax: 92, feather: basicFeather,
        pickRelHue: 0.5, pickRelSat: 0.6, selLightness: 0,
        dH: hsl[b.key].hue, dS: hsl[b.key].saturation, dL: hsl[b.key].luminance,
        enabled: true,
      }));
    }
    if (mode === 'advanced') return advSectors;
    return skinSectors.length > 0 ? skinSectors : [skinSector];
  }, [mode, basicHW, basicFeather, hsl, advSectors, skinSector, skinSectors]);

  const selectedIdx = mode === 'basic' ? selectedBasicIdx : mode === 'advanced' ? selectedAdvIdx
    : skinSectors.length > 0 ? selectedSkinIdx : 0;
  const activeSector = selectedIdx >= 0 && selectedIdx < allSectors.length ? allSectors[selectedIdx] : null;

  // ─── ImageData cache ───
  const cachedImageData = useMemo(() => {
    if (!activeSector) return null;
    return buildColorImageData(activeSector);
  }, [activeSector]);

  // ─── Propagation effects ───
  useEffect(() => {
    if (!onViewSelectedRange) return;
    if (!viewSelected || !activeSector) { onViewSelectedRange(null); return; }
    onViewSelectedRange({
      hueCenter: activeSector.hueCenter, hueHalfWidth: activeSector.hueHalfWidth,
      feather: activeSector.feather, satMin: activeSector.satMin, satMax: activeSector.satMax,
    });
  }, [viewSelected, activeSector, onViewSelectedRange]);

  useEffect(() => {
    if (!onCustomSectorsUpdate) return;
    if (mode === 'basic') { onCustomSectorsUpdate([]); return; }
    const skinAll = skinSectors.length > 0 ? skinSectors : [skinSector];
    const sectors = (mode === 'advanced' ? advSectors : skinAll)
      .filter((s) => s.enabled && (s.dH !== 0 || s.dS !== 0 || s.dL !== 0))
      .slice(0, 8)
      .map((s) => ({ hueCenter: s.hueCenter, hueHalfWidth: s.hueHalfWidth, feather: s.feather, dH: s.dH, dS: s.dS, dL: s.dL }));
    onCustomSectorsUpdate(sectors);
  }, [mode, advSectors, skinSector, skinSectors, onCustomSectorsUpdate]);

  // ─── Update sector ───
  const updateSector = useCallback((idx: number, patch: Partial<Sector>) => {
    if (mode === 'basic') {
      if ('hueHalfWidth' in patch) setBasicHW((prev) => prev.map((hw, i) => i === idx ? (patch.hueHalfWidth ?? hw) : hw));
      const key = BASIC[idx]?.key;
      if (key && ('dH' in patch || 'dS' in patch || 'dL' in patch)) {
        const current = hsl[key];
        onChange({ ...hsl, [key]: { hue: patch.dH ?? current.hue, saturation: patch.dS ?? current.saturation, luminance: patch.dL ?? current.luminance } });
      }
    } else if (mode === 'advanced') {
      setAdvSectors((prev) => prev.map((s, i) => i === idx ? { ...s, ...patch } : s));
    } else if (skinSectors.length > 0 && idx >= 0 && idx < skinSectors.length) {
      setSkinSectors((prev) => prev.map((s, i) => i === idx ? { ...s, ...patch } : s));
    } else {
      setSkinSector((prev) => ({ ...prev, ...patch }));
    }
  }, [mode, hsl, onChange, setAdvSectors, setSkinSector, skinSectors, setSkinSectors]);

  // ─── Wheel click ───
  const handleWheelClick = useCallback((hue: number, sat: number) => {
    if (mode === 'basic') {
      let best = 0, bestD = 999;
      for (let i = 0; i < BASIC.length; i++) {
        const d = Math.abs(hueDiff(hue, BASIC[i].hue));
        if (d < bestD) { bestD = d; best = i; }
      }
      setSelectedBasicIdx(best);
    } else if (mode === 'advanced') {
      for (let i = 0; i < advSectors.length; i++) {
        const s = advSectors[i];
        if (Math.abs(hueDiff(hue, s.hueCenter)) < s.hueHalfWidth && sat >= s.satMin && sat <= s.satMax) {
          setSelectedAdvIdx(i); return;
        }
      }
      if (advSectors.length < 24) {
        const ns = makeSector(Math.round(hue), 18, Math.round(sat));
        setAdvSectors((prev) => [...prev, ns]);
        setSelectedAdvIdx(advSectors.length);
      }
    } else {
      setSkinSector((prev) => ({ ...prev, hueCenter: Math.round(hue) }));
    }
  }, [mode, advSectors, setAdvSectors, setSkinSector]);

  // ─── Render ───
  return (
    <div className="ce-panel">
      <div className="ce-tabs seg">
        <button className={`ce-tab seg-btn ${mode === 'basic' ? 'active' : ''}`} onClick={() => setMode('basic')}>{t('adjustments.hsl.modes.basic')}</button>
        <button className={`ce-tab seg-btn ${mode === 'advanced' ? 'active' : ''}`} onClick={() => setMode('advanced')}>{t('adjustments.hsl.modes.advanced')}</button>
        <button className={`ce-tab seg-btn ${mode === 'skin-tone' ? 'active' : ''}`} onClick={() => setMode('skin-tone')}>{t('adjustments.hsl.modes.skinTone')}</button>
      </div>

      <div className="ce-wheel-area">
        {activeSector && mode === 'skin-tone' && (
          <ArcSlider value={getPickAbs(activeSector).sat} min={0} max={100} side="left" label="S"
            onChange={(v) => {
              const s = activeSector;
              const relSat = Math.max(0, Math.min(1, (v - s.satMin) / (s.satMax - s.satMin)));
              updateSector(selectedIdx, { pickRelSat: relSat });
            }} />
        )}
        <HSLWheel
          sectors={allSectors}
          selectedIdx={selectedIdx}
          cachedImageData={cachedImageData}
          onUpdateSector={updateSector}
          onClick={handleWheelClick}
        />
        {activeSector && mode === 'skin-tone' && (
          <ArcSlider value={activeSector.selLightness} min={-100} max={100} side="right" label="L"
            onChange={(v) => updateSector(selectedIdx, { selLightness: v })} />
        )}
      </div>

      {activeSector && <WheelValues sector={activeSector} />}

      <div className="ce-toolbar">
        {onPickerRequest && (
          <button className={`ce-picker-btn pill-btn ${pickerActive ? 'active' : ''}`}
            onClick={() => onPickerRequest(!pickerActive)}
            title={t('adjustments.hsl.pickerTitle')}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
              <path d="M10 1l3 3-8 8H2v-3z" /><path d="M8 3l3 3" />
            </svg>
          </button>
        )}
        <label className={`ce-view-range pill-btn ${viewSelected ? 'active' : ''}`}>
          <input type="checkbox" checked={viewSelected} onChange={() => setViewSelected(!viewSelected)} />
          {t('adjustments.hsl.viewRange')}
        </label>
      </div>

      <HSLControls
        mode={mode} hsl={hsl} onChange={onChange}
        selectedBasicIdx={selectedBasicIdx}
        basicFeather={basicFeather} onBasicFeatherChange={setBasicFeather}
        advSectors={advSectors} selectedAdvIdx={selectedAdvIdx}
        onAdvSectorsChange={setAdvSectors} onSelectAdvIdx={setSelectedAdvIdx}
        skinSector={skinSector} onSkinSectorChange={setSkinSector}
        skinSectors={skinSectors} selectedSkinIdx={selectedSkinIdx}
        onSkinSectorsChange={setSkinSectors} onSelectSkinIdx={setSelectedSkinIdx}
        uniformity={uniformity} onUniformityChange={setUniformity}
        activeSector={activeSector}
        onUpdateSector={updateSector}
      />
    </div>
  );
}

/**
 * The four numbers the wheel itself sets: where the pick point sits and how
 * far the sector reaches. The hue/sat/lightness deltas keep their own sliders.
 */
function WheelValues({ sector }: { sector: Sector }) {
  const { t } = useTranslation();
  const pick = getPickAbs(sector);
  const rows: [string, string][] = [
    [t('adjustments.hsl.wheel.hue'), `${Math.round(pick.hue)}°`],
    [t('adjustments.hsl.wheel.sat'), `${Math.round(pick.sat)}%`],
    [t('adjustments.hsl.wheel.range'), `±${Math.round(sector.hueHalfWidth)}°`],
    [t('adjustments.hsl.wheel.satRange'), `${Math.round(sector.satMin)}–${Math.round(sector.satMax)}%`],
  ];
  return (
    <dl className="ce-wheel-values">
      {rows.map(([label, value]) => (
        <div key={label} className="ce-wheel-value">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
