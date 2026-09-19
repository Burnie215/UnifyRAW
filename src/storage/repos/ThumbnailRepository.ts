import type { CatalogStorage, ThumbSize } from '../CatalogStorage';

/**
 * Thin wrapper around CatalogStorage.readThumb/writeThumb with a small
 * in-memory LRU cache so hot paths (grid scroll, slideshow) don't bounce
 * back to disk every time. The cache is keyed by (size, contentHash).
 *
 * Thumb generation lives in src/engine/thumbnail/generateThumbnailBlob.ts
 * (grid) and src/engine/ThumbnailRenderer.ts (edited); this repo only
 * handles persistence.
 */

const MAX_RAM_ENTRIES = 600;

type Key = `${ThumbSize}/${string}`;

export class ThumbnailRepository {
  private readonly storage: CatalogStorage;
  private readonly ram: Map<Key, Blob>;

  constructor(storage: CatalogStorage) {
    this.storage = storage;
    this.ram = new Map();
  }

  async get(contentHash: string, size: ThumbSize = 'small'): Promise<Blob | null> {
    const key: Key = `${size}/${contentHash}`;
    const cached = this.ram.get(key);
    if (cached) {
      // refresh LRU position
      this.ram.delete(key);
      this.ram.set(key, cached);
      return cached;
    }
    const blob = await this.storage.readThumb(contentHash, size);
    if (blob) this.putRam(key, blob);
    return blob;
  }

  async set(contentHash: string, blob: Blob, size: ThumbSize = 'small'): Promise<void> {
    await this.storage.writeThumb(contentHash, size, blob);
    this.putRam(`${size}/${contentHash}`, blob);
  }

  async delete(contentHash: string, size: ThumbSize = 'small'): Promise<void> {
    await this.storage.deleteThumb(contentHash, size);
    this.ram.delete(`${size}/${contentHash}`);
  }

  /**
   * Drop every thumbnail whose key starts with `prefix`, and say how many.
   *
   * The keys live in `thumbIndex`, the catalog table that locates a thumb in
   * its bin file, so that is what gets enumerated; `deleteThumb` takes the row
   * with it and compaction reclaims the bytes in the bin. A memory catalog
   * keeps no index, but it also starts empty on every load, so it has nothing
   * to enumerate.
   */
  async deleteByPrefix(prefix: string): Promise<number> {
    const rows = this.storage.db.exec(
      'SELECT contentHash, size FROM thumbIndex WHERE substr(contentHash, 1, ?) = ?',
      [prefix.length, prefix],
    )[0]?.values ?? [];
    for (const [hash, size] of rows) {
      await this.delete(String(hash), String(size) as ThumbSize);
    }
    return rows.length;
  }

  /**
   * Every key that has a stored thumbnail of this size.
   *
   * One indexed query instead of a blob read per photo: the background walker
   * asks once per pass whether it still has work, the way it already reads the
   * sidecar index once per source. A catalog without a thumb index (the memory
   * one) answers "nothing stored", which is what it is.
   */
  async storedKeys(size: ThumbSize = 'small'): Promise<Set<string>> {
    try {
      const rows = this.storage.db.exec(
        'SELECT contentHash FROM thumbIndex WHERE size = ?',
        [size],
      )[0]?.values ?? [];
      return new Set(rows.map((row) => String(row[0])));
    } catch {
      return new Set();
    }
  }

  private putRam(key: Key, blob: Blob): void {
    this.ram.set(key, blob);
    while (this.ram.size > MAX_RAM_ENTRIES) {
      const first = this.ram.keys().next().value;
      if (first === undefined) break;
      this.ram.delete(first);
    }
  }

  clearRam(): void { this.ram.clear(); }

  get ramSize(): number { return this.ram.size; }
}
