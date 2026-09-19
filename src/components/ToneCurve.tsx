import { useRef, useCallback, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { CurvePoint, ToneCurveAdjustment, ToneCurveChannel } from '../types';
import type { HistogramStyle } from '../types';
import { useSettings } from '../contexts/SettingsContext';
import { histogramFromCanvas, histogramFromUrl, type HistogramBins, buildSvgHistogramPaths } from '../image/histogram';
import './ToneCurve.css';

interface ToneCurveProps {
  curve: ToneCurveAdjustment;
  onChange: (curve: ToneCurveAdjustment) => void;
  imageUrl?: string | null;
  renderedCanvas?: HTMLCanvasElement | null;
  renderGeneration?: number;
  histogramStyle?: HistogramStyle;
}

const SIZE = 240;
const PAD = 2;
const PT_HALF = 4; // half-size of square control point
const ACCENT = '#e67e22';

type Channel = ToneCurveChannel;

const CURVE_COLORS: Record<Channel, string> = {
  rgb: '#ccc', luma: '#ccc', red: '#e74c3c', green: '#2ecc71', blue: '#3498db',
};

const DEFAULT_CURVE: CurvePoint[] = [
  { x: 0, y: 0 }, { x: 1, y: 1 },
];

const CURVE_PRESETS: { id: string; curve: CurvePoint[] }[] = [
  { id: 'linear', curve: DEFAULT_CURVE },
  { id: 'strongContrast', curve: [{ x: 0, y: 0 }, { x: 0.25, y: 0.18 }, { x: 0.5, y: 0.45 }, { x: 0.75, y: 0.82 }, { x: 1, y: 1 }] },
  { id: 'mediumContrast', curve: [{ x: 0, y: 0 }, { x: 0.25, y: 0.22 }, { x: 0.5, y: 0.48 }, { x: 0.75, y: 0.78 }, { x: 1, y: 1 }] },
  { id: 'filmMatte', curve: [{ x: 0, y: 0.05 }, { x: 0.25, y: 0.30 }, { x: 0.5, y: 0.52 }, { x: 0.75, y: 0.78 }, { x: 1, y: 0.95 }] },
  { id: 'negative', curve: [{ x: 0, y: 1 }, { x: 0.25, y: 0.75 }, { x: 0.5, y: 0.5 }, { x: 0.75, y: 0.25 }, { x: 1, y: 0 }] },
  { id: 'crossProcess', curve: [{ x: 0, y: 0 }, { x: 0.25, y: 0.15 }, { x: 0.5, y: 0.55 }, { x: 0.75, y: 0.85 }, { x: 1, y: 0.95 }] },
];

function toSvg(p: CurvePoint): { cx: number; cy: number } {
  return {
    cx: PAD + p.x * (SIZE - 2 * PAD),
    cy: PAD + (1 - p.y) * (SIZE - 2 * PAD),
  };
}

function fromSvg(sx: number, sy: number): CurvePoint {
  return {
    x: Math.max(0, Math.min(1, (sx - PAD) / (SIZE - 2 * PAD))),
    y: Math.max(0, Math.min(1, 1 - (sy - PAD) / (SIZE - 2 * PAD))),
  };
}

function buildPath(points: CurvePoint[]): string {
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const pts = sorted.map(toSvg);
  if (pts.length < 2) return '';
  if (pts.length === 2) {
    return `M${pts[0].cx},${pts[0].cy} L${pts[1].cx},${pts[1].cy}`;
  }
  // Catmull-Rom → cubic bezier for smooth curves through all points
  let d = `M${pts[0].cx},${pts[0].cy}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    // Tangents (Catmull-Rom, tension=0)
    const t1x = (p2.cx - p0.cx) / 6;
    const t1y = (p2.cy - p0.cy) / 6;
    const t2x = (p3.cx - p1.cx) / 6;
    const t2y = (p3.cy - p1.cy) / 6;
    d += ` C${p1.cx + t1x},${p1.cy + t1y} ${p2.cx - t2x},${p2.cy - t2y} ${p2.cx},${p2.cy}`;
  }
  return d;
}

// Histogram paths are now built via buildSvgHistogramPaths from shared utility

export function ToneCurve({ curve, onChange, imageUrl, renderedCanvas, renderGeneration, histogramStyle: histogramStyleOverride }: ToneCurveProps) {
  const { t } = useTranslation();
  const { histogramStyle: configuredHistogramStyle } = useSettings();
  const histogramStyle = histogramStyleOverride ?? configuredHistogramStyle;
  const svgRef = useRef<SVGSVGElement>(null);
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
  const [channel, setChannel] = useState<Channel>('rgb');
  const [histogram, setHistogram] = useState<HistogramBins | null>(null);

  // Build histogram from rendered canvas or fallback to source image
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const bins = renderedCanvas
        ? histogramFromCanvas(renderedCanvas)
        : imageUrl ? await histogramFromUrl(imageUrl) : null;
      if (!cancelled && bins) setHistogram(bins);
    })();
    return () => { cancelled = true; };
  }, [renderedCanvas, renderGeneration, imageUrl]);

  // Current channel's points
  const pts = curve[channel];
  const sorted = [...pts].sort((a, b) => a.x - b.x);
  const activePoint = draggingIdx !== null ? pts[draggingIdx] : null;

  // Helper: update only the active channel
  const updateChannel = useCallback((newPts: CurvePoint[]) => {
    onChange({ ...curve, [channel]: newPts });
  }, [curve, channel, onChange]);

  // Drag an existing point
  const handlePointerDown = useCallback((idx: number, e: React.PointerEvent) => {
    e.stopPropagation();
    setDraggingIdx(idx);
    (e.target as SVGElement).setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (draggingIdx === null || !svgRef.current) return;
      const rect = svgRef.current.getBoundingClientRect();
      const sx = ((e.clientX - rect.left) / rect.width) * SIZE;
      const sy = ((e.clientY - rect.top) / rect.height) * SIZE;
      const pt = fromSvg(sx, sy);
      const isFirst = draggingIdx === 0 || pts[draggingIdx].x === 0;
      const isLast = draggingIdx === pts.length - 1 || pts[draggingIdx].x === 1;
      if (isFirst) pt.x = 0;
      if (isLast) pt.x = 1;
      updateChannel(pts.map((p, i) => i === draggingIdx ? pt : p));
    },
    [draggingIdx, pts, updateChannel],
  );

  const handlePointerUp = useCallback(() => setDraggingIdx(null), []);

  // Click on curve area: add new point
  const handleSvgClick = useCallback((e: React.MouseEvent) => {
    if (draggingIdx !== null) return;
    const rect = svgRef.current!.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * SIZE;
    const sy = ((e.clientY - rect.top) / rect.height) * SIZE;
    const pt = fromSvg(sx, sy);
    const tooClose = pts.some((p) => Math.abs(p.x - pt.x) < 0.02);
    if (tooClose || pts.length >= 20) return;
    updateChannel([...pts, pt].sort((a, b) => a.x - b.x));
  }, [draggingIdx, pts, updateChannel]);

  // Double-click on point: remove it (except first/last)
  const handlePointDblClick = useCallback((idx: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const p = pts[idx];
    if (p.x === 0 || p.x === 1) return;
    if (pts.length <= 2) return;
    updateChannel(pts.filter((_, i) => i !== idx));
  }, [pts, updateChannel]);

  const handleReset = useCallback(() => updateChannel([...DEFAULT_CURVE]), [updateChannel]);

  const path = buildPath(sorted);
  const curveColor = CURVE_COLORS[channel];

  // Histogram paths via shared utility
  const histSvg = histogram ? buildSvgHistogramPaths(histogram, histogramStyle, SIZE, SIZE, PAD, PAD) : null;

  return (
    <div className="tone-curve">
      {/* Channel tabs */}
      <div className="curve-top-bar">
        <div className="curve-channels">
          {(['rgb', 'luma', 'red', 'green', 'blue'] as Channel[]).map((ch) => (
            <button
              key={ch}
              className={`curve-ch-tab ${channel === ch ? 'active' : ''}`}
              style={channel === ch ? { color: CURVE_COLORS[ch], borderBottomColor: CURVE_COLORS[ch] } : undefined}
              onClick={() => setChannel(ch)}
            >
              {t(`adjustments.curve.channels.${ch}`)}
            </button>
          ))}
        </div>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="curve-svg"
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onClick={handleSvgClick}
      >
        {/* Per-channel histogram */}
        {histSvg && (
          <>
            {histSvg.fills.map((f, i) => (
              <path key={`f${i}`} d={f.d} fill={f.color} opacity={f.opacity}
                style={f.blend ? { mixBlendMode: f.blend } : undefined} />
            ))}
            {histSvg.strokes.map((s, i) => <path key={`s${i}`} d={s.d} fill="none" stroke={s.color} opacity={s.opacity} strokeWidth={s.width} />)}
          </>
        )}

        {/* Grid */}
        {[0.25, 0.5, 0.75].map((t) => (
          <g key={t}>
            <line x1={PAD + t * (SIZE - 2 * PAD)} y1={PAD} x2={PAD + t * (SIZE - 2 * PAD)} y2={SIZE - PAD} className="curve-grid" />
            <line x1={PAD} y1={PAD + t * (SIZE - 2 * PAD)} x2={SIZE - PAD} y2={PAD + t * (SIZE - 2 * PAD)} className="curve-grid" />
          </g>
        ))}

        {/* Diagonal baseline */}
        <line x1={PAD} y1={SIZE - PAD} x2={SIZE - PAD} y2={PAD} className="curve-baseline" />

        {/* Orange vertical guide at active point */}
        {activePoint && (
          <line
            x1={toSvg(activePoint).cx} y1={PAD}
            x2={toSvg(activePoint).cx} y2={SIZE - PAD}
            stroke={ACCENT} strokeWidth="1" opacity="0.6"
          />
        )}

        {/* Curve line */}
        <path d={path} className="curve-line" stroke={curveColor} />

        {/* Square control points */}
        {pts.map((p, idx) => {
          const { cx, cy } = toSvg(p);
          const active = draggingIdx === idx;
          const s = active ? PT_HALF + 2 : PT_HALF;
          return (
            <rect
              key={idx}
              x={cx - s} y={cy - s}
              width={s * 2} height={s * 2}
              className={`curve-point ${active ? 'active' : ''}`}
              fill={active ? ACCENT : 'transparent'}
              stroke={active ? ACCENT : curveColor}
              onPointerDown={(e) => handlePointerDown(idx, e)}
              onDoubleClick={(e) => handlePointDblClick(idx, e)}
            />
          );
        })}
      </svg>

      {/* Bottom bar: I/O + actions */}
      <div className="curve-bottom-bar">
        <div className="curve-io">
          <span>{t('adjustments.curve.input')}&ensp;{activePoint ? Math.round(activePoint.x * 255) : '--'}</span>
          <span>{t('adjustments.curve.output')}&ensp;{activePoint ? Math.round(activePoint.y * 255) : '--'}</span>
        </div>
        <div className="curve-bottom-actions">
          <button className="curve-reset-btn" onClick={handleReset} title={t('adjustments.curve.reset')}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2 6a4 4 0 1 1 1.17 2.83" /><path d="M2 9V6h3" />
            </svg>
          </button>
          <select className="curve-preset-select" defaultValue="" onChange={(e) => {
            const preset = CURVE_PRESETS.find((pr) => pr.id === e.target.value);
            if (preset) updateChannel([...preset.curve]);
            e.target.value = '';
          }}>
            <option value="" disabled>{t('adjustments.curve.presetPlaceholder')}</option>
            {CURVE_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>{t(`adjustments.curve.presets.${p.id}`)}</option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
