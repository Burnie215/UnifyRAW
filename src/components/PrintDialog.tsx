import { useState, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type PrintSettings, type PrintImage, DEFAULT_PRINT_SETTINGS,
  PAPER_SIZES, PRINT_LAYOUTS,
  renderPrintPage, calculateCells, paginatePrintImages,
} from '../engine/PrintEngine';
import {
  DEFAULT_PRINT_RESOLUTION, deliveredNativeLongEdge, deliveredNativePixels,
  estimatePrintMemory, formatPrintBytes, printRenderLongEdge,
  type PrintResolutionMode,
} from '../engine/printResolution';
import { sourceManager } from '../sources';
import { isLocalRawSourceType } from '../engine/raw/sourcePolicy';
import { RawDecoder } from '../engine/RawDecoder';
import type { RenderedFrame } from '../engine/Exporter';
import type { PrintTarget } from '../hooks/useDialogState';
import type { PhotoView } from '../storage/repos';
import './PrintDialog.css';

interface PrintDialogProps {
  open: boolean;
  onClose: () => void;
  targets: PrintTarget[];
  /** The one render stage, per photo. `maxLongEdge` bounds the rendered frame;
   *  null asks for the photo's native pixels. Rejects if it cannot be rendered. */
  renderTarget: (photo: PhotoView, maxLongEdge: number | null) => Promise<RenderedFrame>;
}

function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Canvas PNG encoding failed'));
    }, 'image/png');
  });
}

function loadPrintImage(img: HTMLImageElement, url: string): Promise<void> {
  return new Promise((resolve) => {
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = url;
  });
}

export function PrintDialog({ open, onClose, targets, renderTarget }: PrintDialogProps) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<PrintSettings>({ ...DEFAULT_PRINT_SETTINGS });
  const [resolution, setResolution] = useState<PrintResolutionMode>(DEFAULT_PRINT_RESOLUTION);
  const [printing, setPrinting] = useState(false);
  /** One entry per target, in target order; null = render failed. */
  const [frames, setFrames] = useState<(RenderedFrame | null)[] | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [failed, setFailed] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);

  // Held in a ref, not a dependency: the renderer closes over the editor's
  // live adjustments, so depending on its identity would restart a
  // half-finished contact sheet every time the editor state moves.
  const renderRef = useRef(renderTarget);
  useEffect(() => { renderRef.current = renderTarget; }, [renderTarget]);

  const set = <K extends keyof PrintSettings>(key: K, value: PrintSettings[K]) =>
    setSettings((prev) => ({ ...prev, [key]: value }));

  // The cells are all the same size, so the first one says what any photo on
  // this page gets to show.
  const cell = useMemo(() => calculateCells(settings)[0] ?? { width: 0, height: 0 }, [settings]);
  const cellLongEdge = printRenderLongEdge('cell', cell, settings.dpi) ?? 0;
  const renderLongEdge = resolution === 'native' ? null : cellLongEdge;

  /**
   * What "native" delivers here. A RAW from a backend-decoded source comes
   * back through /api/raw/smart-preview and is capped there, so the choice is
   * two different resolutions depending on the source. The dialog names the
   * capped one and counts memory with it instead of promising the sensor's
   * pixels for photos that will not get them.
   */
  const nativeDelivery = useMemo(() => targets.map((target) => {
    const localRaw = !RawDecoder.isRawFile(target.photo.name)
      || isLocalRawSourceType(sourceManager.get(target.photo.sourceId)?.type);
    return {
      photo: deliveredNativePixels(target.photo, localRaw),
      edge: deliveredNativeLongEdge(target.photo.width, target.photo.height, localRaw),
      capped: !localRaw
        && deliveredNativeLongEdge(target.photo.width, target.photo.height, false)
          !== deliveredNativeLongEdge(target.photo.width, target.photo.height, true),
    };
  }), [targets]);
  const cappedNativeEdge = nativeDelivery.find((d) => d.capped)?.edge ?? null;

  const memory = useMemo(
    () => estimatePrintMemory(
      resolution === 'native'
        ? nativeDelivery.map((d) => d.photo)
        : targets.map((target) => target.photo),
      renderLongEdge,
    ),
    [targets, nativeDelivery, resolution, renderLongEdge],
  );

  // Render every photo ONCE, when the dialog opens, and again only when the
  // RESOLUTION moves - not when any other setting does. Sequentially, because
  // a RAW costs a decode per photo; in parallel that is 35 decoders at once.
  useEffect(() => {
    if (!open) {
      setFrames(null);
      setFailed([]);
      setProgress({ done: 0, total: 0 });
      return;
    }
    let cancelled = false;
    setFrames(null);
    setFailed([]);
    setError(null);
    setProgress({ done: 0, total: targets.length });

    void (async () => {
      const rendered: (RenderedFrame | null)[] = [];
      const missing: string[] = [];
      for (const target of targets) {
        if (cancelled) return;
        try {
          rendered.push(await renderRef.current(target.photo, renderLongEdge));
        } catch (e) {
          // One unrenderable photo must not take the page with it (F071).
          console.error(`[print] render failed for ${target.name}:`, e);
          rendered.push(null);
          missing.push(target.name);
        }
        if (!cancelled) setProgress({ done: rendered.length, total: targets.length });
      }
      if (cancelled) return;
      setFrames(rendered);
      setFailed(missing);
    })();

    return () => { cancelled = true; };
  }, [open, targets, renderLongEdge]);

  const images = useMemo<PrintImage[] | null>(
    () => (frames ? targets.map((target, i) => ({ name: target.name, frame: frames[i] ?? null })) : null),
    [targets, frames],
  );

  const pages = useMemo(
    () => (images ? paginatePrintImages(images, settings) : null),
    [images, settings],
  );

  // Preview (low DPI): the first sheet. Settings only re-lay-out - the frames
  // stay as they are.
  useEffect(() => {
    if (!open || !pages || pages.length === 0) return;
    try {
      const canvas = renderPrintPage(pages[0], { ...settings, dpi: 72 });
      const preview = previewRef.current;
      if (!preview) return;
      preview.width = canvas.width;
      preview.height = canvas.height;
      preview.getContext('2d')!.drawImage(canvas, 0, 0);
    } catch (e) {
      console.error('[print] preview failed:', e);
      setError(t('dialogs.print.renderFailed'));
    }
  }, [open, pages, settings, t]);

  const handlePrint = async () => {
    if (!pages || pages.length === 0) return;
    setPrinting(true);
    try {
      // Open print window
      const win = window.open('', '_blank');
      if (!win) { setError(t('dialogs.print.popupBlocked')); return; }

      const pw = settings.orientation === 'landscape' ? settings.paper.height : settings.paper.width;
      const ph = settings.orientation === 'landscape' ? settings.paper.width : settings.paper.height;

      win.document.write(`<!DOCTYPE html><html><head><title>${t('dialogs.print.documentTitle')}</title>
        <style>
          @page { size: ${pw}mm ${ph}mm; margin: 0; }
          body { margin: 0; padding: 0; }
          .print-page { width: ${pw}mm; height: ${ph}mm; overflow: hidden; }
          .print-page + .print-page { page-break-before: always; break-before: page; }
          .print-page img { display: block; width: 100%; height: 100%; object-fit: contain; }
          @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
        </style>
      </head><body></body></html>`);

      for (const page of pages) {
        const sheet = win.document.createElement('div');
        sheet.className = 'print-page';
        const img = win.document.createElement('img');
        sheet.appendChild(img);
        win.document.body.appendChild(sheet);

        // Encode and load one page at a time. The object URL only has to live
        // until the image has decoded; revoking it before encoding the next
        // sheet prevents a many-page job from retaining every PNG payload.
        const blob = await canvasPng(renderPrintPage(page, settings));
        const url = URL.createObjectURL(blob);
        try {
          await loadPrintImage(img, url);
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      win.print();
      win.close();
    } catch (e) {
      console.error('[print] page render failed:', e);
      setError(t('dialogs.print.renderFailed'));
    } finally {
      setPrinting(false);
    }
  };

  if (!open) return null;

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog print-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h3>{targets.length === 1 ? t('dialogs.print.titlePhoto', { count: targets.length }) : t('dialogs.print.titlePhotos', { count: targets.length })}</h3>
          <button className="dialog-close" onClick={onClose}>&times;</button>
        </div>

        <div className="print-body">
          {/* Preview */}
          <div className="print-preview">
            <canvas ref={previewRef} className="print-preview-canvas" />
            <div className="print-preview-info">
              {settings.paper.label} · {settings.orientation === 'portrait' ? t('dialogs.print.portrait') : t('dialogs.print.landscape')} · {settings.dpi} DPI
            </div>
            {!images && (
              <div className="print-preview-progress">
                {t('dialogs.print.rendering', { done: progress.done, total: progress.total })}
              </div>
            )}
            {failed.length > 0 && (
              <div className="print-preview-failed">
                {t('dialogs.print.notRendered', { names: failed.join(', ') })}
              </div>
            )}
            {error && <div className="print-preview-failed">{error}</div>}
          </div>

          {/* Settings */}
          <div className="print-settings">
            {/* Paper */}
            <div className="print-row">
              <label>{t('dialogs.print.paperFormat')}</label>
              <select value={settings.paper.id} onChange={(e) => {
                const p = PAPER_SIZES.find((s) => s.id === e.target.value);
                if (p) set('paper', p);
              }}>
                {PAPER_SIZES.map((p) => <option key={p.id} value={p.id}>{p.label} ({p.width}×{p.height}mm)</option>)}
              </select>
            </div>

            {/* Orientation */}
            <div className="print-row">
              <label>{t('dialogs.print.orientation')}</label>
              <div className="print-btn-group">
                <button className={settings.orientation === 'portrait' ? 'active' : ''} onClick={() => set('orientation', 'portrait')}>{t('dialogs.print.portrait')}</button>
                <button className={settings.orientation === 'landscape' ? 'active' : ''} onClick={() => set('orientation', 'landscape')}>{t('dialogs.print.landscape')}</button>
              </div>
            </div>

            {/* Layout */}
            <div className="print-row">
              <label>{t('dialogs.print.layout')}</label>
              <select value={settings.layout.id} onChange={(e) => {
                const l = PRINT_LAYOUTS.find((s) => s.id === e.target.value);
                if (l) set('layout', l);
              }}>
                {PRINT_LAYOUTS.map((l) => <option key={l.id} value={l.id}>{t(l.labelKey)}</option>)}
              </select>
            </div>

            {/* DPI */}
            <div className="print-row">
              <label>{t('dialogs.print.resolution')}</label>
              <select value={settings.dpi} onChange={(e) => set('dpi', Number(e.target.value))}>
                <option value={150}>{t('dialogs.print.dpiDraft')}</option>
                <option value={300}>{t('dialogs.print.dpiStandard')}</option>
                <option value={600}>{t('dialogs.print.dpiHigh')}</option>
              </select>
            </div>

            {/* Image resolution */}
            <div className="print-row">
              <label>{t('dialogs.print.imageResolution')}</label>
              <select value={resolution} onChange={(e) => setResolution(e.target.value as PrintResolutionMode)}>
                <option value="cell">{t('dialogs.print.resolutionCell', { px: cellLongEdge })}</option>
                <option value="native">
                  {cappedNativeEdge === null
                    ? t('dialogs.print.resolutionNative')
                    : t('dialogs.print.resolutionNativeCapped', { px: cappedNativeEdge })}
                </option>
              </select>
              <div className="print-resolution-hint">
                {memory.totalBytes > 0 && t('dialogs.print.memoryHint', {
                  total: formatPrintBytes(memory.totalBytes),
                  largest: formatPrintBytes(memory.largestBytes),
                  photos: targets.length - memory.unknown,
                })}
                {memory.unknown > 0 && ` ${t('dialogs.print.memoryUnknown', { photos: memory.unknown })}`}
              </div>
            </div>

            {/* Margins */}
            <div className="print-row">
              <label>{t('dialogs.print.margins')}</label>
              <div className="print-margins">
                <input type="number" value={settings.margins.top} min={0} max={50}
                  onChange={(e) => set('margins', { ...settings.margins, top: Number(e.target.value) })} placeholder={t('dialogs.print.top')} />
                <input type="number" value={settings.margins.left} min={0} max={50}
                  onChange={(e) => set('margins', { ...settings.margins, left: Number(e.target.value) })} placeholder={t('dialogs.print.left')} />
                <input type="number" value={settings.margins.right} min={0} max={50}
                  onChange={(e) => set('margins', { ...settings.margins, right: Number(e.target.value) })} placeholder={t('dialogs.print.right')} />
                <input type="number" value={settings.margins.bottom} min={0} max={50}
                  onChange={(e) => set('margins', { ...settings.margins, bottom: Number(e.target.value) })} placeholder={t('dialogs.print.bottom')} />
              </div>
            </div>

            {/* Sharpening */}
            <div className="print-row">
              <label>{t('dialogs.print.sharpening')}</label>
              <select value={settings.sharpen} onChange={(e) => set('sharpen', e.target.value as PrintSettings['sharpen'])}>
                <option value="none">{t('dialogs.print.sharpenNone')}</option>
                <option value="low">{t('dialogs.print.sharpenLow')}</option>
                <option value="standard">{t('dialogs.print.sharpenStandard')}</option>
                <option value="high">{t('dialogs.print.sharpenHigh')}</option>
              </select>
            </div>

            {/* Options */}
            <div className="print-row">
              <label className="print-checkbox">
                <input type="checkbox" checked={settings.showFilename}
                  onChange={(e) => set('showFilename', e.target.checked)} />
                <span>{t('dialogs.print.showFilename')}</span>
              </label>
            </div>

            {pages && pages.length > 1 && (
              <div className="print-pages-info">
                {t('dialogs.print.pagesFor', { pages: pages.length, photos: targets.length })}
              </div>
            )}

            <button className="dialog-submit" onClick={handlePrint} disabled={printing || !pages || pages.length === 0}>
              {printing || !images ? t('dialogs.print.preparing') : t('dialogs.print.print')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
