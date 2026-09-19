import { isCurrentSmartPreviewSlot, parseSmartPreviewFileName, smartPreviewVersion } from '@photolib/shared';

/**
 * Pixel-cache variant of a smart preview: the size plus the decode version,
 * so a backend bump misses the decoded pixels as well as the TIFF (F038).
 * LibrawWasmStrategy keys the same cache by the bare size; the backend does
 * not version a browser decode, so bare sizes are never stale.
 */
export function previewVariant(size: number): string {
  return `${size}${smartPreviewVersion(size)}`;
}

function parseVariant(variant: string): { size: number; version: string } | null {
  const m = /^(\d+)(v\d+)$/.exec(variant);
  return m ? { size: Number(m[1]), version: m[2] } : null;
}

export function isCurrentPreviewVariant(variant: string): boolean {
  const parsed = parseVariant(variant);
  return parsed !== null && parsed.version === smartPreviewVersion(parsed.size);
}

export function isStalePreviewVariant(variant: string): boolean {
  const parsed = parseVariant(variant);
  return parsed !== null && parsed.version !== smartPreviewVersion(parsed.size);
}

/** Cache key of a current-version slot file; null for stale or foreign names. */
export function currentSlotKey(name: string): string | null {
  const slot = parseSmartPreviewFileName(name);
  return slot && isCurrentSmartPreviewSlot(slot) ? slot.key : null;
}
