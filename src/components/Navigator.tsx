import { useRef, useCallback, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { revokeBlobUrls } from '../platform/objectUrls';
import './Navigator.css';

interface NavigatorProps {
  imageUrl: string | null;
  zoom: number;
  panX: number;
  panY: number;
  /** Native→CSS ratio used by the editor to fit the image into the canvas
   *  area. Display % = fitScale × zoom × 100. Required so the navigator
   *  label can match the toolbar's percentage. */
  fitScale: number;
  /** CSS-displayed size of the image (after fit) */
  displayW: number;
  displayH: number;
  onPanChange: (x: number, y: number) => void;
  onZoomChange: (z: number) => void;
  onOneToOne?: () => void;
  /** Rendered canvas for live preview */
  renderedCanvas?: HTMLCanvasElement | null;
  renderGeneration?: number;
}

export function Navigator({ imageUrl, zoom, panX, panY, fitScale, displayW, displayH, onPanChange, onZoomChange, onOneToOne, renderedCanvas, renderGeneration }: NavigatorProps) {
  const { t } = useTranslation();
  const navRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // The URL the preview is showing. State alone could not carry it: the
  // unmount cleanup closes over the FIRST render's value, which is null, so it
  // released nothing and every editor round left a preview blob behind (F060).
  const previewUrlRef = useRef<string | null>(null);

  // Update preview from rendered canvas
  useEffect(() => {
    if (!renderedCanvas || renderedCanvas.width === 0) return;
    let cancelled = false;
    try {
      const scale = Math.min(240 / renderedCanvas.width, 240 / renderedCanvas.height, 1);
      const w = Math.round(renderedCanvas.width * scale);
      const h = Math.round(renderedCanvas.height * scale);
      const off = new OffscreenCanvas(w, h);
      const ctx = off.getContext('2d')!;
      ctx.drawImage(renderedCanvas, 0, 0, w, h);
      off.convertToBlob({ type: 'image/jpeg', quality: 0.6 }).then((blob) => {
        if (cancelled) return;
        const previous = previewUrlRef.current;
        previewUrlRef.current = URL.createObjectURL(blob);
        setPreviewUrl(previewUrlRef.current);
        revokeBlobUrls([previous]);
      });
    } catch { /* */ }
    return () => { cancelled = true; };
  }, [renderedCanvas, renderGeneration]);

  // Cleanup
  useEffect(() => () => {
    revokeBlobUrls([previewUrlRef.current]);
    previewUrlRef.current = null;
  }, []);

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (!navRef.current || !imgRef.current || zoom <= 1) return;
    const imgRect = imgRef.current.getBoundingClientRect();

    // Click as fraction of navigator image (0..1)
    const fracX = (e.clientX - imgRect.left) / imgRect.width;
    const fracY = (e.clientY - imgRect.top) / imgRect.height;

    // Convert to pan: offset from center, in CSS pixels
    const newPanX = -(fracX - 0.5) * displayW * zoom;
    const newPanY = -(fracY - 0.5) * displayH * zoom;
    onPanChange(newPanX, newPanY);
  }, [zoom, displayW, displayH, onPanChange]);

  // Viewport: fraction of image visible per axis
  // displayW/displayH = CSS size of image at zoom=1 (after fit). At zoom>1 we see displayW/zoom of image.
  // But the viewport percentage is relative to the image, so it's simply 1/zoom (when displayW fills the nav).
  const vpW = zoom > 1 ? Math.min(100, 100 / zoom) : 100;
  const vpH = zoom > 1 ? Math.min(100, 100 / zoom) : 100;
  // Pan as fraction: panX is CSS-pixels offset. The total pannable range is displayW*(zoom-1).
  // Pan fraction of image = panX / (displayW * zoom) where displayW = image CSS size at fit.
  const panFracX = displayW > 0 ? panX / (displayW * zoom) : 0;
  const panFracY = displayH > 0 ? panY / (displayH * zoom) : 0;
  const vpX = 50 - vpW / 2 - panFracX * 100;
  const vpY = 50 - vpH / 2 - panFracY * 100;

  return (
    <div className="navigator">
      <div className="navigator-preview" ref={navRef} onClick={handleClick}>
        {(previewUrl || imageUrl) && <img ref={imgRef} src={previewUrl ?? imageUrl!} alt="" className="navigator-img" />}
        {zoom > 1 && (
          <div
            className="navigator-viewport"
            style={{
              width: `${vpW}%`,
              height: `${vpH}%`,
              left: `${Math.max(0, Math.min(100 - vpW, vpX))}%`,
              top: `${Math.max(0, Math.min(100 - vpH, vpY))}%`,
            }}
          />
        )}
      </div>
      <div className="navigator-controls">
        <button className="nav-zoom-btn" onClick={() => onZoomChange(1)} title={t('adjustments.navigator.fit')}>{t('adjustments.navigator.fit')}</button>
        <button className="nav-zoom-btn" onClick={() => { if (onOneToOne) onOneToOne(); }} title={t('adjustments.navigator.oneToOne')}>1:1</button>
        {/* +/− step by display-percentage (~25 %) and back-convert to zoom,
            so the navigator label changes by a perceivable amount on every
            click instead of dragging through tiny zoom deltas at small
            fitScale. Clamped to [1, 8] zoom range as before. */}
        <button
          className="nav-zoom-btn"
          onClick={() => {
            const curDisp = (fitScale > 0 ? fitScale : 1) * zoom;
            const next = Math.max(fitScale, curDisp - 0.25);
            onZoomChange(Math.max(1, Math.min(8, next / (fitScale || 1))));
          }}
          title={t('adjustments.navigator.zoomOut')}
        >−</button>
        <span className="nav-zoom-level">{Math.round(fitScale * zoom * 100)}%</span>
        <button
          className="nav-zoom-btn"
          onClick={() => {
            const curDisp = (fitScale > 0 ? fitScale : 1) * zoom;
            const next = curDisp + 0.25;
            onZoomChange(Math.max(1, Math.min(8, next / (fitScale || 1))));
          }}
          title={t('adjustments.navigator.zoomIn')}
        >+</button>
      </div>
    </div>
  );
}
