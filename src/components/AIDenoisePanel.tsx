import { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdjustments } from '../contexts/AdjustmentsContext';
import { useEditor } from '../contexts/EditorContext';
import { CompactSlider as Slider } from '../ui/CompactSlider';
import { runAIDenoise, DENOISE_MODELS } from '../engine/ai/denoise';

export interface AIDenoisePanelProps {
  /** Pipeline hook callbacks. Passed through PhotoEditor → ToolPanelProps. */
  setCleanPreview?: (data: Float32Array | Uint8Array, w: number, h: number) => void;
  clearCleanPreview?: () => void;
  /** Whether the pipeline currently has a `u_clean` texture uploaded.
   *  Used to detect "persisted state says enabled but no actual clean
   *  preview in WebGL right now" — common after photo switch. */
  hasCleanPreview?: () => boolean;
  /** False while the render engine cannot composite the clean preview
   *  (graph engine pre-aiDenoiseMix). Renders a "not available" note
   *  instead of controls that would silently do nothing. */
  mixSupported?: boolean;
  /** Force the editor to redraw after the clean texture is uploaded. */
  onRequestRender?: () => void;
}

type Status = 'idle' | 'loading-model' | 'processing' | 'ready' | 'error';

export function AIDenoisePanel({ setCleanPreview, clearCleanPreview, hasCleanPreview, mixSupported = true, onRequestRender }: AIDenoisePanelProps) {
  const { t } = useTranslation();
  const { adjustments, set } = useAdjustments();
  const { displayUrl } = useEditor();
  const [status, setStatus] = useState<Status>('idle');
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Track which displayUrl the current clean preview was generated for.
  // When displayUrl changes (photo switch / new layer base) we invalidate
  // the pipeline's u_clean texture so the slider doesn't blend stale
  // pixels from the previous image.
  const cleanForUrlRef = useRef<string | null>(null);

  const apply = useCallback(async () => {
    if (!displayUrl || !setCleanPreview) return;
    setErrorMsg(null);
    setProgress(0);
    abortRef.current = new AbortController();

    try {
      // 1. Decode source to Float32 RGBA in linear [0,1].
      // For SDR sources we treat sRGB pixels as-is (model trained on sRGB).
      // RAW/HDR-linear sources would need their own path — Phase 4.
      setStatus('loading-model');
      const img = await loadImageBitmap(displayUrl);
      // Cap input resolution so the worker's float32 buffers (3-4 of them
      // at width*height*4) don't crash the browser tab on large source
      // images. A 24 MP JPEG would otherwise allocate ~1.2 GB peak
      // (decoded f32 + accum + wAccum + out). 2560 long-edge → ~150 MB.
      // The mix shader samples u_clean with v_texCoord in [0,1], so the
      // smaller clean texture is bilinearly upscaled when applied — the
      // user gets denoised pixels at slightly lower spatial precision,
      // not a corrupted image.
      const MAX_DENOISE_LONG_EDGE = 2560;
      const srcLong = Math.max(img.width, img.height);
      const scale = srcLong > MAX_DENOISE_LONG_EDGE ? MAX_DENOISE_LONG_EDGE / srcLong : 1;
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('No 2D context');
      ctx.drawImage(img, 0, 0, w, h);
      img.close();
      const imageData = ctx.getImageData(0, 0, w, h);
      const f32 = new Float32Array(w * h * 4);
      for (let i = 0; i < f32.length; i++) f32[i] = imageData.data[i] / 255;

      setStatus('processing');
      const result = await runAIDenoise({
        modelId: adjustments.aiDenoiseModelId as keyof typeof DENOISE_MODELS,
        pixels: f32,
        width: w,
        height: h,
        signal: abortRef.current.signal,
        onProgress: (stage, fraction) => {
          if (stage === 'model-download') {
            setStatus('loading-model');
            setProgress(fraction);
          } else {
            setStatus('processing');
            setProgress(fraction);
          }
        },
      });

      try {
        setCleanPreview(result.pixels, result.width, result.height);
      } catch (e) {
        // Most common: pipeline size doesn't match our preview (e.g. the
        // pipeline was set up with a downscaled image but we decoded the
        // full-size displayUrl). Surface as a user-visible error rather
        // than silently leaving the slider non-functional.
        throw new Error(`Pipeline size mismatch: ${e instanceof Error ? e.message : String(e)}`);
      }
      cleanForUrlRef.current = displayUrl;
      set('aiDenoiseEnabled', true);
      onRequestRender?.();
      setStatus('ready');
      setProgress(1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('abort')) {
        setStatus('idle');
      } else {
        setErrorMsg(msg);
        setStatus('error');
      }
    } finally {
      abortRef.current = null;
    }
  }, [displayUrl, setCleanPreview, adjustments.aiDenoiseModelId, set, onRequestRender]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // Track the displayUrl from the PREVIOUS render so we only invalidate
  // when it genuinely transitions (vs the apply-completion re-renders
  // that flip status/adjustments alongside an unchanged URL). The
  // cleanForUrlRef closure-staleness issue (apply captures old URL,
  // photo-change effect then sees ref != prop and wipes) is avoided
  // by NOT using the cleanForUrlRef as the comparison anchor.
  const prevDisplayUrlRef = useRef<string | null>(displayUrl);
  useEffect(() => {
    const prev = prevDisplayUrlRef.current;
    prevDisplayUrlRef.current = displayUrl;
    if (prev === null || prev === displayUrl) return;
    // Don't interrupt an in-flight apply — the result is for the OLD
    // photo and will be discarded when status flips after completion.
    if (status === 'loading-model' || status === 'processing') return;
    // Actual photo change: drop the stale u_clean texture.
    clearCleanPreview?.();
    cleanForUrlRef.current = null;
    if (status === 'ready') setStatus('idle');
  }, [displayUrl, clearCleanPreview, status]);

  // Sync panel status with the photo's persisted `aiDenoiseEnabled` only
  // when transitioning OUT of 'ready' (persisted flag cleared, e.g. undo
  // or preset reset). Do NOT auto-flip TO 'ready' from this effect —
  // that path goes through apply() which uploads u_clean atomically.
  // The previous version's "flip to ready when flag+texture both true"
  // raced with apply()'s own setStatus and could flicker.
  useEffect(() => {
    if (status === 'loading-model' || status === 'processing') return;
    if (status !== 'ready') return;
    const flagOn = !!adjustments.aiDenoiseEnabled;
    const havePreview = hasCleanPreview?.() ?? false;
    if (!flagOn || !havePreview) setStatus('idle');
  }, [adjustments.aiDenoiseEnabled, hasCleanPreview, status]);

  const reset = useCallback(() => {
    clearCleanPreview?.();
    cleanForUrlRef.current = null;
    set('aiDenoiseEnabled', false);
    setStatus('idle');
    setProgress(0);
    onRequestRender?.();
  }, [clearCleanPreview, set, onRequestRender]);

  const modelDesc = DENOISE_MODELS[adjustments.aiDenoiseModelId];
  const sizeLabel = modelDesc ? `${modelDesc.sizeMB} MB` : '';
  const busy = status === 'loading-model' || status === 'processing';

  if (!mixSupported) {
    return (
      <div className="ai-denoise-panel" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border, #333)' }}>
        <div style={{ fontWeight: 600, fontSize: 12 }}>{t('uiShell.toolPanels.aiDenoise')}</div>
        <div style={{ fontSize: 11, opacity: 0.7 }}>{t('uiShell.toolPanels.aiDenoiseUnavailable')}</div>
      </div>
    );
  }

  return (
    <div className="ai-denoise-panel" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border, #333)' }}>
      <div style={{ fontWeight: 600, fontSize: 12 }}>{t('uiShell.toolPanels.aiDenoise')}</div>

      <select
        value={adjustments.aiDenoiseModelId}
        onChange={(e) => set('aiDenoiseModelId', e.target.value)}
        disabled={busy || status === 'ready'}
        style={{ fontSize: 11 }}
      >
        {Object.values(DENOISE_MODELS).map((m) => (
          <option key={m.id} value={m.id}>{m.label} ({m.sizeMB} MB)</option>
        ))}
      </select>

      {status === 'idle' && (
        <button onClick={apply} disabled={!displayUrl} style={{ fontSize: 11 }}>
          {t('uiShell.toolPanels.aiDenoiseApply')} ({sizeLabel})
        </button>
      )}
      {busy && (
        <>
          <div style={{ fontSize: 11 }}>
            {status === 'loading-model' ? t('uiShell.toolPanels.aiDenoiseDownloading') : t('uiShell.toolPanels.aiDenoiseProcessing')}
            {' '}{Math.round(progress * 100)}%
          </div>
          <progress value={progress} max={1} style={{ width: '100%' }} />
          <button onClick={cancel} style={{ fontSize: 11 }}>
            {t('uiShell.toolPanels.aiDenoiseCancel')}
          </button>
        </>
      )}
      {status === 'ready' && (
        <>
          <Slider
            label={t('uiShell.toolPanels.aiDenoiseStrength')}
            value={adjustments.aiDenoiseStrength}
            min={0}
            max={100}
            onChange={(v) => set('aiDenoiseStrength', v)}
          />
          <button onClick={reset} style={{ fontSize: 11 }}>
            {t('uiShell.toolPanels.aiDenoiseReset')}
          </button>
        </>
      )}
      {status === 'error' && (
        <>
          <div style={{ fontSize: 11, color: 'var(--error, #f88)' }}>{errorMsg}</div>
          <button onClick={() => setStatus('idle')} style={{ fontSize: 11 }}>
            {t('uiShell.toolPanels.aiDenoiseRetry')}
          </button>
        </>
      )}
    </div>
  );
}

async function loadImageBitmap(url: string): Promise<ImageBitmap> {
  const res = await fetch(url);
  const blob = await res.blob();
  return createImageBitmap(blob);
}
