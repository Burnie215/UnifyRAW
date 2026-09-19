import type { PhotoView } from '../../storage/repos';
import { sourceManager } from '../../sources';
import { RawDecoder } from '../RawDecoder';
import { makeRawCacheKey } from './cacheKey';
import { editorRawMemoryCache } from './EditorRawMemoryCache';
import { loadRawPixels } from './loadRawPixels';
import { isLocalRawSourceType } from './sourcePolicy';

interface QueueItem { photo: PhotoView; size: number; slot: string }

class LocalRawPrefetchManager {
  private queue: QueueItem[] = [];
  private queued = new Set<string>();
  private completed = new Set<string>();
  private running = false;

  schedule(photo: PhotoView, size: number): void {
    const source = sourceManager.get(photo.sourceId);
    if (!source || !isLocalRawSourceType(source.type) || !RawDecoder.isRawFile(photo.name)) return;
    const cacheKey = makeRawCacheKey(photo);
    const slot = `${cacheKey}|${size}`;
    if (this.completed.has(slot) || this.queued.has(slot) || editorRawMemoryCache.get(cacheKey, size)) return;
    this.queued.add(slot);
    this.queue.push({ photo, size, slot });
    this.startWhenIdle();
  }

  scheduleNeighbors(current: PhotoView, photos: readonly PhotoView[], size: number, radius = 2): void {
    const index = photos.findIndex((candidate) => candidate.id === current.id);
    if (index < 0) return;
    for (let distance = 1; distance <= radius; distance++) {
      const next = photos[index + distance];
      const previous = photos[index - distance];
      if (next) this.schedule(next, size);
      if (previous) this.schedule(previous, size);
    }
  }

  private startWhenIdle(): void {
    if (this.running) return;
    this.running = true;
    const start = () => void this.drain();
    if (typeof requestIdleCallback === 'function') requestIdleCallback(start, { timeout: 1500 });
    else setTimeout(start, 250);
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      try {
        const source = sourceManager.get(item.photo.sourceId);
        if (!source || !isLocalRawSourceType(source.type)) continue;
        // The preview is wanted: loadRawPixels keeps it in the memory cache,
        // and building it now is the point of prefetching during idle time.
        const result = await loadRawPixels({
          identity: item.photo,
          size: item.size,
          sourceType: source.type,
          file: (signal) => source.getFile({
            sourcePhotoId: item.photo.sourcePhotoId,
            sourceId: item.photo.sourceId,
            name: item.photo.name,
          }, signal),
        });
        if (result) {
          if (result.displayUrl.startsWith('blob:')) URL.revokeObjectURL(result.displayUrl);
          this.completed.add(item.slot);
        }
      } catch (error) {
        console.warn('[LocalRawPrefetch] failed:', error);
      } finally {
        this.queued.delete(item.slot);
      }
      // Let interaction/rendering take precedence between two RAWs.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    this.running = false;
  }
}

export const localRawPrefetchManager = new LocalRawPrefetchManager();
