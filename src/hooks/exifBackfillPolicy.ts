import type { PhotoView } from '../storage/repos';

/**
 * Photos the background backfill still has to read from disk.
 *
 * `scanned` holds the photo ids whose file this device has already read
 * (exifScan). Without that mark a file that genuinely carries no capture EXIF
 * met the criterion again on every start: its empty result was written back as
 * six nulls, which is exactly the row the criterion selects, so the whole file
 * was read from disk once per session (F078).
 *
 * New catalog rows use null, not undefined, for metadata not parsed yet.
 */
export function needsExifBackfill(photo: PhotoView, scanned: ReadonlySet<number>): boolean {
  if (scanned.has(photo.id)) return false;
  return photo.camera == null
    && photo.lens == null
    && photo.iso == null
    && photo.aperture == null
    && photo.shutterSpeed == null
    && photo.focalLength == null;
}
