/**
 * Print Engine — page layout, rendering, and print preparation.
 *
 * Handles paper sizes, margins, DPI, layout templates,
 * print sharpening, and final canvas rendering for window.print().
 */

import { frameToCanvas, type RenderedFrame } from './Exporter';
import { mmToPx } from './printResolution';

// ─── Paper Sizes (mm) ──────────────────────────────────────────

export interface PaperSize {
  id: string;
  label: string;
  width: number;   // mm
  height: number;  // mm
}

export const PAPER_SIZES: PaperSize[] = [
  { id: 'a4', label: 'A4', width: 210, height: 297 },
  { id: 'a3', label: 'A3', width: 297, height: 420 },
  { id: 'a5', label: 'A5', width: 148, height: 210 },
  { id: 'letter', label: 'US Letter', width: 215.9, height: 279.4 },
  { id: 'legal', label: 'US Legal', width: 215.9, height: 355.6 },
  { id: '4x6', label: '10×15 cm', width: 102, height: 152 },
  { id: '5x7', label: '13×18 cm', width: 127, height: 178 },
  { id: '8x10', label: '20×25 cm', width: 203, height: 254 },
  { id: '11x14', label: '28×36 cm', width: 279, height: 356 },
  { id: 'square-20', label: '20×20 cm', width: 200, height: 200 },
];

// ─── Layout Templates ──────────────────────────────────────────

export type LayoutType = 'single' | 'contact-sheet' | 'grid-2x2' | 'grid-3x3' | 'custom';

export interface PrintLayout {
  id: LayoutType;
  /** The name the user reads, as an i18n key. The engine used to carry the
   *  German words ("Einzelbild", "Kontaktbogen") and the dialog printed them
   *  unchanged, so the English UI offered a German list. Translating belongs to
   *  the dialog; the engine only says which string it means. */
  labelKey: string;
  cols: number;
  rows: number;
}

export const PRINT_LAYOUTS: PrintLayout[] = [
  { id: 'single', labelKey: 'dialogs.print.layoutSingle', cols: 1, rows: 1 },
  { id: 'grid-2x2', labelKey: 'dialogs.print.layoutGrid2x2', cols: 2, rows: 2 },
  { id: 'grid-3x3', labelKey: 'dialogs.print.layoutGrid3x3', cols: 3, rows: 3 },
  { id: 'contact-sheet', labelKey: 'dialogs.print.layoutContactSheet', cols: 5, rows: 7 },
];

// ─── Print Settings ────────────────────────────────────────────

export interface PrintSettings {
  paper: PaperSize;
  orientation: 'portrait' | 'landscape';
  layout: PrintLayout;
  dpi: number;              // 150, 300, 600
  margins: { top: number; right: number; bottom: number; left: number }; // mm
  cellSpacing: number;      // mm between images
  sharpen: 'none' | 'low' | 'standard' | 'high';
  renderIntent: 'perceptual' | 'relative';
  showFilename: boolean;
  borderWidth: number;      // mm, 0 = no border
  borderColor: string;      // hex
}

export const DEFAULT_PRINT_SETTINGS: PrintSettings = {
  paper: PAPER_SIZES[0], // A4
  orientation: 'portrait',
  layout: PRINT_LAYOUTS[0], // Single
  dpi: 300,
  margins: { top: 10, right: 10, bottom: 10, left: 10 },
  cellSpacing: 5,
  sharpen: 'standard',
  renderIntent: 'perceptual',
  showFilename: false,
  borderWidth: 0,
  borderColor: '#ffffff',
};

// ─── Layout calculation ────────────────────────────────────────

export interface CellRect {
  x: number;    // mm from left
  y: number;    // mm from top
  width: number;  // mm
  height: number; // mm
}

/**
 * Calculate cell positions for a given paper + layout + margins.
 */
export function calculateCells(settings: PrintSettings): CellRect[] {
  const { paper, orientation, layout, margins, cellSpacing } = settings;

  const pw = orientation === 'landscape' ? paper.height : paper.width;
  const ph = orientation === 'landscape' ? paper.width : paper.height;

  const printableW = pw - margins.left - margins.right;
  const printableH = ph - margins.top - margins.bottom;

  const cols = layout.cols;
  const rows = layout.rows;

  const totalSpacingX = (cols - 1) * cellSpacing;
  const totalSpacingY = (rows - 1) * cellSpacing;

  const cellW = (printableW - totalSpacingX) / cols;
  const cellH = (printableH - totalSpacingY) / rows;

  const cells: CellRect[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      cells.push({
        x: margins.left + col * (cellW + cellSpacing),
        y: margins.top + row * (cellH + cellSpacing),
        width: cellW,
        height: cellH,
      });
    }
  }

  return cells;
}

/** Re-exported so a page and the resolution rule share one mm -> px. */
export { mmToPx };

// ─── Print sharpening ──────────────────────────────────────────

const SHARPEN_AMOUNTS: Record<string, number> = {
  none: 0,
  low: 0.3,
  standard: 0.5,
  high: 0.8,
};

/**
 * Apply print sharpening to a canvas (unsharp mask approximation).
 *
 * An unsharp mask adds the DIFFERENCE between the pixel and a blur of its
 * neighbourhood, so a flat area - where pixel and blur are the same number -
 * comes out untouched. This added the whole sharpened VALUE instead: the
 * 5-centre kernel leaves `5v - 4v = v` on a flat field, and that `v` was added
 * on top, so at "standard" every flat 128 printed as 144 and paper white was
 * the only thing the clamp saved. A print came back brighter and flatter the
 * more of it was sky.
 */
export function applyPrintSharpening(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  width: number,
  height: number,
  level: string,
): void {
  const amount = SHARPEN_AMOUNTS[level] ?? 0;
  if (amount <= 0) return;

  const imageData = ctx.getImageData(0, 0, width, height);
  const d = imageData.data;
  const w = width;

  // Simple 3×3 unsharp mask
  const src = new Uint8ClampedArray(d);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const blur = (src[i - 4 + c] + src[i + 4 + c] +
          src[(i - w * 4) + c] + src[(i + w * 4) + c]) * 0.25;
        const delta = src[i + c] - blur;
        d[i + c] = Math.max(0, Math.min(255, src[i + c] + delta * amount));
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

/**
 * One cell of a print page: a finished frame, or nothing renderable.
 *
 * The page used to be handed display URLs and load them through `new Image()`
 * (F071). That drew the ORIGINAL - no document, no adjustments, no graph - so
 * an edited photo printed unedited, and a local RAW, which no `<img>` can
 * decode, rejected into nothing. Frames come from `renderPhoto`, the same
 * render stage the export uses, so what is printed is what was edited.
 */
export interface PrintImage {
  name: string;
  /** null = this photo could not be rendered; its cell gets a placeholder. */
  frame: RenderedFrame | null;
}

/** Drawing a frame means uploading its pixels once; paper and DPI changes
 *  re-lay-out the same frames, so the canvas is kept with the frame. */
const frameCanvases = new WeakMap<RenderedFrame, OffscreenCanvas>();

function canvasFor(frame: RenderedFrame): OffscreenCanvas {
  let canvas = frameCanvases.get(frame);
  if (!canvas) {
    canvas = frameToCanvas(frame);
    frameCanvases.set(frame, canvas);
  }
  return canvas;
}

export const PLACEHOLDER_FILL = '#e8e8e8';
const PLACEHOLDER_STROKE = '#b4b4b4';
const PLACEHOLDER_TEXT = '#6e6e6e';

/** What a cell shows when its photo could not be rendered: the rest of the
 *  page still prints, and the gap says which photo is missing. */
function drawPlaceholder(
  ctx: CanvasRenderingContext2D,
  name: string,
  x: number, y: number, w: number, h: number,
): void {
  ctx.fillStyle = PLACEHOLDER_FILL;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = PLACEHOLDER_STROKE;
  ctx.lineWidth = Math.max(1, Math.round(w / 200));
  ctx.strokeRect(x, y, w, h);

  const fontSize = Math.max(8, Math.round(Math.min(w, h) / 14));
  ctx.font = `${fontSize}px sans-serif`;
  ctx.fillStyle = PLACEHOLDER_TEXT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, x + w / 2, y + h / 2, w * 0.9);
  ctx.textBaseline = 'alphabetic';
}

/**
 * The photos of each page, in order, one entry per sheet of paper.
 *
 * The dialog has always told the truth about the page COUNT ("9 pages for 35
 * photos") while `renderPrintPage` drew one page and the print window got that
 * single canvas - 31 of those 35 photos were never printed. Same arithmetic as
 * the dialog's count, so the two cannot drift apart again.
 *
 * Slicing only: every page reuses the frames it is given, so the frames the
 * dialog holds for the session are laid out N times and rendered once.
 */
export function paginatePrintImages(
  images: PrintImage[],
  settings: PrintSettings,
): PrintImage[][] {
  const perPage = calculateCells(settings).length;
  if (perPage <= 0) return [];
  const pages: PrintImage[][] = [];
  for (let i = 0; i < images.length; i += perPage) pages.push(images.slice(i, i + perPage));
  return pages;
}

/**
 * Render ONE print page to a canvas element ready for window.print().
 *
 * Takes finished frames, never URLs: a settings change re-runs this function
 * and only this function, so changing paper or DPI re-lays-out the page
 * without rendering a single photo again.
 *
 * Draws at most one cellful; callers with more photos than cells split them
 * with `paginatePrintImages` first.
 */
export function renderPrintPage(
  images: PrintImage[],
  settings: PrintSettings,
): HTMLCanvasElement {
  const { paper, orientation, dpi } = settings;
  const pw = orientation === 'landscape' ? paper.height : paper.width;
  const ph = orientation === 'landscape' ? paper.width : paper.height;

  const canvasW = mmToPx(pw, dpi);
  const canvasH = mmToPx(ph, dpi);

  const canvas = document.createElement('canvas');
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext('2d')!;

  // White background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasW, canvasH);

  const cells = calculateCells(settings);

  for (let i = 0; i < Math.min(images.length, cells.length); i++) {
    const cell = cells[i];
    const { frame, name } = images[i];

    const cx = mmToPx(cell.x, dpi);
    const cy = mmToPx(cell.y, dpi);
    const cw = mmToPx(cell.width, dpi);
    const ch = mmToPx(cell.height, dpi);

    // Border
    if (settings.borderWidth > 0) {
      const bw = mmToPx(settings.borderWidth, dpi);
      ctx.fillStyle = settings.borderColor;
      ctx.fillRect(cx - bw, cy - bw, cw + bw * 2, ch + bw * 2);
    }

    if (!frame) {
      drawPlaceholder(ctx, name, cx, cy, cw, ch);
    } else {
      // Fit image into cell (contain)
      const imgAspect = frame.width / frame.height;
      const cellAspect = cw / ch;
      let dw: number, dh: number, dx: number, dy: number;

      if (imgAspect > cellAspect) {
        dw = cw;
        dh = cw / imgAspect;
        dx = cx;
        dy = cy + (ch - dh) / 2;
      } else {
        dh = ch;
        dw = ch * imgAspect;
        dx = cx + (cw - dw) / 2;
        dy = cy;
      }

      ctx.drawImage(canvasFor(frame), dx, dy, dw, dh);
    }

    // Filename
    if (settings.showFilename) {
      const fontSize = Math.max(8, mmToPx(2.5, dpi));
      ctx.font = `${fontSize}px sans-serif`;
      ctx.fillStyle = '#333333';
      ctx.textAlign = 'center';
      ctx.fillText(name, cx + cw / 2, cy + ch + fontSize + mmToPx(1, dpi));
    }
  }

  // Print sharpening
  if (settings.sharpen !== 'none') {
    applyPrintSharpening(ctx, canvasW, canvasH, settings.sharpen);
  }

  return canvas;
}
