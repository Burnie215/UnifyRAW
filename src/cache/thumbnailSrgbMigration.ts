import { STORAGE_KEYS } from '../platform/storageKeys';
import type { Repositories } from '../storage/repos';
import { EDIT_THUMBNAIL_PREFIX } from './editThumbnailKey';

/**
 * One-off: drop the developed thumbnails that were rendered in a wider space
 * than sRGB.
 *
 * Until 2026-09-12 the thumbnail renderer followed the editor's output colour
 * space setting (F124). The result was stored as an untagged JPEG under a key
 * that names no space, so a profile set to Display-P3, Adobe RGB, ProPhoto or
 * Rec.2020 has tiles whose numbers the gallery has been showing as sRGB ever
 * since. They cannot be corrected in place - only re-rendered - so they go.
 *
 * Only profiles that really carry such a setting pay for it: with the setting
 * absent or on sRGB nothing is deleted and no marker is written, which keeps a
 * fresh profile free of state it would otherwise carry for nothing.
 */
export async function migrateThumbnailsToSrgb(repos: Repositories): Promise<number> {
  let stored: string | null;
  try {
    if (localStorage.getItem(STORAGE_KEYS.thumbsSrgbMigrated)) return 0;
    stored = localStorage.getItem(STORAGE_KEYS.outputColorSpace);
  } catch {
    // No browser storage means no stored setting, and thus nothing baked in a
    // space other than the default.
    return 0;
  }
  if (!stored || stored === 'srgb') return 0;

  // The marker goes down before the delete, not after: a purge interrupted
  // half-way has still thrown away most of the tiles, and re-running it on
  // every start would keep deleting the ones rendered since.
  try { localStorage.setItem(STORAGE_KEYS.thumbsSrgbMigrated, '1'); } catch { /* */ }
  return repos.thumbnails.deleteByPrefix(EDIT_THUMBNAIL_PREFIX);
}
