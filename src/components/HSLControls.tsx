import { useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { HSLAdjustments } from '../types';
import { CompactSlider as Slider } from '../ui/CompactSlider';
import { type Sector, getPickAbs, BASIC, makeSector, displayHsl } from './hslUtils';

type Mode = 'basic' | 'advanced' | 'skin-tone';

type Uniformity = { hue: number; saturation: number; luminance: number };

interface HSLControlsProps {
  mode: Mode;
  hsl: HSLAdjustments;
  onChange: (hsl: HSLAdjustments) => void;
  // Basic
  selectedBasicIdx: number;
  basicFeather: number;
  onBasicFeatherChange: (v: number) => void;
  // Advanced
  advSectors: Sector[];
  selectedAdvIdx: number;
  onAdvSectorsChange: (fn: Sector[] | ((prev: Sector[]) => Sector[])) => void;
  onSelectAdvIdx: (idx: number) => void;
  // Skin tone
  skinSector: Sector;
  onSkinSectorChange: (fn: Sector | ((prev: Sector) => Sector)) => void;
  skinSectors: Sector[];
  selectedSkinIdx: number;
  onSkinSectorsChange: (fn: Sector[] | ((prev: Sector[]) => Sector[])) => void;
  onSelectSkinIdx: (idx: number) => void;
  uniformity: Uniformity;
  onUniformityChange: (fn: Uniformity | ((prev: Uniformity) => Uniformity)) => void;
  // Shared
  activeSector: Sector | null;
  onUpdateSector: (idx: number, patch: Partial<Sector>) => void;
}

/**
 * Track backgrounds for the hue/saturation/lightness trio, tinted by the colour
 * being edited — the same visual language the basic panels already use.
 */
function colorTracks(hue: number, color: string) {
  // The hue slider shifts by ±180°, so the track carries the whole circle with
  // the edited colour in the middle — both ends meet at its opposite.
  const steps = 12;
  const wheel = Array.from({ length: steps + 1 }, (_, i) => {
    const h = (((hue - 180 + (360 * i) / steps) % 360) + 360) % 360;
    return `${displayHsl(h, 100, 55)} ${((i / steps) * 100).toFixed(1)}%`;
  }).join(', ');
  return {
    hue: `linear-gradient(to right, ${wheel})`,
    saturation: `linear-gradient(to right, #666, ${color})`,
    lightness: `linear-gradient(to right, #000, ${color}, #fff)`,
  };
}

export function HSLControls({
  mode, hsl, onChange,
  selectedBasicIdx, basicFeather, onBasicFeatherChange,
  advSectors, selectedAdvIdx, onAdvSectorsChange, onSelectAdvIdx,
  skinSector: _skinSector, onSkinSectorChange, skinSectors, selectedSkinIdx, onSkinSectorsChange, onSelectSkinIdx,
  uniformity, onUniformityChange,
  activeSector, onUpdateSector,
}: HSLControlsProps) {
  const { t } = useTranslation();
  const selKey = BASIC[selectedBasicIdx]?.key;
  const basicTracks = colorTracks(BASIC[selectedBasicIdx]?.hue ?? 0, BASIC[selectedBasicIdx]?.color ?? '#888');
  const sectorHue = activeSector?.hueCenter ?? 0;
  const sectorTracks = colorTracks(sectorHue, activeSector ? displayHsl(sectorHue, 100, 60) : '#888');

  return (
    <>
      {/* ── BASIC ── */}
      {mode === 'basic' && selKey && (<>
        <div className="ce-sliders">
          <Slider label={t('adjustments.hsl.feather')} value={basicFeather} min={1} max={30} defaultValue={12}
            onChange={onBasicFeatherChange} />
          <Slider label={t('adjustments.hsl.hue')} value={hsl[selKey].hue} min={-180} max={180}
            onChange={(v) => onChange({ ...hsl, [selKey]: { ...hsl[selKey], hue: v } })} trackGradient={basicTracks.hue} />
          <Slider label={t('adjustments.hsl.saturation')} value={hsl[selKey].saturation} min={-100} max={100}
            onChange={(v) => onChange({ ...hsl, [selKey]: { ...hsl[selKey], saturation: v } })} trackGradient={basicTracks.saturation} />
          <Slider label={t('adjustments.hsl.lightness')} value={hsl[selKey].luminance} min={-100} max={100}
            onChange={(v) => onChange({ ...hsl, [selKey]: { ...hsl[selKey], luminance: v } })} trackGradient={basicTracks.lightness} />
        </div>
        <DeltaTable
          rows={BASIC.map((b, i) => ({
            id: b.key, color: b.color, selected: i === selectedBasicIdx,
            dH: hsl[b.key].hue, dS: hsl[b.key].saturation, dL: hsl[b.key].luminance, enabled: true,
          }))}
          onSelect={(id) => {
            const idx = BASIC.findIndex((b) => b.key === id);
            if (idx >= 0) onUpdateSector(idx, {}); // triggers selection via parent
          }}
        />
      </>)}

      {/* ── ADVANCED ── */}
      {mode === 'advanced' && (<>
        {advSectors.length === 0 && <div className="ce-hint">{t('adjustments.hsl.advancedHint')}</div>}
        {activeSector && (
          <div className="ce-sliders">
            <Slider label={t('adjustments.hsl.feather')} value={activeSector.feather} min={1} max={30} defaultValue={12}
              onChange={(v) => onUpdateSector(selectedAdvIdx, { feather: v })} />
            <Slider label={t('adjustments.hsl.hue')} value={activeSector.dH} min={-180} max={180}
              onChange={(v) => onUpdateSector(selectedAdvIdx, { dH: v })} trackGradient={sectorTracks.hue} />
            <Slider label={t('adjustments.hsl.saturation')} value={activeSector.dS} min={-100} max={100}
              onChange={(v) => onUpdateSector(selectedAdvIdx, { dS: v })} trackGradient={sectorTracks.saturation} />
            <Slider label={t('adjustments.hsl.lightness')} value={activeSector.dL} min={-100} max={100}
              onChange={(v) => onUpdateSector(selectedAdvIdx, { dL: v })} trackGradient={sectorTracks.lightness} />
          </div>
        )}
        <DeltaTable
          rows={advSectors.map((s, i) => ({
            id: s.id, color: `hsl(${s.hueCenter}, 70%, 50%)`, selected: i === selectedAdvIdx,
            dH: s.dH, dS: s.dS, dL: s.dL, enabled: s.enabled,
          }))}
          onSelect={(id) => onSelectAdvIdx(advSectors.findIndex((s) => s.id === id))}
          onToggle={(id) => {
            const i = advSectors.findIndex((s) => s.id === id);
            if (i >= 0) onAdvSectorsChange((prev) => prev.map((s, j) => j === i ? { ...s, enabled: !s.enabled } : s));
          }}
        />
        <div className="ce-adv-footer">
          <div className="ce-adv-btns">
            <button className="ce-adv-btn pill-btn" onClick={() => {
              const s = makeSector(0);
              onAdvSectorsChange((prev) => [...prev, s]);
              onSelectAdvIdx(advSectors.length);
            }} disabled={advSectors.length >= 24}>+</button>
            <button className="ce-adv-btn pill-btn" onClick={() => {
              if (selectedAdvIdx < 0) return;
              onAdvSectorsChange((prev) => prev.filter((_, i) => i !== selectedAdvIdx));
              onSelectAdvIdx(-1);
            }} disabled={selectedAdvIdx < 0}>−</button>
          </div>
        </div>
        {activeSector && <ColorCompare sector={activeSector} />}
      </>)}

      {/* ���─ SKIN TONE ── */}
      {mode === 'skin-tone' && (<>
        {activeSector && (
          <div className="ce-sliders">
            <Slider label={t('adjustments.hsl.feather')} value={activeSector.feather} min={1} max={30} defaultValue={12}
              onChange={(v) => {
                if (selectedSkinIdx < 0) onSkinSectorChange((p) => ({ ...p, feather: v }));
                else onSkinSectorsChange((prev) => prev.map((s, i) => i === selectedSkinIdx ? { ...s, feather: v } : s));
              }} />
            <Slider label={t('adjustments.hsl.hue')} value={activeSector.dH} min={-180} max={180}
              onChange={(v) => {
                if (selectedSkinIdx < 0) onSkinSectorChange((p) => ({ ...p, dH: v }));
                else onSkinSectorsChange((prev) => prev.map((s, i) => i === selectedSkinIdx ? { ...s, dH: v } : s));
              }} trackGradient={sectorTracks.hue} />
            <Slider label={t('adjustments.hsl.saturation')} value={activeSector.dS} min={-100} max={100}
              onChange={(v) => {
                if (selectedSkinIdx < 0) onSkinSectorChange((p) => ({ ...p, dS: v }));
                else onSkinSectorsChange((prev) => prev.map((s, i) => i === selectedSkinIdx ? { ...s, dS: v } : s));
              }} trackGradient={sectorTracks.saturation} />
            <Slider label={t('adjustments.hsl.lightness')} value={activeSector.dL} min={-100} max={100}
              onChange={(v) => {
                if (selectedSkinIdx < 0) onSkinSectorChange((p) => ({ ...p, dL: v }));
                else onSkinSectorsChange((prev) => prev.map((s, i) => i === selectedSkinIdx ? { ...s, dL: v } : s));
              }} trackGradient={sectorTracks.lightness} />
          </div>
        )}
        <DeltaTable
          rows={skinSectors.map((s, i) => ({
            id: s.id, color: `hsl(${s.hueCenter}, 70%, 50%)`, selected: i === selectedSkinIdx,
            dH: s.dH, dS: s.dS, dL: s.dL, enabled: s.enabled,
          }))}
          onSelect={(id) => onSelectSkinIdx(skinSectors.findIndex((s) => s.id === id))}
          onToggle={(id) => {
            onSkinSectorsChange((prev) => prev.map((s) => s.id === id ? { ...s, enabled: !s.enabled } : s));
          }}
        />
        <div className="ce-adv-btns">
          <button className="ce-adv-btn pill-btn" onClick={() => {
            const s = makeSector(25, 20, 50);
            onSkinSectorsChange((prev) => [...prev, s]);
            onSelectSkinIdx(skinSectors.length);
          }} disabled={skinSectors.length >= 8}>+</button>
          <button className="ce-adv-btn pill-btn" onClick={() => {
            if (selectedSkinIdx < 0) return;
            onSkinSectorsChange((prev) => prev.filter((_, i) => i !== selectedSkinIdx));
            onSelectSkinIdx(-1);
          }} disabled={selectedSkinIdx < 0}>−</button>
        </div>
        <div className="ce-uniformity">
          <div className="ce-uniformity-header">{t('adjustments.hsl.uniformity')}</div>
          <Slider label={t('adjustments.hsl.hue')} value={uniformity.hue} min={0} max={100}
            onChange={(v) => onUniformityChange((p) => ({ ...p, hue: v }))} trackGradient={sectorTracks.hue} />
          <Slider label={t('adjustments.hsl.saturation')} value={uniformity.saturation} min={0} max={100}
            onChange={(v) => onUniformityChange((p) => ({ ...p, saturation: v }))} trackGradient={sectorTracks.saturation} />
          <Slider label={t('adjustments.hsl.lightness')} value={uniformity.luminance} min={0} max={100}
            onChange={(v) => onUniformityChange((p) => ({ ...p, luminance: v }))} trackGradient={sectorTracks.lightness} />
        </div>
      </>)}
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */

function ColorCompare({ sector }: { sector: Sector }) {
  const pick = getPickAbs(sector);
  const origH = pick.hue, origS = pick.sat;
  const adjH = (origH + sector.dH + 360) % 360;
  const adjS = Math.max(0, Math.min(100, origS + sector.dS));
  const adjL = Math.max(0, Math.min(100, 50 + sector.dL * 0.3 + sector.selLightness * 0.2));

  return (
    <div className="ce-compare">
      <div className="ce-compare-swatch" style={{ background: `hsl(${origH}, ${origS}%, 50%)` }} />
      <div className="ce-compare-swatch" style={{ background: `hsl(${adjH}, ${adjS}%, ${adjL}%)` }} />
      <div className="ce-compare-vals">
        <span>H:{origH.toFixed(0)} S:{origS.toFixed(0)} L:50</span>
        <span>→</span>
        <span>H:{adjH.toFixed(0)} S:{adjS.toFixed(0)} L:{adjL.toFixed(0)}</span>
      </div>
    </div>
  );
}

export function ArcSlider({ value, min, max, onChange, side, label }: {
  value: number; min: number; max: number;
  onChange: (v: number) => void; side: 'left' | 'right'; label: string;
}) {
  const dragging = useRef(false);
  const height = 180;
  const t = (value - min) / (max - min);
  const thumbY = height - t * height;

  const handleMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;
    onChange(Math.round(Math.max(min, Math.min(max, max - y * (max - min)))));
  }, [min, max, onChange]);

  return (
    <div className={`ce-arc-slider ce-arc-${side}`}
      onPointerDown={(e) => { dragging.current = true; (e.target as HTMLElement).setPointerCapture(e.pointerId); handleMove(e); }}
      onPointerMove={handleMove}
      onPointerUp={() => { dragging.current = false; }}
    >
      <div className="ce-arc-track" />
      <div className="ce-arc-thumb" style={{ top: thumbY }} />
      <span className="ce-arc-label">{label}</span>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */

interface TRow { id: string; color: string; selected: boolean; dH: number; dS: number; dL: number; enabled: boolean; }

function DeltaTable({ rows, onSelect, onToggle }: {
  rows: TRow[]; onSelect: (id: string) => void; onToggle?: (id: string) => void;
}) {
  return (
    <div className="ce-table">
      <div className="ce-table-header">
        <span className="ce-th" /><span className="ce-th" />
        <span className="ce-th">ΔH</span><span className="ce-th">ΔS</span><span className="ce-th">ΔL</span>
      </div>
      {rows.map((r) => (
        <div key={r.id} className={`ce-table-row ${r.selected ? 'active' : ''} ${(r.dH || r.dS || r.dL) ? 'changed' : ''}`}
          onClick={() => onSelect(r.id)}>
          <span className="ce-check" onClick={(e) => { e.stopPropagation(); onToggle?.(r.id); }}>
            {r.enabled ? '✓' : '○'}
          </span>
          <span className="ce-color-dot" style={{ background: r.color }} />
          <span className="ce-val">{r.dH.toFixed(1)}</span>
          <span className="ce-val">{r.dS.toFixed(1)}</span>
          <span className="ce-val">{r.dL.toFixed(1)}</span>
        </div>
      ))}
    </div>
  );
}
