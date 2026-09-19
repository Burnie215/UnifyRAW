/**
 * Which photos the background thumbnail walker still has to decode.
 *
 * It used to ask the sidecar index and nothing else. A source that keeps no
 * sidecar - a file list, S3, every remote provider - has no index, so every
 * photo counted as missing on EVERY pass and the walker demosaiced the whole
 * library again each time the photo list moved. Measured in the running app
 * with three RAW tiles: three full libraw decodes per grid build, on top of
 * the three the tiles themselves did, and again after every return from the
 * editor.
 *
 * The two places a thumbnail can already be without a sidecar are asked now:
 * the shared memory slot, and the catalog under `sourceThumbnailKey`. Pure on
 * purpose - the node project cannot render the hook this decision lives in.
 */
import { sourceThumbnailKeys, type SourceThumbnailIdentity } from '../cache/sourceThumbnailKey';

export type ThumbnailCandidate = SourceThumbnailIdentity & { id?: number | null };

export interface ThumbnailSupply {
  /** The photo's `.dat` sidecar already holds a thumbnail. */
  hasSidecarThumb: (photo: ThumbnailCandidate) => boolean;
  /** Keys the catalog has a stored thumbnail for (`ThumbnailRepository.storedKeys`). */
  storedKeys: ReadonlySet<string>;
  /** The photo's thumbnail is in the shared memory slot. */
  hasMemoryThumb: (photoId: number) => boolean;
  /** The source has a policy-approved way to produce a background thumbnail. */
  canProvideThumbnail: (photo: ThumbnailCandidate) => boolean;
}

export function photosNeedingThumbnail<T extends ThumbnailCandidate>(
  photos: readonly T[],
  supply: ThumbnailSupply,
): T[] {
  const needed: T[] = [];
  for (const photo of photos) {
    if (!photo.id) continue;
    if (!supply.canProvideThumbnail(photo)) continue;
    if (supply.hasSidecarThumb(photo)) continue;
    if (sourceThumbnailKeys(photo).some((key) => supply.storedKeys.has(key))) continue;
    if (supply.hasMemoryThumb(photo.id)) continue;
    needed.push(photo);
  }
  return needed;
}

/**
 * Where phase 3 may find the thumbnail it needs to compute a blurHash.
 *
 * `photosNeedingThumbnail` above counts a photo as supplied when the catalog
 * holds its thumbnail - so exactly those photos reach phase 3 without one
 * being generated for them. Phase 3 then asked the sidecar and the memory
 * slot and gave up: no remote source keeps a sidecar, and the memory slot is a
 * 200-entry LRU, so beyond the first screenful nothing answered. Those photos
 * kept their missing hash, turned up in the next pass, and the walker hashed
 * the same library forever without the counter ever arriving.
 *
 * The catalog is asked last because it is the only one of the three that has
 * to touch a file.
 */
export interface BlurHashThumbPorts {
  /** The source's sidecar reader, when it keeps one. */
  readSidecar: (() => Promise<Blob | null>) | null;
  /** The shared memory slot. */
  readMemory: (photoId: number) => Blob | null;
  /** One stored catalog thumbnail, by key. */
  readStored: (key: string) => Promise<Blob | null>;
}

export async function thumbnailForBlurHash(
  photo: ThumbnailCandidate,
  ports: BlurHashThumbPorts,
): Promise<Blob | null> {
  if (!photo.id) return null;

  if (ports.readSidecar) {
    const hit = await ports.readSidecar().catch(() => null);
    if (hit && hit.size > 0) return hit;
  }

  const inMemory = ports.readMemory(photo.id);
  if (inMemory && inMemory.size > 0) return inMemory;

  for (const key of sourceThumbnailKeys(photo)) {
    const hit = await ports.readStored(key).catch(() => null);
    if (hit && hit.size > 0) return hit;
  }
  return null;
}
