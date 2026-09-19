/**
 * Where a background thumbnail is allowed to come from.
 *
 * The tile loader asks the source for its own thumbnail first and only falls
 * back to the original when there is none (useThumbnail). The background pass
 * skipped that first question and went straight for the original - for every
 * photo in the library, right after every scan. On an Immich library of RAWs
 * that is 20-60 MB times the photo count, downloaded so that a 300 px JPEG can
 * be made from it (F022).
 *
 * Lives outside the hook because the node test project cannot render hooks: as
 * a function with injected ports it can be asked directly how often it reached
 * for the original.
 */
import { bulkOriginalReadAllowed } from '../engine/raw/sourcePolicy';
import { revokeBlobUrls } from '../platform/objectUrls';
import type { PhotoRef } from '../sources/types';

/** The part of a source provider this pass uses. */
export interface ThumbnailSource {
  readonly type: string;
  getThumbnailUrl(ref: PhotoRef, signal?: AbortSignal): Promise<string | null>;
  getFile(ref: PhotoRef, signal?: AbortSignal): Promise<File | null>;
}

export interface BackgroundThumbnailPorts {
  /** Read a source-provided thumbnail. Null when the endpoint refuses. */
  fetchBlob: (url: string, signal?: AbortSignal) => Promise<Blob | null>;
  /** Decode and downscale an original this device already holds. */
  fromOriginal: (file: File) => Promise<Blob>;
}

export interface AcquiredThumbnailPorts {
  cache: (blob: Blob) => Promise<void>;
  persistBlob: (blob: Blob) => void;
  computeBlurHash: (blob: Blob) => Promise<string | null>;
  persistBlurHash: (blurHash: string) => void;
  persistSidecar: (blob: Blob, blurHash: string | null) => void;
}

export async function retainAcquiredThumbnail(
  blob: Blob,
  ports: AcquiredThumbnailPorts,
): Promise<void> {
  await ports.cache(blob);
  ports.persistBlob(blob);
  const blurHash = await ports.computeBlurHash(blob);
  if (blurHash) ports.persistBlurHash(blurHash);
  ports.persistSidecar(blob, blurHash);
}

export async function backgroundThumbnailBlob(
  source: ThumbnailSource,
  ref: PhotoRef,
  ports: BackgroundThumbnailPorts,
  signal?: AbortSignal,
): Promise<Blob | null> {
  if (signal?.aborted) return null;
  let thumbUrl: string | null = null;
  try {
    thumbUrl = await source.getThumbnailUrl(ref, signal);
  } catch {
    // A source without a thumbnail endpoint answers by throwing.
  }
  if (thumbUrl) {
    try {
      if (signal?.aborted) return null;
      const blob = await ports.fetchBlob(thumbUrl, signal);
      if (signal?.aborted) return null;
      if (blob && blob.size > 0) return blob;
    } catch {
      // Fall through: an unreachable thumbnail is not a reason to pull 60 MB.
    } finally {
      // Immich and friends hand back a blob: URL they made for this one read.
      revokeBlobUrls([thumbUrl]);
    }
  }

  if (signal?.aborted || !bulkOriginalReadAllowed(source.type)) return null;
  const file = await source.getFile(ref, signal);
  if (!file || signal?.aborted) return null;
  const blob = await ports.fromOriginal(file);
  return signal?.aborted ? null : blob;
}
