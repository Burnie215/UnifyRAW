import { HeifDecoder } from './HeifDecoder';
import { RawDecoder } from './RawDecoder';

export interface ExportDepthPhoto {
  name: string;
  /**
   * Exact encoded HEIF precision once the source has been probed. `null` means
   * nothing has read the file yet; `0` means it was read and reported no
   * plausible depth. The zero is what keeps a file whose probe cannot succeed
   * from being re-read once per session.
   */
  sourceBits?: number | null;
}

const ALWAYS_8_BIT_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp']);

/** Maximum meaningful export precision for one original source. */
export function maxExportDepth(photo: ExportDepthPhoto): 8 | 16 {
  if (RawDecoder.isRawFile(photo.name)) return 16;

  const extension = photo.name.split('.').pop()?.toLowerCase() ?? '';
  if (ALWAYS_8_BIT_EXTENSIONS.has(extension)) return 8;

  if (isValidSourceBits(photo.sourceBits)) return photo.sourceBits > 8 ? 16 : 8;

  // Opening the export dialog precedes the first decode. The supported HEIF
  // family gets this one conservative fallback until a real probe persists a
  // value; all other unknown formats stay at the safe 8-bit default.
  return HeifDecoder.isHeifFile(photo.name) ? 16 : 8;
}

function isValidSourceBits(value: number | null | undefined): value is number {
  return Number.isInteger(value) && value! >= 1 && value! <= 16;
}

/**
 * Whether reading this original would still tell us something. Only HEIF can
 * carry more than 8 bits without being a RAW file, and only an unprobed row
 * (`null`) is worth a read - a recorded 0 already says the probe came back
 * empty.
 */
export function needsSourceBitsProbe(photo: ExportDepthPhoto): boolean {
  return photo.sourceBits == null && HeifDecoder.isHeifFile(photo.name);
}

/** A batch may offer 16-bit only when every exported source can benefit. */
export function canExportAllAt16Bit(photos: readonly ExportDepthPhoto[]): boolean {
  return photos.length > 0 && photos.every((photo) => maxExportDepth(photo) === 16);
}
