import initSqlJs, { type Database } from 'sql.js';
import { randomUUID } from 'node:crypto';
import path from 'path';
import fs from 'fs';
import type { FileHandle } from 'fs/promises';
import { runBackendMigrations } from '../db/migrations.js';
import { recoverInterruptedLibraryScans } from '../libraries/library.asset.repository.js';
import { recoverInterruptedLibraryImports } from '../libraries/library.import.repository.js';

let db: Database | undefined;
let dbPath = '';

/**
 * Backend schema is created and upgraded exclusively by ../db/migrations/.
 * Migration 010 derives every sync table from the shared catalog schema,
 * applies the per-user overlay, and reasserts the guarded 005-007 invariants;
 * 012 does the same for the export ledger, which joined the sync set later.
 * db.schema.test.ts locks fresh and legacy databases to the checked-in Golden.
 */

export async function initDb(filePath: string) {
  if (db) {
    db.close();
    db = undefined;
  }
  dbPath = filePath;

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const SQL = await initSqlJs();
  if (fs.existsSync(filePath)) {
    db = new SQL.Database(fs.readFileSync(filePath));
  } else {
    db = new SQL.Database();
  }

  runBackendMigrations(db);
  recoverInterruptedLibraryScans(db);
  recoverInterruptedLibraryImports(db);
  markDirty();
  saveToFile();
}

export function getDb(): Database {
  if (!db) throw new Error('Database not initialized');
  return db;
}

interface Snapshot {
  filePath: string;
  bytes: Buffer;
  sequence: number;
}

let dirty = false;
let queuedSave: Promise<void> | null = null;
let lastWrite: Promise<void> = Promise.resolve();
let snapshotCount = 0;
const newestOnDisk = new Map<string, number>();

/** Marks the database as changed, so the next save writes it. */
export function markDirty(): void {
  dirty = true;
}

/** Writes the database now if it changed since the last snapshot. */
export function saveToFile(): void {
  const snapshot = takeSnapshot();
  if (!snapshot) return;
  try {
    atomicWriteFile(snapshot);
  } catch (error) {
    dirty = true;
    throw error;
  }
}

/**
 * Resolves once every change made before the call is on disk, and rejects
 * when that write fails. Calls that arrive before the next snapshot share
 * it; calls that arrive while a snapshot is being written wait for the one
 * after, because their rows are not in it.
 */
export function persistSoon(): Promise<void> {
  if (queuedSave) return queuedSave;
  const save = lastWrite
    .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
    .then(async () => {
      queuedSave = null;
      const snapshot = takeSnapshot();
      if (!snapshot) return;
      try {
        await atomicWriteFileAsync(snapshot);
      } catch (error) {
        dirty = true;
        throw error;
      }
    });
  queuedSave = save;
  lastWrite = save.catch(() => undefined);
  return save;
}

function hasUnsavedChanges(database: Database): boolean {
  // export() closes and reopens the connection, which resets total_changes();
  // writers outside /api/sync (accounts, libraries) never call markDirty.
  const changes = database.exec('SELECT total_changes()')[0]?.values[0]?.[0];
  return dirty || Number(changes) > 0;
}

function takeSnapshot(): Snapshot | null {
  if (!db || !dbPath || !hasUnsavedChanges(db)) return null;
  const bytes = Buffer.from(db.export());
  dirty = false;
  snapshotCount += 1;
  return { filePath: dbPath, bytes, sequence: snapshotCount };
}

function temporaryPathFor(filePath: string): string {
  return `${filePath}.tmp-${process.pid}-${randomUUID()}`;
}

function isSuperseded(snapshot: Snapshot): boolean {
  return (newestOnDisk.get(snapshot.filePath) ?? 0) > snapshot.sequence;
}

function replaceWith(snapshot: Snapshot, temporaryPath: string): void {
  fs.renameSync(temporaryPath, snapshot.filePath);
  newestOnDisk.set(snapshot.filePath, snapshot.sequence);
}

async function atomicWriteFileAsync(snapshot: Snapshot): Promise<void> {
  const temporaryPath = temporaryPathFor(snapshot.filePath);
  let handle: FileHandle | null = null;

  try {
    handle = await fs.promises.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(snapshot.bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    // A synchronous save may have written a newer snapshot meanwhile. The
    // check and the rename run in one tick, so nothing slips between them.
    if (isSuperseded(snapshot)) {
      await fs.promises.unlink(temporaryPath);
      return;
    }
    replaceWith(snapshot, temporaryPath);
    await syncDirectoryAsync(path.dirname(snapshot.filePath));
  } catch (error) {
    if (handle !== null) await handle.close().catch(() => undefined);
    await fs.promises.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function syncDirectoryAsync(directory: string): Promise<void> {
  let handle: FileHandle | null = null;
  try {
    handle = await fs.promises.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR') throw error;
  } finally {
    if (handle !== null) await handle.close();
  }
}

function atomicWriteFile(snapshot: Snapshot): void {
  const temporaryPath = temporaryPathFor(snapshot.filePath);
  let fileDescriptor: number | null = null;

  try {
    fileDescriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(fileDescriptor, snapshot.bytes);
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = null;
    replaceWith(snapshot, temporaryPath);
    syncDirectory(path.dirname(snapshot.filePath));
  } catch (error) {
    if (fileDescriptor !== null) {
      try {
        fs.closeSync(fileDescriptor);
      } catch {
        // Preserve the original persistence error.
      }
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The rename may already have completed, or the temp file may not exist.
    }
    throw error;
  }
}

function syncDirectory(directory: string): void {
  let directoryDescriptor: number | null = null;
  try {
    directoryDescriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(directoryDescriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR') throw error;
  } finally {
    if (directoryDescriptor !== null) fs.closeSync(directoryDescriptor);
  }
}

export function closeDb(): void {
  if (!db) return;
  markDirty();
  saveToFile();
  db.close();
  db = undefined;
  dbPath = '';
}

const saveTimer = setInterval(() => {
  persistSoon().catch((error: unknown) => console.error('[db] periodic save failed', error));
}, 30000);
saveTimer.unref();
