import type { PhotoRow, PhotoView } from '../storage/repos';
import { perfLog } from '../platform/perfLog';
import { needsSourceBitsProbe } from '../engine/sourceBitDepth';
import { needsExifBackfill } from './exifBackfillPolicy';

export const EXIF_BATCH_SIZE = 5;

/** The columns one file read may fill in. */
export type ExifPatch = Partial<Pick<PhotoRow,
  'camera' | 'lens' | 'iso' | 'focalLength' | 'aperture' | 'shutterSpeed'
  | 'width' | 'height' | 'latitude' | 'longitude' | 'dateTaken' | 'sourceBits'>>;

export interface ExifBackfillWriter {
  /** Once per batch: every call bumps the storage revision and reloads the photo table. */
  updatePhotos(updates: Array<{ id: number; patch: ExifPatch }>): void;
  setKeywords(contentHash: string, keywords: string[]): void;
  /** Local-only mark, deliberately not a revision bump. */
  markScanned(photoIds: number[], at: number): void;
}

export interface ExifBackfillPorts {
  photos: readonly PhotoView[];
  /** Photo ids whose file this device has already read. */
  scanned: ReadonlySet<number>;
  /**
   * Whether this device owns the file behind the photo. The pass reads
   * original bytes, so it stays on browser-owned sources; remote providers
   * expose their metadata through their own APIs and must not be made to
   * serve bulk RAW downloads.
   */
  owns(photo: PhotoView): boolean;
  getFile(photo: PhotoView, signal?: AbortSignal): Promise<File | null>;
  extractExif(file: File): Promise<Partial<PhotoView>>;
  /**
   * Encoded precision of a HEIF original, or null when it cannot be read. The
   * pass already holds the bytes, so this costs a container parse, not a
   * second download.
   */
  probeSourceBits(file: File): Promise<number | null>;
  write: ExifBackfillWriter;
  /** Cancels the active source read as well as stopping the next batch. */
  signal?: AbortSignal;
  stale(): boolean;
  /** Before batch `index`: pause, thumbnail queue, idle callback. False stops the pass. */
  beforeBatch(index: number): Promise<boolean>;
  /** Before each file read. False stops the pass. */
  beforePhoto(): Promise<boolean>;
  now?: () => number;
}

/**
 * A photo is a target when reading its file would still add something: the
 * capture EXIF, the encoded depth, or both. The depth criterion deliberately
 * ignores the scanned mark - a catalog written before the column existed is
 * marked scanned and would otherwise never be probed - and terminates on its
 * own because every completed read records a value, 0 included.
 */
export function selectExifBackfillTargets(
  photos: readonly PhotoView[],
  scanned: ReadonlySet<number>,
  owns: (photo: PhotoView) => boolean,
): PhotoView[] {
  return photos.filter((photo) => Boolean(photo.id)
    && (needsExifBackfill(photo, scanned) || needsSourceBitsProbe(photo))
    && owns(photo));
}

/**
 * One backfill pass: read the files that still owe capture metadata, write
 * back what they actually carry, and record every file that was read.
 */
export async function runExifBackfillPass(ports: ExifBackfillPorts): Promise<void> {
  const now = ports.now ?? Date.now;
  const targets = selectExifBackfillTargets(ports.photos, ports.scanned, ports.owns);
  const stopped = () => ports.signal?.aborted === true || ports.stale();

  if (targets.length === 0) {
    if (perfLog.enabled) console.log('[ExifBackfill] No photos need EXIF');
    return;
  }
  if (perfLog.enabled) console.log(`[ExifBackfill] ${targets.length} photos need EXIF`);

  for (let index = 0; index < targets.length; index += EXIF_BATCH_SIZE) {
    if (stopped()) return;
    if (!(await ports.beforeBatch(index))) return;

    const chunk = targets.slice(index, index + EXIF_BATCH_SIZE);
    const updates: Array<{ id: number; patch: ExifPatch }> = [];
    const scanned: number[] = [];
    let stop = false;

    for (const photo of chunk) {
      if (stopped() || !(await ports.beforePhoto()) || stopped()) {
        stop = true;
        break;
      }
      const read = await readPhoto(photo, ports);
      if (ports.signal?.aborted) {
        stop = true;
        break;
      }
      // A file the source could not hand over was never read. Leaving it
      // unmarked costs a cheap retry; marking it would lose a photo's EXIF for
      // good the first time a folder comes back without permission.
      if (!read) continue;
      scanned.push(photo.id);
      if (Object.keys(read.patch).length > 0) updates.push({ id: photo.id, patch: read.patch });
      if (photo.contentHash && read.keywords.length > 0) {
        ports.write.setKeywords(photo.contentHash, read.keywords);
      }
    }

    if (updates.length > 0) ports.write.updatePhotos(updates);
    if (scanned.length > 0) ports.write.markScanned(scanned, now());
    if (stop) return;

    if (perfLog.enabled) {
      console.log(`[ExifBackfill] Processed ${Math.min(index + EXIF_BATCH_SIZE, targets.length)}/${targets.length}`);
    }
  }

  if (perfLog.enabled) console.log('[ExifBackfill] Complete');
}

interface PhotoRead { patch: ExifPatch; keywords: string[] }

/** null when the file could not be read at all; the photo then stays unmarked. */
async function readPhoto(photo: PhotoView, ports: ExifBackfillPorts): Promise<PhotoRead | null> {
  let file: File | null;
  try {
    // The file is held only for the extraction below, then released.
    file = await ports.getFile(photo, ports.signal);
  } catch {
    return null;
  }
  if (!file || ports.signal?.aborted) return null;

  let read: PhotoRead;
  try {
    const exif = await ports.extractExif(file);
    if (ports.signal?.aborted) return null;
    read = { patch: exifPatch(exif), keywords: exif.keywords ?? [] };
  } catch {
    // The bytes were read and the parser failed on them; it will fail again
    // next session. Mark the photo as scanned and write no EXIF - the depth
    // probe below reads the container itself and is unaffected.
    read = { patch: {}, keywords: [] };
  }

  if (needsSourceBitsProbe(photo)) {
    const bits = await probeSourceBits(file, ports);
    if (ports.signal?.aborted) return null;
    // 0, not "leave it null": the file was read, and a null would put it back
    // in front of the next pass for the same fruitless read.
    read.patch.sourceBits = bits ?? 0;
  }
  return read;
}

/** A probe must never cost the pass its EXIF result. */
async function probeSourceBits(file: File, ports: ExifBackfillPorts): Promise<number | null> {
  try {
    return await ports.probeSourceBits(file);
  } catch {
    return null;
  }
}

/**
 * What an EXIF result is worth writing back: values, never nulls.
 *
 * The old code wrote all six capture columns on every result, so a file
 * without capture EXIF got six nulls back - the exact row the criterion
 * selects - and a dimension the listing had measured was erased by a null the
 * parser never had (F078).
 */
export function exifPatch(exif: Partial<PhotoView>): ExifPatch {
  const patch: ExifPatch = {};
  put(patch, 'camera', exif.camera);
  put(patch, 'lens', exif.lens);
  put(patch, 'iso', exif.iso);
  put(patch, 'focalLength', exif.focalLength);
  put(patch, 'aperture', exif.aperture);
  put(patch, 'shutterSpeed', exif.shutterSpeed);
  put(patch, 'width', exif.width);
  put(patch, 'height', exif.height);
  put(patch, 'latitude', exif.latitude);
  put(patch, 'longitude', exif.longitude);
  put(patch, 'dateTaken', exif.dateTaken);
  return patch;
}

function put<K extends keyof ExifPatch>(patch: ExifPatch, key: K, value: ExifPatch[K] | null): void {
  if (value != null) patch[key] = value;
}
