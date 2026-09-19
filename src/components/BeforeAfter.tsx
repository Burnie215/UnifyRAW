import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './BeforeAfter.css';

export type CompareMode = 'off' | 'side-by-side' | 'split' | 'toggle';

interface BeforeAfterProps {
  before: HTMLCanvasElement | null;
  after: HTMLCanvasElement | null;
  beforeGeneration: number;
  renderGeneration: number;
  proofFilter?: string;
  mode: CompareMode;
  onModeChange?: (mode: CompareMode) => void;
  zoom?: number;
}

function CanvasCopy({ source, generation, surface, label, className = '', style }: {
  source: HTMLCanvasElement | null;
  generation: number;
  surface: 'before' | 'after';
  label: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const target = ref.current;
    if (!source || !target || source.width === 0 || source.height === 0) return;
    target.width = source.width;
    target.height = source.height;
    const context = target.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, target.width, target.height);
    context.drawImage(source, 0, 0);
  }, [source, generation]);

  return <canvas ref={ref} aria-label={label} data-compare-surface={surface} data-compare-generation={generation}
    className={`ba-canvas ${className}`} style={style} />;
}

export function BeforeAfter({ before, after, beforeGeneration, renderGeneration, proofFilter = '', mode, onModeChange, zoom }: BeforeAfterProps) {
  const { t } = useTranslation();
  const [splitPos, setSplitPos] = useState(50);
  const [showOriginal, setShowOriginal] = useState(false);
  const splitPointer = useRef<number | null>(null);

  const handlePointerDown = useCallback((event: React.PointerEvent) => {
    event.stopPropagation();
    splitPointer.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);
  const handlePointerMove = useCallback((event: React.PointerEvent) => {
    if (splitPointer.current !== event.pointerId) return;
    event.stopPropagation();
    const rect = event.currentTarget.parentElement!.getBoundingClientRect();
    setSplitPos(Math.max(5, Math.min(95, ((event.clientX - rect.left) / rect.width) * 100)));
  }, []);
  const handlePointerUp = useCallback((event: React.PointerEvent) => {
    if (splitPointer.current !== event.pointerId) return;
    event.stopPropagation();
    splitPointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  if (mode === 'side-by-side') {
    return <div className="ba-side-by-side">
      <div className="ba-half"><CanvasCopy source={before} generation={beforeGeneration} surface="before" label={t('compare.before')} /><span className="ba-label">{t('compare.before')}</span></div>
      <div className="ba-half"><CanvasCopy source={after} generation={renderGeneration} surface="after" label={t('compare.after')} style={{ filter: proofFilter }} /><span className="ba-label">{t('compare.after')}</span></div>
      <CompareModeBar mode={mode} onModeChange={onModeChange} zoom={zoom} />
    </div>;
  }

  if (mode === 'split') {
    return <div className="ba-split">
      <CanvasCopy source={after} generation={renderGeneration} surface="after" label={t('compare.after')} className="ba-after" style={{ filter: proofFilter }} />
      <CanvasCopy source={before} generation={beforeGeneration} surface="before" label={t('compare.before')} className="ba-before" style={{ clipPath: `inset(0 ${100 - splitPos}% 0 0)` }} />
      <div className="ba-divider" style={{ left: `${splitPos}%` }} onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp}>
        <div className="ba-divider-line" /><div className="ba-divider-handle" />
      </div>
      <span className="ba-label ba-label-left">{t('compare.before')}</span><span className="ba-label ba-label-right">{t('compare.after')}</span>
      <CompareModeBar mode={mode} onModeChange={onModeChange} zoom={zoom} />
    </div>;
  }

  if (mode === 'toggle') {
    const source = showOriginal ? before : after;
    return <div className="ba-toggle" onClick={() => setShowOriginal(!showOriginal)}>
      <CanvasCopy source={source} generation={showOriginal ? beforeGeneration : renderGeneration} surface={showOriginal ? 'before' : 'after'} label={showOriginal ? t('compare.before') : t('compare.after')} style={showOriginal ? undefined : { filter: proofFilter }} />
      <span className="ba-label">{showOriginal ? t('compare.before') : t('compare.after')}</span>
      <CompareModeBar mode={mode} onModeChange={onModeChange} zoom={zoom} />
    </div>;
  }
  return null;
}

function CompareModeBar({ mode, onModeChange, zoom }: { mode: CompareMode; onModeChange?: (mode: CompareMode) => void; zoom?: number }) {
  const { t } = useTranslation();
  if (!onModeChange) return null;
  return <div className="ba-mode-bar">
    <div className="ba-mode-btns">
      <button className={`ba-mode-btn ${mode === 'split' ? 'active' : ''}`} onClick={() => onModeChange('split')} title={t('compare.split')}><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="1" y="1" width="12" height="12" rx="2" /><line x1="7" y1="1" x2="7" y2="13" /></svg></button>
      <button className={`ba-mode-btn ${mode === 'side-by-side' ? 'active' : ''}`} onClick={() => onModeChange('side-by-side')} title={t('compare.sideBySide')}><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="1" y="1" width="5" height="12" rx="1" /><rect x="8" y="1" width="5" height="12" rx="1" /></svg></button>
      <button className={`ba-mode-btn ${mode === 'toggle' ? 'active' : ''}`} onClick={() => onModeChange('toggle')} title={t('compare.toggle')}><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="1" y="1" width="12" height="12" rx="2" /><path d="M4 7h6M7 4v6" /></svg></button>
      <button className={`ba-mode-btn ${mode === 'off' ? 'active' : ''}`} onClick={() => onModeChange('off')} title={t('compare.off')}><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="1" y="1" width="12" height="12" rx="2" /></svg></button>
    </div>
    <span className="ba-mode-label">{t('compare.beforeAfter')}</span>
    {zoom !== undefined && <span className="ba-zoom-label">{Math.round(zoom * 100)}%</span>}
  </div>;
}
