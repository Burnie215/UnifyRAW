/**
 * Smart-preview cache versions. The backend names its disk slot and the
 * browser names its OPFS copy of the same TIFF from this one rule, so a
 * backend bump invalidates both.
 *
 * v7 = v6 without `-h` above SMART_PREVIEW_HALF_SIZE_MAX_PX (F015). Up to
 *      2540 px the output did not change, so those entries keep v6.
 * v6 = v5 + `-h` (half-size bilinear demosaic). 3-4x faster on X-Trans
 *      with no visible quality difference at <=2540 px preview because
 *      sharp's lanczos3 downsample dominates the detail anyway.
 * v5 = -6 -g 1 1 -o 1 -w (no -4 shorthand, so no implicit -W -> auto-bright
 *      actually applied). The browser kept naming its slots v5 long after the
 *      backend moved to v6 (F038).
 */

/**
 * Above this long edge the half-size demosaic caps the output below the
 * requested size, so larger requests decode at full size (and carry v7).
 */
export const SMART_PREVIEW_HALF_SIZE_MAX_PX = 2540;

/**
 * The largest long edge `/api/raw/smart-preview` will produce.
 *
 * The backend clamps every `size=` to this, so it is also the ceiling of what
 * a backend-decoded RAW can deliver - including the export's and the print
 * dialog's "native" request, which asks for exactly this number. It was
 * written as "bigger than any realistic camera"; a 9504x6336 file says
 * otherwise, so callers that promise native pixels have to say which of the
 * two they are getting (only the in-browser libraw path is truly native).
 */
export const SMART_PREVIEW_MAX_PX = 8000;

export type SmartPreviewVersion = 'v6' | 'v7';
export type SmartPreviewExt = 'tiff' | 'jpg';

export function smartPreviewVersion(size: number): SmartPreviewVersion {
  return size > SMART_PREVIEW_HALF_SIZE_MAX_PX ? 'v7' : 'v6';
}

export function smartPreviewFileName(key: string, size: number, ext: SmartPreviewExt): string {
  return `${key}_${size}_${smartPreviewVersion(size)}.${ext}`;
}

export interface SmartPreviewSlot {
  key: string;
  size: number;
  version: string;
  ext: SmartPreviewExt;
}

/** Splits a slot file name; null for anything that is not one. */
export function parseSmartPreviewFileName(name: string): SmartPreviewSlot | null {
  const m = /^(.+)_(\d+)_(v\d+)\.(tiff|jpg)$/.exec(name);
  if (!m) return null;
  return { key: m[1], size: Number(m[2]), version: m[3], ext: m[4] as SmartPreviewExt };
}

export function isCurrentSmartPreviewSlot(slot: SmartPreviewSlot): boolean {
  return slot.version === smartPreviewVersion(slot.size);
}
