/**
 * How much resolution a print asks each photo for.
 *
 * A print used to render from the native RAW pixels, always. A 61-MP photo
 * became a 244 MB RGBA8 frame plus the canvas cached from it, and the print
 * dialog keeps every frame for the life of the session so that a paper or DPI
 * change only re-lays-out - a contact sheet of 35 RAWs was far past what a tab
 * survives. The resolution is the user's choice now, and the default asks for
 * what the cell on the paper can actually show.
 *
 * Pure on purpose: the node test project cannot render the dialog, so the rule
 * lives here rather than in PrintDialog.tsx.
 */

import { SMART_PREVIEW_MAX_PX } from '@photolib/shared';

const MM_PER_INCH = 25.4;

/** Convert mm to pixels at a given DPI. */
export function mmToPx(mm: number, dpi: number): number {
  return Math.round(mm * dpi / MM_PER_INCH);
}

export type PrintResolutionMode = 'cell' | 'native';

export const DEFAULT_PRINT_RESOLUTION: PrintResolutionMode = 'cell';

/**
 * Requests are rounded UP to this many pixels on the long edge.
 *
 * Every distinct size is its own slot in the RAW ladder's caches, so an exact
 * cell size would re-decode all photos for a one-millimetre margin nudge and
 * again for the next. A step absorbs those nudges, and rounding up means the
 * cell never gets fewer pixels than it can show.
 */
export const PRINT_RENDER_STEP = 256;

export interface PrintCellSize {
  /** mm */
  width: number;
  /** mm */
  height: number;
}

/**
 * The long edge, in pixels, to render one photo at for this page.
 *
 * `null` means native: whatever the file holds, no bound - the explicit choice
 * for a single exhibition print, not something a contact sheet should do.
 */
export function printRenderLongEdge(
  mode: PrintResolutionMode,
  cell: PrintCellSize,
  dpi: number,
): number | null {
  if (mode === 'native') return null;
  const needed = mmToPx(Math.max(cell.width, cell.height), dpi);
  return Math.max(PRINT_RENDER_STEP, Math.ceil(needed / PRINT_RENDER_STEP) * PRINT_RENDER_STEP);
}

/**
 * Never ask a decoder for more pixels than the file has.
 *
 * The decoders cap on their own (`sharp`'s withoutEnlargement, and
 * `resizeRaw16LongEdge` returns the source when it is already smaller), so
 * this is about the cache slot: without it every paper size above native gets
 * its own slot holding the same pixels.
 */
export function capRenderLongEdge(
  longEdge: number | null,
  width: number | null | undefined,
  height: number | null | undefined,
): number | null {
  if (longEdge === null) return null;
  const native = Math.max(width ?? 0, height ?? 0);
  return native > 0 ? Math.min(longEdge, native) : longEdge;
}

/**
 * The long edge "native" actually delivers for this photo.
 *
 * "Native" is not one resolution. Only the in-browser libraw path returns the
 * sensor's own pixels; a backend-decoded RAW comes back through
 * /api/raw/smart-preview, whose size the server clamps at SMART_PREVIEW_MAX_PX,
 * so a 9504x6336 file arrives at 8000 px. The dialog used to promise the full
 * 9504 and estimate its memory from it, and the export said nothing at all.
 * Non-RAW photos are never decoded that way and always deliver their own
 * pixels.
 */
export function deliveredNativeLongEdge(
  width: number | null | undefined,
  height: number | null | undefined,
  decodesLocally: boolean,
): number | null {
  const native = Math.max(width ?? 0, height ?? 0);
  if (native <= 0) return null;
  return decodesLocally ? native : Math.min(native, SMART_PREVIEW_MAX_PX);
}

/**
 * The photo as the "native" choice will actually hand it over, for the memory
 * hint: the same aspect, scaled to what the decoder delivers.
 */
export function deliveredNativePixels<T extends { width: number | null; height: number | null }>(
  photo: T,
  decodesLocally: boolean,
): { width: number | null; height: number | null } {
  const edge = deliveredNativeLongEdge(photo.width, photo.height, decodesLocally);
  if (edge === null || !photo.width || !photo.height) return { width: photo.width, height: photo.height };
  const scale = edge / Math.max(photo.width, photo.height);
  if (scale >= 1) return { width: photo.width, height: photo.height };
  return {
    width: Math.max(1, Math.round(photo.width * scale)),
    height: Math.max(1, Math.round(photo.height * scale)),
  };
}

/** Bytes one RGBA8 frame of this photo occupies under this bound. */
export function renderedFrameBytes(
  width: number | null | undefined,
  height: number | null | undefined,
  longEdge: number | null,
): number | null {
  if (!width || !height || width <= 0 || height <= 0) return null;
  const bound = capRenderLongEdge(longEdge, width, height);
  const scale = bound === null ? 1 : bound / Math.max(width, height);
  return Math.max(1, Math.round(width * scale)) * Math.max(1, Math.round(height * scale)) * 4;
}

/**
 * A rendered photo is held TWICE: the RGBA8 frame, and the canvas PrintEngine
 * caches from it (`frameCanvases`) so that a paper or DPI change re-lays-out
 * without uploading the pixels again. A hint that counted only the frame would
 * understate the cost by half.
 */
const COPIES_HELD_PER_PHOTO = 2;

export interface PrintMemoryEstimate {
  /** What the dialog holds once every photo is rendered. */
  totalBytes: number;
  /** The most expensive single photo, held the same way. */
  largestBytes: number;
  /** Photos the catalogue has no pixel dimensions for; not in the totals. */
  unknown: number;
}

export function estimatePrintMemory(
  photos: ReadonlyArray<{ width: number | null; height: number | null }>,
  longEdge: number | null,
): PrintMemoryEstimate {
  let totalBytes = 0;
  let largestBytes = 0;
  let unknown = 0;
  for (const photo of photos) {
    const frame = renderedFrameBytes(photo.width, photo.height, longEdge);
    if (frame === null) {
      unknown += 1;
      continue;
    }
    const held = frame * COPIES_HELD_PER_PHOTO;
    totalBytes += held;
    if (held > largestBytes) largestBytes = held;
  }
  return { totalBytes, largestBytes, unknown };
}

/** Size for the dialog's memory hint. Binary units, like the storage tab. */
export function formatPrintBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}
