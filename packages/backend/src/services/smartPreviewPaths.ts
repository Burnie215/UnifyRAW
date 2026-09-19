import path from 'path';
import { isCurrentSmartPreviewSlot, parseSmartPreviewFileName, smartPreviewFileName } from '@photolib/shared';

/**
 * Persistent cache directory for Smart Preview TIFFs. Persistent across
 * container restarts (so re-decode isn't needed). Uses /data volume.
 */
export const SMART_PREVIEW_DIR = process.env.SMART_PREVIEW_DIR ?? '/data/smart-previews';

/** The version history lives at the shared rule the browser names its slots with. */
export function smartPreviewPath(key: string, size: number): string {
  return path.join(SMART_PREVIEW_DIR, smartPreviewFileName(key, size, 'tiff'));
}

/** A cached preview whose version no longer matches the rule for its size. */
export function isStalePreviewFile(name: string): boolean {
  if (!name.endsWith('.tiff')) return false;
  const slot = parseSmartPreviewFileName(name);
  return slot !== null && !isCurrentSmartPreviewSlot(slot);
}
