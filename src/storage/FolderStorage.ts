import type { Database } from 'sql.js';
import type {
  CatalogStorage,
  CatalogStorageEventMap,
  CatalogStorageInfo,
  CatalogStorageListener,
  CompactResult,
  StorageKind,
  ThumbSize,
} from './CatalogStorage';
import { acquireCatalogLock, catalogLockName, type CatalogLockRelease } from './catalogLock';
import { ThrottledFlush } from './ThrottledFlush';
import { ThumbBinStore, type ThumbBinEntry, type ThumbBinLocator } from './ThumbBinStore';
import { createEmptyCatalogDb, openCatalogDbFromBytes } from './sqljs-init';
import { CATALOG_SCHEMA_VERSION } from '@photolib/shared';
import { FileCipher } from './FileCipher';

const CATALOG_FILE = 'catalog.sqlite';
const THUMBS_DIR = 'thumbs';
const VERSION_FILE = 'version.json';

interface VersionFile {
  schemaVersion: number;
  appVersion?: string;
  lastOpenedAt: number;
  /** True if catalog.sqlite is wrapped in a PLE1 envelope. */
  encrypted?: boolean;
}

export interface OpenOptions {
  /**
   * Called when the catalog file is encrypted and we need a passphrase.
   * Returning null cancels the open.
   */
  passphraseProvider?: () => Promise<string | null>;
}

/**
 * Folder-backed catalog: catalog.sqlite + thumbs/<size>/<bin>.bin.
 * Works against any FileSystemDirectoryHandle, so this class covers both
 * the File System Access API (showDirectoryPicker) and OPFS
 * (navigator.storage.getDirectory).
 *
 * When a `FileCipher` is attached (Phase 6.5), `persistCatalogDb()` wraps
 * the sql.js bytes in a PLE1 envelope before writing. The in-memory DB
 * stays plain — encryption is only on the persistence boundary.
 *
 * Every flush rewrites the whole catalog.sqlite, so only one tab may write a
 * catalog. The first open takes an exclusive Web Lock; a later open while
 * another tab holds it reads the catalog and never writes (`info.readOnly`).
 */
export class FolderStorage implements CatalogStorage {
  readonly info: CatalogStorageInfo;
  readonly db: Database;

  private readonly root: FileSystemDirectoryHandle;
  private readonly thumbs: ThumbBinStore;
  private readonly throttledFlush: ThrottledFlush;
  private cipher: FileCipher | null;
  /** Not readonly: replaceCatalogWith() hands the lock back before close(). */
  private releaseLock: CatalogLockRelease | null;
  private readonly readOnly: boolean;
  private readonly listeners = new Map<keyof CatalogStorageEventMap, Set<(ev: never) => void>>();
  private closed = false;
  /** The sql.js handle is freed. Lags `closed` while a replaced catalog is read out. */
  private dbClosed = false;
  /** total_changes() right after the last export; -1 while none has landed. */
  private persistedChanges = -1;

  private constructor(
    root: FileSystemDirectoryHandle,
    db: Database,
    thumbsDir: FileSystemDirectoryHandle,
    kind: StorageKind,
    catalogSize: number,
    cipher: FileCipher | null,
    releaseLock: CatalogLockRelease | null,
  ) {
    this.root = root;
    this.db = db;
    this.thumbs = new ThumbBinStore(thumbsDir);
    this.cipher = cipher;
    this.releaseLock = releaseLock;
    this.readOnly = releaseLock === null;
    // OPFS root reports `name === ""` in all browsers — give it something
    // human-readable so the Speicher-Tab status row isn't truncated.
    const label = root.name && root.name.length > 0
      ? root.name
      : (kind === 'opfs' ? 'Origin Private File System' : 'Katalog-Ordner');
    this.info = {
      kind,
      label,
      persistent: true,
      catalogSize,
      ...(this.readOnly ? { readOnly: true, readOnlyReason: 'locked' as const } : {}),
    };
    // pagehide cannot hold the page open for an async OPFS write, so the short
    // idle time is what bounds the loss when a tab goes away.
    this.throttledFlush = new ThrottledFlush(() => this.persistIfChanged(), {
      idleMs: 500,
      maxMs: 30_000,
      onError: (error) => this.emit('error', { error, op: 'flush' }),
    });
  }

  static async open(
    root: FileSystemDirectoryHandle,
    kind: StorageKind,
    opts: OpenOptions = {},
  ): Promise<FolderStorage> {
    const releaseLock = await acquireCatalogLock(catalogLockName(kind, root));
    try {
      return await FolderStorage.openHeld(root, kind, opts, releaseLock);
    } catch (e) {
      await releaseLock?.();
      throw e;
    }
  }

  private static async openHeld(
    root: FileSystemDirectoryHandle,
    kind: StorageKind,
    opts: OpenOptions,
    releaseLock: CatalogLockRelease | null,
  ): Promise<FolderStorage> {
    const catalogHandle = await root.getFileHandle(CATALOG_FILE, { create: true });
    const catalogFile = await catalogHandle.getFile();
    const catalogSize = catalogFile.size;
    const raw = catalogSize > 0 ? new Uint8Array(await catalogFile.arrayBuffer()) : new Uint8Array(0);

    let cipher: FileCipher | null = null;
    let plain: Uint8Array | null = null;

    if (catalogSize > 0 && FileCipher.isEncrypted(raw)) {
      if (!opts.passphraseProvider) throw new EncryptedCatalogError();
      const salt = FileCipher.extractSalt(raw);
      // Up to 3 attempts before giving up.
      for (let attempt = 0; attempt < 3; attempt++) {
        const pass = await opts.passphraseProvider();
        if (pass == null) throw new EncryptedCatalogError('passphrase cancelled');
        cipher = await FileCipher.fromPassphrase(pass, salt);
        try {
          plain = await cipher.decrypt(raw);
          break;
        } catch {
          cipher = null;
          if (attempt === 2) throw new EncryptedCatalogError('passphrase rejected after 3 attempts');
        }
      }
    } else if (catalogSize > 0) {
      plain = raw;
    }

    const db = plain && plain.byteLength > 0
      ? await openCatalogDbFromBytes(plain)
      : await createEmptyCatalogDb();

    const thumbsDir = await root.getDirectoryHandle(THUMBS_DIR, { create: true });
    await ensureSubdir(thumbsDir, 'small');
    await ensureSubdir(thumbsDir, 'large');

    if (releaseLock) await writeVersionFile(root, !!cipher);

    const storage = new FolderStorage(root, db, thumbsDir, kind, catalogSize, cipher, releaseLock);

    if (catalogSize === 0) {
      // Brand-new catalog: persist immediately. Uses cipher if attached
      // (it won't be at this point), or plain bytes.
      await storage.persistCatalogDb();
    }

    return storage;
  }

  async readThumb(hash: string, size: ThumbSize): Promise<Blob | null> {
    const loc = this.lookupThumb(hash, size);
    if (!loc) return null;
    return this.thumbs.read(loc, size);
  }

  async writeThumb(hash: string, size: ThumbSize, blob: Blob): Promise<void> {
    // An append here would land on offsets the holder's thumbIndex also hands out.
    if (this.readOnly) return;
    let loc: ThumbBinLocator;
    try {
      loc = await this.thumbs.append(hash, size, blob);
    } catch (error) {
      this.emit('error', { error, op: 'thumb-write' });
      throw error;
    }
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO thumbIndex(contentHash, size, binId, offset, length)
       VALUES (?, ?, ?, ?, ?)`,
    );
    try {
      stmt.run([hash, size, loc.binId, loc.offset, loc.length]);
    } finally {
      stmt.free();
    }
    this.flush();
  }

  async deleteThumb(hash: string, size: ThumbSize): Promise<void> {
    if (this.readOnly) return;
    this.db.run(
      'DELETE FROM thumbIndex WHERE contentHash = ? AND size = ?',
      [hash, size],
    );
    this.flush();
  }

  flush(): void {
    if (this.closed) return;
    this.throttledFlush.schedule();
  }

  async flushNow(): Promise<void> {
    await this.throttledFlush.fireNow();
  }

  exportDb(): Uint8Array {
    return this.db.export();
  }

  getRootHandle(): FileSystemDirectoryHandle {
    return this.root;
  }

  on<K extends keyof CatalogStorageEventMap>(event: K, listener: CatalogStorageListener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => { set.delete(listener); };
  }

  private emit<K extends keyof CatalogStorageEventMap>(event: K, ev: CatalogStorageEventMap[K]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        (listener as CatalogStorageListener<K>)(ev);
      } catch (e) {
        console.error(`[storage] ${event} listener failed`, e);
      }
    }
  }

  /** True if subsequent flushes will write encrypted bytes. */
  isEncrypted(): boolean {
    return this.cipher !== null;
  }

  /** Turn on encryption from this flush onward. Rewrites catalog.sqlite immediately. */
  async enableEncryption(passphrase: string): Promise<void> {
    if (this.readOnly) throw new CatalogReadOnlyError();
    this.cipher = await FileCipher.fromNewPassphrase(passphrase);
    await this.persistCatalogDb();
    await writeVersionFile(this.root, true);
  }

  /** Turn off encryption and rewrite catalog.sqlite as plaintext. */
  async disableEncryption(): Promise<void> {
    if (this.readOnly) throw new CatalogReadOnlyError();
    this.cipher = null;
    await this.persistCatalogDb();
    await writeVersionFile(this.root, false);
  }

  /**
   * Rewrites every thumb bin tightly, one bin at a time through the same
   * queue the appends use, so thumbnails can keep being generated meanwhile.
   */
  async compactThumbs(): Promise<CompactResult> {
    const result: CompactResult = {
      startedAt: Date.now(), finishedAt: 0, binsTouched: 0, binsSkipped: 0, bytesBefore: 0, bytesAfter: 0, errors: [],
    };
    // Rewriting bins another tab indexes would move its thumbs out from under it.
    if (this.readOnly) return { ...result, finishedAt: Date.now(), errors: ['read-only'] };

    const bins = (this.db.exec('SELECT DISTINCT size, binId FROM thumbIndex')[0]?.values ?? []) as Array<[ThumbSize, string]>;
    for (const [size, binId] of bins) {
      const key = `${size}/${binId}`;
      try {
        const bin = await this.thumbs.compactBin(
          size,
          binId,
          () => this.thumbIndexRows(size, binId),
          (moved) => {
            for (const { hash, loc } of moved) {
              this.db.run(
                'UPDATE thumbIndex SET offset = ?, length = ? WHERE contentHash = ? AND size = ?',
                [loc.offset, loc.length, hash, size],
              );
            }
          },
        );
        for (const hash of bin.dropped) result.errors.push(`${key}: ${hash} points past EOF, dropping`);
        if (bin.skipped) result.binsSkipped++;
        else result.binsTouched++;
        result.bytesBefore += bin.before;
        result.bytesAfter += bin.after;
      } catch (e) {
        result.errors.push(`${key}: ${(e as Error).message}`);
      }
    }

    this.flush();
    result.finishedAt = Date.now();
    return result;
  }

  private thumbIndexRows(size: ThumbSize, binId: string): ThumbBinEntry[] {
    const stmt = this.db.prepare('SELECT contentHash, offset, length FROM thumbIndex WHERE size = ? AND binId = ?');
    try {
      stmt.bind([size, binId]);
      const rows: ThumbBinEntry[] = [];
      while (stmt.step()) {
        const row = stmt.getAsObject() as { contentHash: string; offset: number; length: number };
        rows.push({ hash: row.contentHash, offset: row.offset, length: row.length });
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  /**
   * Installs `plain` as this catalog and gives the storage up.
   *
   * The throttle is stopped before the write, or a flush still owed would put
   * the in-memory catalog back over the imported one; the database and the
   * lock go with it, so the caller can open the folder again and find what it
   * just wrote. Encryption survives: the bytes go out through the same cipher
   * as every other flush, so an encrypted catalog stays encrypted, under its
   * existing passphrase.
   *
   * The thumb bins go too. An imported catalog arrives with an empty
   * thumbIndex (prepareImportedCatalog), so not one byte in those files is
   * addressed by anything any more - and on a real library that is gigabytes
   * of it. Here is the one safe moment to drop them: this catalog no longer
   * writes and the next one is not open yet, so nothing is appending.
   *
   * The database is deliberately left open. Everything still rendering holds
   * repositories built against it, and a query against a closed sql.js handle
   * throws; it stays readable, stale but valid, until the provider swaps in
   * the reopened storage and closes this one.
   */
  async replaceCatalogWith(plain: Uint8Array): Promise<void> {
    if (this.readOnly) throw new CatalogReadOnlyError();
    if (this.closed) throw new Error('catalog already closed');
    this.throttledFlush.cancel();
    this.closed = true;
    const onDisk = this.cipher ? await this.cipher.encrypt(plain) : plain;
    const handle = await this.root.getFileHandle(CATALOG_FILE, { create: true });
    await writeFile(handle, onDisk);
    await writeVersionFile(this.root, this.cipher !== null).catch(() => undefined);
    this.info.catalogSize = onDisk.byteLength;
    this.info.lastFlushAt = Date.now();
    await this.root.removeEntry(THUMBS_DIR, { recursive: true })
      .catch((e) => console.warn('[storage] could not drop the thumb bins of the replaced catalog', e));
    // The reopen cannot take the catalog while this instance holds it.
    await this.releaseLock?.();
    this.releaseLock = null;
  }

  /** Persists, then closes. Rejects with the last flush's error if that final write failed. */
  async close(): Promise<void> {
    // Already retired by replaceCatalogWith(), or closed once before: there is
    // nothing left to persist, only the handles to give back.
    if (this.closed) {
      if (!this.dbClosed) { this.dbClosed = true; this.db.close(); }
      await this.releaseLock?.();
      this.releaseLock = null;
      return;
    }
    let lastFlushError: unknown = null;
    try {
      if (!this.readOnly) {
        await this.flushNow();
        lastFlushError = this.throttledFlush.lastError;
        await this.thumbs.drain();
      }
      // A retry after this point would export a closed database.
      this.closed = true;
      this.throttledFlush.cancel();
      this.dbClosed = true;
      this.db.close();
    } finally {
      await this.releaseLock?.();
      this.releaseLock = null;
    }
    if (lastFlushError) throw lastFlushError;
  }

  private lookupThumb(hash: string, size: ThumbSize): ThumbBinLocator | null {
    const stmt = this.db.prepare(
      'SELECT binId, offset, length FROM thumbIndex WHERE contentHash = ? AND size = ?',
    );
    try {
      stmt.bind([hash, size]);
      if (!stmt.step()) return null;
      const row = stmt.getAsObject() as { binId: string; offset: number; length: number };
      return { binId: row.binId, offset: row.offset, length: row.length };
    } finally {
      stmt.free();
    }
  }

  /**
   * The throttle's worker. Every hidden tab calls flushNow(); without a
   * change there is nothing to rewrite, and the catalog can be tens of MB.
   */
  private async persistIfChanged(): Promise<void> {
    if (this.persistedChanges !== -1 && this.totalChanges() === this.persistedChanges) return;
    await this.persistCatalogDb();
  }

  private totalChanges(): number {
    return Number(this.db.exec('SELECT total_changes()')[0].values[0][0]);
  }

  /** The one writer of catalog.sqlite; flush() and flushNow() arrive here through persistIfChanged. */
  private async persistCatalogDb(): Promise<void> {
    if (this.readOnly || this.closed) return;
    const plain = this.db.export();
    // export() closes and reopens the database, which restarts total_changes().
    this.persistedChanges = this.totalChanges();
    try {
      const onDisk = this.cipher ? await this.cipher.encrypt(plain) : plain;
      const handle = await this.root.getFileHandle(CATALOG_FILE, { create: true });
      await writeFile(handle, onDisk);
      const at = Date.now();
      this.info.catalogSize = onDisk.byteLength;
      this.info.lastFlushAt = at;
      // Awaited so that flushNow() and close() resolve with every file landed.
      await writeVersionFile(this.root, this.cipher !== null).catch(() => undefined);
      this.emit('flush', { at, bytes: onDisk.byteLength });
    } catch (error) {
      this.persistedChanges = -1;
      throw error;
    }
  }
}

export class EncryptedCatalogError extends Error {
  constructor(message = 'catalog.sqlite is encrypted; passphrase required') {
    super(message);
    this.name = 'EncryptedCatalogError';
  }
}

export class CatalogReadOnlyError extends Error {
  constructor(message = 'catalog is open in another tab; this tab only reads it') {
    super(message);
    this.name = 'CatalogReadOnlyError';
  }
}

async function writeFile(handle: FileSystemFileHandle, bytes: Uint8Array): Promise<void> {
  const writable = await handle.createWritable();
  try {
    await writable.write(new Blob([bytes as BlobPart]));
  } finally {
    await writable.close();
  }
}

async function ensureSubdir(parent: FileSystemDirectoryHandle, name: string): Promise<void> {
  await parent.getDirectoryHandle(name, { create: true });
}

async function writeVersionFile(root: FileSystemDirectoryHandle, encrypted: boolean): Promise<void> {
  const v: VersionFile = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    lastOpenedAt: Date.now(),
    encrypted,
  };
  const handle = await root.getFileHandle(VERSION_FILE, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(new TextEncoder().encode(JSON.stringify(v, null, 2)));
  } finally {
    await writable.close();
  }
}
