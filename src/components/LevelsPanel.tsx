import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { LevelsAdjustment, ChannelLevels, LevelsChannel, HistogramStyle } from '../types';
import { useSettings } from '../contexts/SettingsContext';
import { histogramFromCanvas, histogramFromUrl, type HistogramBins, buildSvgHistogramPaths } from '../image/histogram';
import './LevelsPanel.css';

interface LevelsPanelProps {
  levels: LevelsAdjustment;
  onChange: (levels: LevelsAdjustment) => void;
  imageUrl?: string | null;
  renderedCanvas?: HTMLCanvasElement | null;
  renderGeneration?: number;
  histogramStyle?: HistogramStyle;
}

const CHANNELS: { key: LevelsChannel; color: string }[] = [
  { key: 'rgb', color: '#ccc' },
  { key: 'red', color: '#e74c3c' },
  { key: 'green', color: '#2ecc71' },
  { key: 'blue', color: '#3498db' },
];

const W = 280;
const H = 120;

// Histogram paths built via shared buildSvgHistogramPaths utility

export function LevelsPanel({ levels, onChange, imageUrl, renderedCanvas, renderGeneration, histogramStyle: histogramStyleOverride }: LevelsPanelProps) {
  const { t } = useTranslation();
  const { histogramStyle: configuredHistogramStyle } = useSettings();
  const histogramStyle = histogramStyleOverride ?? configuredHistogramStyle;
  const [channel, setChannel] = useState<LevelsChannel>('rgb');
  const [histogram, setHistogram] = useState<HistogramBins | null>(null);
  const dragging = useRef<'inBlack' | 'inWhite' | 'gamma' | 'outBlack' | 'outWhite' | null>(null);
  const sliderAreaRef = useRef<HTMLDivElement>(null);

  const ch = levels[channel];

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

  const update = useCallback((patch: Partial<ChannelLevels>) => {
    onChange({ ...levels, [channel]: { ...levels[channel], ...patch } });
  }, [levels, channel, onChange]);

  const xToVal = useCallback((clientX: number, ref: React.RefObject<HTMLDivElement | null>): number => {
    if (!ref.current) return 0;
    const rect = ref.current.getBoundingClientRect();
    const t = (clientX - rect.left) / rect.width;
    return Math.round(Math.max(0, Math.min(255, t * 255)));
  }, []);

  const xToGamma = useCallback((clientX: number): number => {
    if (!sliderAreaRef.current) return 1;
    const rect = sliderAreaRef.current.getBoundingClientRect();
    const t = (clientX - rect.left) / rect.width;
    const inB = ch.inBlack / 255;
    const inW = ch.inWhite / 255;
    const mid = (inB + inW) / 2;
    const range = (inW - inB) / 2;
    if (range < 0.01) return 1;
    const offset = (t - mid) / range;
    return Math.max(0.1, Math.min(10, Math.pow(10, -offset)));
  }, [ch.inBlack, ch.inWhite]);

  const handlePointerDown = useCallback((mode: typeof dragging.current, e: React.PointerEvent) => {
    dragging.current = mode;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const d = dragging.current;
    if (d === 'gamma') {
      update({ gamma: xToGamma(e.clientX) });
    } else {
      update({ [d]: xToVal(e.clientX, sliderAreaRef) });
    }
  }, [update, xToVal, xToGamma]);

  const handlePointerUp = useCallback(() => { dragging.current = null; }, []);

  const histSvg = histogram ? buildSvgHistogramPaths(histogram, histogramStyle, W, H) : null;

  const toX = (v: number) => `${(v / 255) * 100}%`;

  const chColor = CHANNELS.find((c) => c.key === channel)?.color ?? '#ccc';

  return (
    <div className="lev-panel" ref={sliderAreaRef}
      onPointerMove={handlePointerMove} onPointerUp={handlePointerUp}
    >
      {/* Channel tabs */}
      <div className="lev-tabs seg">
        {CHANNELS.map((c) => (
          <button key={c.key}
            className={`lev-tab seg-btn ${channel === c.key ? 'active' : ''}`}
            style={channel === c.key ? { color: c.color, borderBottomColor: c.color } : undefined}
            onClick={() => setChannel(c.key)}
          >{t(`adjustments.levels.channels.${c.key}`)}</button>
        ))}
      </div>

      {/* ─── Output slider row (ABOVE histogram) — triangles point DOWN ─── */}
      {(() => {
        const outBx = ch.outBlack / 255 * 100;
        const outWx = ch.outWhite / 255 * 100;
        const outMidX = (outBx + outWx) / 2;
        return (
          <div className="lev-slider-row">
            <span className="lev-val">{ch.outBlack}</span>
            <div className="lev-slider-track">
              <svg className="lev-line-svg" viewBox="0 0 100 14" preserveAspectRatio="none">
                <line x1={outBx} y1="7" x2={outMidX} y2="7" stroke={chColor} strokeWidth="0.5" strokeOpacity="0.4" vectorEffect="non-scaling-stroke" />
                <line x1={outMidX} y1="7" x2={outWx} y2="7" stroke={chColor} strokeWidth="0.5" strokeOpacity="0.4" vectorEffect="non-scaling-stroke" />
              </svg>
              <div className="lev-handle lev-handle-down" style={{ left: toX(ch.outBlack) }}
                onPointerDown={(e) => handlePointerDown('outBlack', e)}>
                <svg width="10" height="12" viewBox="0 0 10 12"><polygon points="5,12 10,0 0,0" fill="#111" stroke={chColor} strokeWidth="1" /></svg>
              </div>
              <div className="lev-handle lev-handle-down lev-handle-mid" style={{ left: `${outMidX}%` }}>
                <svg width="10" height="12" viewBox="0 0 10 12"><polygon points="5,12 10,0 0,0" fill="#888" stroke={chColor} strokeWidth="1" /></svg>
              </div>
              <div className="lev-handle lev-handle-down" style={{ left: toX(ch.outWhite) }}
                onPointerDown={(e) => handlePointerDown('outWhite', e)}>
                <svg width="10" height="12" viewBox="0 0 10 12"><polygon points="5,12 10,0 0,0" fill="#fff" stroke={chColor} strokeWidth="1" /></svg>
              </div>
            </div>
            <span className="lev-val">{ch.outWhite}</span>
          </div>
        );
      })()}

      {/* ─── Histogram ─── */}
      <div className="lev-hist-area">
        <svg viewBox={`0 0 ${W} ${H}`} className="lev-hist-svg" preserveAspectRatio="none">
          {histSvg && (
            <>
              {histSvg.fills.map((f, i) => (
                <path key={`f${i}`} d={f.d} fill={f.color} opacity={f.opacity}
                  style={f.blend ? { mixBlendMode: f.blend } : undefined} />
              ))}
              {histSvg.strokes.map((s, i) => <path key={`s${i}`} d={s.d} fill="none" stroke={s.color} opacity={s.opacity} strokeWidth={s.width} />)}
            </>
          )}
        </svg>
      </div>

      {/* ─── Input slider row (BELOW histogram) — triangles point UP ─── */}
      {(() => {
        const inBx = ch.inBlack / 255 * 100;
        const inWx = ch.inWhite / 255 * 100;
        // Gamma position: log-scale between inBlack and inWhite
        // gamma=1 → center, gamma>1 → left (darken mids), gamma<1 → right (brighten mids)
        const gammaOffset = -Math.log10(ch.gamma); // -1..1
        const inMidX = (inBx + inWx) / 2 + gammaOffset * (inWx - inBx) / 2;
        return (
          <div className="lev-slider-row">
            <span className="lev-val">{ch.inBlack}</span>
            <div className="lev-slider-track">
              <svg className="lev-line-svg" viewBox="0 0 100 14" preserveAspectRatio="none">
                <line x1={inBx} y1="7" x2={inMidX} y2="7" stroke={chColor} strokeWidth="0.5" strokeOpacity="0.4" vectorEffect="non-scaling-stroke" />
                <line x1={inMidX} y1="7" x2={inWx} y2="7" stroke={chColor} strokeWidth="0.5" strokeOpacity="0.4" vectorEffect="non-scaling-stroke" />
              </svg>
              <div className="lev-handle lev-handle-up" style={{ left: toX(ch.inBlack) }}
                onPointerDown={(e) => handlePointerDown('inBlack', e)}>
                <svg width="10" height="12" viewBox="0 0 10 12"><polygon points="5,0 10,12 0,12" fill="#111" stroke={chColor} strokeWidth="1" /></svg>
              </div>
              <div className="lev-handle lev-handle-up" style={{ left: `${inMidX}%` }}
                onPointerDown={(e) => handlePointerDown('gamma', e)}>
                <svg width="10" height="12" viewBox="0 0 10 12"><polygon points="5,0 10,12 0,12" fill="#888" stroke={chColor} strokeWidth="1" /></svg>
              </div>
              <div className="lev-handle lev-handle-up" style={{ left: toX(ch.inWhite) }}
                onPointerDown={(e) => handlePointerDown('inWhite', e)}>
                <svg width="10" height="12" viewBox="0 0 10 12"><polygon points="5,0 10,12 0,12" fill="#fff" stroke={chColor} strokeWidth="1" /></svg>
              </div>
            </div>
            <span className="lev-val">{ch.inWhite}</span>
          </div>
        );
      })()}
    </div>
  );
}
