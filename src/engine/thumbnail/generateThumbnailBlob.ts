import { HeifDecoder, heifDecoder } from '../HeifDecoder';
import { RawDecoder, rawDecoder } from '../RawDecoder';

const MAX_RAW_CONCURRENT = 2;
let activeRawJobs = 0;
const rawWaiters: Array<() => void> = [];

async function withRawSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeRawJobs >= MAX_RAW_CONCURRENT) {
    await new Promise<void>((resolve) => rawWaiters.push(resolve));
  }
  activeRawJobs++;
  try {
    return await work();
  } finally {
    activeRawJobs--;
    rawWaiters.shift()?.();
  }
}

async function decodeRawThumbnail(file: File): Promise<ImageBitmap> {
  return withRawSlot(async () => {
    // Most RAWs contain a camera-rendered JPEG. It is much faster than a
    // demosaic and is more than sufficient for a grid thumbnail.
    const embedded = await rawDecoder.extractLargestEmbeddedJpeg(file);
    if (embedded) {
      try {
        return await createImageBitmap(embedded);
      } catch {
        // Some cameras store an unusual/corrupt preview. Fall through to
        // libraw instead of leaving the tile empty.
      }
    }
    const preview = await rawDecoder.decodePreview(file);
    return rawDecoder.toImageBitmap(preview);
  });
}

/** Long edge of every grid and edit thumbnail, in pixels. */
export const THUMB_LONG_EDGE = 300;

/**
 * Decode any PhotoLib image type and return a long-edge-limited JPEG.
 * RAW, HEIF and browser-native image formats all share this path so a cache
 * generated in the background is byte-identical to an on-demand thumbnail.
 */
export async function generateThumbnailBlob(
  file: File,
  maxEdge = THUMB_LONG_EDGE,
  quality = 0.72,
): Promise<Blob> {
  let bitmap: ImageBitmap;
  if (RawDecoder.isRawFile(file.name)) {
    bitmap = await decodeRawThumbnail(file);
  } else if (HeifDecoder.isHeifFile(file.name) || await HeifDecoder.sniffHeif(file)) {
    bitmap = await createImageBitmap(await heifDecoder.decode(file));
  } else {
    bitmap = await createImageBitmap(file);
  }

  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('2D canvas is not available');
    context.drawImage(bitmap, 0, 0, width, height);
    return await canvas.convertToBlob({ type: 'image/jpeg', quality });
  } finally {
    bitmap.close();
  }
}
