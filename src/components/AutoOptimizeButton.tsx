import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Adjustments } from '../types';
import type { RawPixelData } from '../engine/raw/RawDecoderStrategy';
import { extensionOf } from '../data/rawPairing';
import './AutoOptimizeButton.css';

/** The camera JPEG the RAW can be optimized towards. */
export interface MatchReference {
  name: string;
  resolveUrl: () => Promise<string | null>;
}

interface AutoOptimizeButtonProps {
  imageUrl: string | null;
  isRaw?: boolean;
  adjustments: Adjustments;
  onChange: (adj: Adjustments) => void;
  /**
   * Present only for the RAW half of a RAW+JPEG pair: splits the button, and
   * the right half matches the RAW to that sibling instead of to the generic
   * histogram ideal.
   */
  matchReference?: MatchReference | null;
  /**
   * The decoded 16-bit RAW, when there is one. Both modes analyse its neutral
   * render rather than `imageUrl`: the preview JPEG behind `imageUrl` skips
   * the as-shot white balance the editor applies, so measuring it hands the
   * sliders a correction the render does not need. See
   * {@link ../engine/raw/neutralRender}.
   */
  rawPixels?: RawPixelData | null;
}

/** Analysis resolution — enough for stable statistics, small enough to be instant. */
const SAMPLE_MAX_DIM = 400;
/** How long a failed analysis stays marked on the button. */
const FAILURE_NOTICE_MS = 4000;

/** Only the pixel buffer is ever used downstream, so both analysis sources
 *  return this rather than a full ImageData. */
interface AnalysisPixels { data: Uint8ClampedArray }

async function samplePixels(url: string): Promise<AnalysisPixels> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = reject;
    img.src = url;
  });

  const scale = Math.min(SAMPLE_MAX_DIM / img.width, SAMPLE_MAX_DIM / img.height, 1);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/** Analysis pixels: the neutral RAW render when we have the RAW, else the
 *  displayed image, which for non-RAW sources is what the editor renders. */
async function analysisPixels(
  url: string, raw: RawPixelData | null | undefined,
): Promise<AnalysisPixels> {
  if (raw) {
    const { neutralRawRender } = await import('../engine/raw/neutralRender');
    const rendered = neutralRawRender(raw, SAMPLE_MAX_DIM);
    if (rendered) return { data: rendered.pixels };
  }
  return samplePixels(url);
}

export function AutoOptimizeButton({ imageUrl, isRaw = false, adjustments, onChange, matchReference, rawPixels }: AutoOptimizeButtonProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<'auto' | 'match' | null>(null);
  // A reference the browser refuses to read (CORS-tainted canvas, undecodable
  // sibling) fails deep inside an async chain — without this the button would
  // just do nothing and leave the user guessing.
  const [failed, setFailed] = useState<'auto' | 'match' | null>(null);
  const failureTimer = useRef<number | null>(null);

  const markFailed = useCallback((mode: 'auto' | 'match') => {
    setFailed(mode);
    if (failureTimer.current) clearTimeout(failureTimer.current);
    failureTimer.current = window.setTimeout(() => setFailed(null), FAILURE_NOTICE_MS);
  }, []);

  useEffect(() => () => { if (failureTimer.current) clearTimeout(failureTimer.current); }, []);

  const handleAuto = useCallback(async () => {
    if (!imageUrl || busy) return;
    setBusy('auto');
    setFailed(null);
    try {
      const { histogramFromPixels } = await import('../image/histogram');
      const { autoOptimize, applyAutoResult } = await import('../engine/AutoOptimizer');

      // Source pixels — the neutral render, before any adjustment.
      const source = await analysisPixels(imageUrl, rawPixels);
      const result = autoOptimize(histogramFromPixels(source.data), source.data, { isRaw });
      onChange(applyAutoResult(adjustments, result));
    } catch (e) {
      console.error('Auto optimize failed:', e);
      markFailed('auto');
    } finally {
      setBusy(null);
    }
  }, [imageUrl, isRaw, rawPixels, adjustments, onChange, busy, markFailed]);

  const handleMatch = useCallback(async () => {
    if (!imageUrl || !matchReference || busy) return;
    setBusy('match');
    setFailed(null);
    try {
      const { histogramFromPixels } = await import('../image/histogram');
      const { matchToReference, applyAutoResult } = await import('../engine/AutoOptimizer');

      const referenceUrl = await matchReference.resolveUrl();
      if (!referenceUrl) throw new Error(`no display URL for ${matchReference.name}`);

      const [source, reference] = await Promise.all([
        analysisPixels(imageUrl, rawPixels),
        samplePixels(referenceUrl),
      ]);

      const result = matchToReference(
        { bins: histogramFromPixels(source.data), pixels: source.data },
        { bins: histogramFromPixels(reference.data), pixels: reference.data },
      );
      onChange(applyAutoResult(adjustments, result));
    } catch (e) {
      console.error('Match to reference failed:', e);
      markFailed('match');
    } finally {
      setBusy(null);
    }
  }, [imageUrl, matchReference, rawPixels, adjustments, onChange, busy, markFailed]);

  const icon = (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="M7 1v2M7 11v2M1 7h2M11 7h2M2.8 2.8l1.4 1.4M9.8 9.8l1.4 1.4M11.2 2.8l-1.4 1.4M4.2 9.8l-1.4 1.4" />
      <circle cx="7" cy="7" r="2.5" />
    </svg>
  );

  const autoButton = (
    <button className={`auto-optimize-btn${failed === 'auto' ? ' failed' : ''}`} onClick={handleAuto}
      disabled={busy !== null || !imageUrl}
      title={failed === 'auto' ? t('autoOptimize.failed') : t('autoOptimize.title')}>
      {icon}
      {busy === 'auto' ? t('autoOptimize.analyzing') : t('autoOptimize.button')}
    </button>
  );

  if (!matchReference) return autoButton;

  const referenceKind = (extensionOf(matchReference.name) || 'jpg').toUpperCase();

  return (
    <div className="auto-optimize-split">
      {autoButton}
      <button className={`auto-optimize-btn auto-optimize-btn--match${failed === 'match' ? ' failed' : ''}`}
        onClick={handleMatch} disabled={busy !== null || !imageUrl}
        title={failed === 'match' ? t('autoOptimize.failed') : t('autoOptimize.matchTitle', { name: matchReference.name })}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
          <rect x="1.5" y="3.5" width="7" height="7" rx="1" />
          <path d="M5.5 3.5V2.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" />
        </svg>
        {busy === 'match' ? '…' : referenceKind}
      </button>
    </div>
  );
}
