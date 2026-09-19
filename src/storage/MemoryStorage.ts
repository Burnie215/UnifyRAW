import type { Database } from 'sql.js';
import type { CatalogStorage, CatalogStorageInfo, ThumbSize } from './CatalogStorage';
import { createEmptyCatalogDb } from './sqljs-init';

/**
 * In-memory catalog: sql.js DB lives in RAM, thumbs in a Map. Nothing
 * persists across tab reloads. Use exportDb() / writeThumb()+exportDb()
 * to snapshot for download.
 */
export class MemoryStorage implements CatalogStorage {
  readonly info: CatalogStorageInfo;
  readonly db: Database;
  private thumbs = new Map<string, Blob>();

  private constructor(db: Database) {
    this.db = db;
    this.info = {
      kind: 'memory',
      label: 'Browser-Memory',
      persistent: false,
    };
  }

  static async create(): Promise<MemoryStorage> {
    const db = await createEmptyCatalogDb();
    return new MemoryStorage(db);
  }

  async readThumb(hash: string, size: ThumbSize): Promise<Blob | null> {
    return this.thumbs.get(thumbKey(hash, size)) ?? null;
  }

  async writeThumb(hash: string, size: ThumbSize, blob: Blob): Promise<void> {
    this.thumbs.set(thumbKey(hash, size), blob);
  }

  async deleteThumb(hash: string, size: ThumbSize): Promise<void> {
    this.thumbs.delete(thumbKey(hash, size));
  }

  flush(): void { /* no-op */ }

  async flushNow(): Promise<void> { /* no-op */ }

  exportDb(): Uint8Array {
    return this.db.export();
  }

  async close(): Promise<void> {
    this.db.close();
    this.thumbs.clear();
  }
}

function thumbKey(hash: string, size: ThumbSize): string {
  return `${size}/${hash}`;
}
