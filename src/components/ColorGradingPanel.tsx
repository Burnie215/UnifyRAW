import { useState, useRef, useCallback, useEffect, useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { ColorGrading, ColorGradingZone } from '../types';
import { displayHsl } from './hslUtils';
import { prepareCanvas } from '../image/hiDpiCanvas';
import { CompactSlider as Slider } from '../ui/CompactSlider';
import './ColorGradingPanel.css';

interface ColorGradingPanelProps {
  grading: ColorGrading;
  onChange: (grading: ColorGrading) => void;
}

type GradingZone = 'shadows' | 'midtones' | 'highlights';
type ViewMode = 'master' | '3way' | 'shadows' | 'midtones' | 'highlights';

const ZONE_LABEL_KEYS: Record<GradingZone, string> = {
  shadows: 'adjustments.colorGrading.shadow',
  midtones: 'adjustments.colorGrading.midtone',
  highlights: 'adjustments.colorGrading.highlight',
};

// Each wheel occupies THREE_WAY_SIZE + 2 * ARC_PAD = 110px. The side panel
// ranges from 220 to 450px, so .cg-3way wraps them into a row, a 2+1 triangle
// or a single column depending on what fits — see ColorGradingPanel.css.
const THREE_WAY_SIZE = 66;

const signed = (v: number) => (v > 0 ? `+${v}` : String(v));

/**
 * The four numbers behind a wheel. Hue reads as "–" at zero saturation: with no
 * tint applied the angle carries no meaning and a stray degree value misleads.
 */
function ZoneValues({ zone, layout }: { zone: ColorGradingZone; layout: 'column' | 'row' }) {
  const { t } = useTranslation();
  const rows: [string, string][] = [
    [t('adjustments.colorGrading.hue'), zone.saturation > 0 ? `${Math.round(zone.hue)}°` : '–'],
    [t('adjustments.colorGrading.sat'), `${Math.round(zone.saturation)}%`],
    [t('adjustments.colorGrading.satAdj'), signed(zone.satAdj)],
    [t('adjustments.colorGrading.lumAdj'), signed(zone.lumAdj)],
  ];
  return (
    <dl className={`cg-values cg-values-${layout}`}>
      {rows.map(([label, value]) => (
        <div key={label} className="cg-value">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ColorGradingPanel({ grading, onChange }: ColorGradingPanelProps) {
  const { t } = useTranslation();
  const [viewMode, setViewMode] = useState<ViewMode>('3way');

  const updateZone = useCallback((zone: GradingZone, patch: Partial<ColorGradingZone>) => {
    onChange({ ...grading, [zone]: { ...grading[zone], ...patch } });
  }, [grading, onChange]);

  const handleMasterWheel = (hue: number, sat: number) => {
    const h = Math.round(hue);
    const s = Math.round(sat);
    onChange({
      ...grading,
      shadows: { ...grading.shadows, hue: h, saturation: s },
      midtones: { ...grading.midtones, hue: h, saturation: s },
      highlights: { ...grading.highlights, hue: h, saturation: s },
    });
  };

  const zones: GradingZone[] = ['shadows', 'midtones', 'highlights'];

  return (
    <div className="cg-panel">
      {/* Split in two: the overview modes, then the single zones. Five pills in
          one row do not fit the panel at its default width. */}
      <div className="cg-tabs seg">
        {(['master', '3way'] as ViewMode[]).map((m) => (
          <button key={m} className={`cg-tab seg-btn ${viewMode === m ? 'active' : ''}`}
            onClick={() => setViewMode(m)}>
            {m === 'master' ? t('adjustments.colorGrading.master') : t('adjustments.colorGrading.threeWay')}
          </button>
        ))}
      </div>
      <div className="cg-tabs seg">
        {zones.map((z) => (
          <button key={z} className={`cg-tab seg-btn ${viewMode === z ? 'active' : ''}`}
            onClick={() => setViewMode(z)}>
            {t(ZONE_LABEL_KEYS[z])}
          </button>
        ))}
      </div>

      {viewMode === '3way' ? (
        <div className="cg-3way">
          {zones.map((z) => (
            <div key={z} className="cg-3way-cell">
              <C1Wheel
                hue={grading[z].hue}
                saturation={grading[z].saturation}
                satAdj={grading[z].satAdj}
                lumAdj={grading[z].lumAdj}
                size={THREE_WAY_SIZE}
                onChange={(h, s) => updateZone(z, { hue: Math.round(h), saturation: Math.round(s) })}
                onSatAdjChange={(v) => updateZone(z, { satAdj: v })}
                onLumAdjChange={(v) => updateZone(z, { lumAdj: v })}
              />
              <div className="cg-cell-info">
                <span className="cg-zone-label">{t(ZONE_LABEL_KEYS[z])}</span>
                <ZoneValues zone={grading[z]} layout="column" />
              </div>
            </div>
          ))}
        </div>
      ) : viewMode === 'master' ? (
        <div className="cg-single">
          <C1Wheel
            hue={grading.midtones.hue}
            saturation={grading.midtones.saturation}
            satAdj={0} lumAdj={0}
            size={140}
            onChange={handleMasterWheel}
          />
          <ZoneValues zone={grading.midtones} layout="row" />
        </div>
      ) : (
        <div className="cg-single">
          <C1Wheel
            hue={grading[viewMode as GradingZone].hue}
            saturation={grading[viewMode as GradingZone].saturation}
            satAdj={grading[viewMode as GradingZone].satAdj}
            lumAdj={grading[viewMode as GradingZone].lumAdj}
            size={140}
            onChange={(h, s) => updateZone(viewMode as GradingZone, { hue: Math.round(h), saturation: Math.round(s) })}
            onSatAdjChange={(v) => updateZone(viewMode as GradingZone, { satAdj: v })}
            onLumAdjChange={(v) => updateZone(viewMode as GradingZone, { lumAdj: v })}
          />
          <ZoneValues zone={grading[viewMode as GradingZone]} layout="row" />
        </div>
      )}

      <Slider label={t('adjustments.colorGrading.blending')} value={grading.blending} min={0} max={100} defaultValue={50}
        onChange={(v) => onChange({ ...grading, blending: v })} />
      <Slider label={t('adjustments.colorGrading.balance')} value={grading.balance} min={-100} max={100}
        onChange={(v) => onChange({ ...grading, balance: v })} />
    </div>
  );
}

/* ─── Capture One Style Wheel with Sat/Lum Arc Sliders ─── */

interface C1WheelProps {
  hue: number;
  saturation: number;
  satAdj: number;
  lumAdj: number;
  size: number;
  onChange: (hue: number, saturation: number) => void;
  onSatAdjChange?: (v: number) => void;
  onLumAdjChange?: (v: number) => void;
}

const ARC_PAD = 22; // space for arc sliders on each side

function C1Wheel({ hue, saturation, satAdj, lumAdj, size, onChange, onSatAdjChange, onLumAdjChange }: C1WheelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<'wheel' | 'sat' | 'lum' | null>(null);
  const uid = useId();

  const totalSize = size + ARC_PAD * 2;
  const ringWidth = Math.max(2.5, size * 0.03);
  const outerR = size / 2 - 1;
  const innerR = outerR - ringWidth;
  const pickR = innerR - 2;
  const cx = totalSize / 2;
  const cy = totalSize / 2;

  // Wheel indicator
  const angle = (hue - 90) * (Math.PI / 180);
  const dist = (saturation / 100) * pickR;
  const ix = cx + Math.cos(angle) * dist;
  const iy = cy + Math.sin(angle) * dist;

  // Draw rainbow ring
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = prepareCanvas(canvas, totalSize, totalSize);
    ctx.clearRect(0, 0, totalSize, totalSize);

    for (let a = 0; a < 360; a++) {
      const rad = (a - 90) * Math.PI / 180;
      const rad2 = (a - 89) * Math.PI / 180;
      ctx.beginPath();
      ctx.arc(cx, cy, outerR, rad, rad2 + 0.02);
      ctx.arc(cx, cy, innerR, rad2 + 0.02, rad, true);
      ctx.closePath();
      ctx.fillStyle = displayHsl(a);
      ctx.fill();
    }

    // Hue wash under the neutral disc — the veil below leaves only a trace of
    // it at the rim and none at the centre, so radius still reads as saturation.
    for (let a = 0; a < 360; a++) {
      const rad = (a - 90) * Math.PI / 180;
      const rad2 = (a - 89) * Math.PI / 180;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, innerR - 0.5, rad, rad2 + 0.02);
      ctx.closePath();
      ctx.fillStyle = displayHsl(a);
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(cx, cy, innerR - 0.5, 0, Math.PI * 2);
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, innerR);
    grad.addColorStop(0, 'rgba(50,50,50,1)');
    grad.addColorStop(1, 'rgba(30,30,30,0.88)');
    ctx.fillStyle = grad;
    ctx.fill();
  }, [totalSize, cx, cy, outerR, innerR]);

  // Pointer handlers
  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * totalSize;
    const py = ((e.clientY - rect.top) / rect.height) * totalSize;
    const dx = px - cx;
    const dy = py - cy;

    if (dragging.current === 'wheel') {
      const d = Math.sqrt(dx * dx + dy * dy);
      const sat = Math.min(100, (d / pickR) * 100);
      let h = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
      if (h < 0) h += 360;
      onChange(h, sat);
    } else if (dragging.current === 'sat' && onSatAdjChange) {
      const val = Math.round(Math.max(-100, Math.min(100, -(dy / outerR) * 100)));
      onSatAdjChange(val);
    } else if (dragging.current === 'lum' && onLumAdjChange) {
      // Up = brighter (positive), down = darker (negative)
      const val = Math.round(Math.max(-100, Math.min(100, -(dy / outerR) * 100)));
      onLumAdjChange(val);
    }
  }, [totalSize, cx, cy, pickR, outerR, onChange, onSatAdjChange, onLumAdjChange]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const rect = containerRef.current!.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * totalSize;
    const py = ((e.clientY - rect.top) / rect.height) * totalSize;
    const dx = px - cx;
    const dy = py - cy;
    const d = Math.sqrt(dx * dx + dy * dy);

    if (d > outerR + 2) {
      dragging.current = dx < 0 ? 'sat' : 'lum';
    } else {
      dragging.current = 'wheel';
    }

    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    handlePointerMove(e);
  }, [totalSize, cx, cy, outerR, handlePointerMove]);

  const handlePointerUp = useCallback(() => { dragging.current = null; }, []);

  // Arc positions
  const arcR = outerR + 12;
  const satArcStart = Math.PI * 0.6;
  const satArcEnd = Math.PI * 1.4;
  const lumArcStart = -Math.PI * 0.4;
  const lumArcEnd = Math.PI * 0.4;

  // Left arc thumb: -100=bottom, +100=top.
  const satT = (satAdj + 100) / 200;
  const satAngle = satArcStart + satT * (satArcEnd - satArcStart);
  // Right arc thumb: lumAdj -100=bottom(dark), +100=top(bright) → invert mapping
  const lumT = 1 - (lumAdj + 100) / 200;
  const lumAngle = lumArcStart + lumT * (lumArcEnd - lumArcStart);

  return (
    <div className="c1-wheel" ref={containerRef} style={{ width: totalSize, height: totalSize }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      {/* The bitmap is resized for the device pixel ratio, so the layout size
          must come from CSS — otherwise the width attribute would scale it. */}
      <canvas
        ref={canvasRef}
        width={totalSize}
        height={totalSize}
        style={{ width: totalSize, height: totalSize }}
        className="c1-wheel-canvas"
      />
      {/* Center dot */}
      <div className="c1-center" style={{ left: cx, top: cy }} />
      {/* Wheel indicator */}
      <div className="c1-indicator" style={{ left: ix, top: iy }} />

      {/* Arc sliders (SVG overlay) */}
      {(onSatAdjChange || onLumAdjChange) && (
        <svg className="c1-arcs" width={totalSize} height={totalSize} viewBox={`0 0 ${totalSize} ${totalSize}`}>
          <defs>
            {/* Left arc gradient: bottom=dark → top=saturated hue color */}
            {onSatAdjChange && (
              <linearGradient id={`satGrad${uid}`} x1="0" y1="1" x2="0" y2="0">
                <stop offset="0%" stopColor="rgba(60,60,60,0.8)" />
                <stop offset="100%" stopColor={displayHsl(hue, 100, 55)} />
              </linearGradient>
            )}
            {/* Right arc gradient: top=white → bottom=black */}
            {onLumAdjChange && (
              <linearGradient id={`lumGrad${uid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgba(255,255,255,0.8)" />
                <stop offset="100%" stopColor="rgba(0,0,0,0.8)" />
              </linearGradient>
            )}
          </defs>
          {/* Left arc — Saturation (synced with radial dot position) */}
          {onSatAdjChange && <>
            <path d={describeArc(cx, cy, arcR, satArcStart, satArcEnd)}
              fill="none" stroke={`url(#satGrad${uid})`} strokeWidth="2.5" strokeLinecap="round" />
            <circle cx={cx + Math.cos(satAngle) * arcR} cy={cy + Math.sin(satAngle) * arcR}
              r="3" fill={displayHsl(hue, Math.round(50 + satT * 50), 60)} stroke="rgba(0,0,0,0.45)" strokeWidth="0.8" />
          </>}
          {/* Right arc — Luminance (top=white, bottom=black) */}
          {onLumAdjChange && <>
            <path d={describeArc(cx, cy, arcR, lumArcStart, lumArcEnd)}
              fill="none" stroke={`url(#lumGrad${uid})`} strokeWidth="2.5" strokeLinecap="round" />
            <circle cx={cx + Math.cos(lumAngle) * arcR} cy={cy + Math.sin(lumAngle) * arcR}
              r="3" fill={`hsl(0, 0%, ${Math.round((1 - lumT) * 100)}%)`} stroke="rgba(0,0,0,0.45)" strokeWidth="0.8" />
          </>}
        </svg>
      )}
    </div>
  );
}

function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number): string {
  const x1 = cx + r * Math.cos(startAngle);
  const y1 = cy + r * Math.sin(startAngle);
  const x2 = cx + r * Math.cos(endAngle);
  const y2 = cy + r * Math.sin(endAngle);
  const large = Math.abs(endAngle - startAngle) > Math.PI ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
}
