import { useRef, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HistogramStyle } from '../types';
import { useSettings } from '../contexts/SettingsContext';
import { histogramFromCanvas, histogramFromUrl, drawHistogram } from '../image/histogram';
import { prepareCanvas } from '../image/hiDpiCanvas';
import { useResizeTick } from '../hooks/useResizeTick';
import './Histogram.css';

interface HistogramProps {
  imageUrl: string | null;
  renderedCanvas?: HTMLCanvasElement | null;
  renderGeneration?: number;
  histogramStyle?: HistogramStyle;
  onToggleShadowClipping?: () => void;
  onToggleHighlightClipping?: () => void;
  shadowClipping?: boolean;
  highlightClipping?: boolean;
}

const W = 228;
const H = 80;

export function Histogram({
  imageUrl, renderedCanvas, renderGeneration, histogramStyle: histogramStyleOverride,
  onToggleShadowClipping, onToggleHighlightClipping,
  shadowClipping, highlightClipping,
}: HistogramProps) {
  const { t } = useTranslation();
  const { histogramStyle: configuredHistogramStyle } = useSettings();
  const histogramStyle = histogramStyleOverride ?? configuredHistogramStyle;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  // CSS stretches the canvas across the panel, so redraw when that width moves.
  const resizeTick = useResizeTick(canvasRef);

  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(async () => {
      const bins = renderedCanvas
        ? histogramFromCanvas(renderedCanvas)
        : imageUrl ? await histogramFromUrl(imageUrl) : null;
      if (!canvasRef.current) return;
      const context = prepareCanvas(canvasRef.current, W, H);
      // Bailing out without clearing left the PREVIOUS photo's histogram on the
      // canvas — which is what a RAW selection used to show, because the raw
      // file cannot be decoded by an <img> and yields no bins at all.
      if (!bins) {
        context.clearRect(0, 0, W, H);
        setUnavailable(true);
        return;
      }
      setUnavailable(false);
      drawHistogram(context, bins, W, H, histogramStyle);
    });
    return () => cancelAnimationFrame(rafRef.current);
  }, [renderedCanvas, renderGeneration, imageUrl, histogramStyle, resizeTick]);

  return (
    <div className="histogram">
      <canvas ref={canvasRef} width={W} height={H} className="histogram-canvas" />
      {unavailable && (
        <div className="histogram-unavailable">{t('adjustments.histogram.unavailable')}</div>
      )}
      <div className="histogram-indicators">
        <button className={`clip-indicator ${shadowClipping ? 'active' : ''}`} onClick={onToggleShadowClipping} title={t('adjustments.histogram.shadowClipping')}>
          <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><polygon points="0,8 4,0 8,8" /></svg>
        </button>
        <button className={`clip-indicator ${highlightClipping ? 'active' : ''}`} onClick={onToggleHighlightClipping} title={t('adjustments.histogram.highlightClipping')}>
          <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><polygon points="0,8 4,0 8,8" /></svg>
        </button>
      </div>
    </div>
  );
}
