import type { Database } from 'sql.js';
import { CATALOG_SCHEMA_VERSION } from '@photolib/shared';
import { getSqlJs, openCatalogDbFromBytes } from './sqljs-init';

/** Why an offered file cannot become this profile's catalog. */
export type CatalogImportRefusal = 'not-sqlite' | 'not-a-catalog' | 'newer-schema';

export class CatalogImportError extends Error {
  readonly reason: CatalogImportRefusal;
  /** Set for 'newer-schema': the version the file was written by. */
  readonly foundVersion?: number;

  constructor(reason: CatalogImportRefusal, foundVersion?: number) {
    super(`catalog import refused: ${reason}`);
    this.name = 'CatalogImportError';
    this.reason = reason;
    this.foundVersion = foundVersion;
  }
}

/** The 16 bytes every SQLite file starts with, including its terminating NUL. */
const SQLITE_MAGIC = 'SQLite format 3\0';

/**
 * Whether these bytes are a SQLite file at all.
 *
 * Checked before sql.js sees them: handed a JPEG or an HTML error page, sql.js
 * throws something about a disk image, and "not a SQLite file" is the more
 * useful thing to tell someone who picked the wrong file.
 */
export function looksLikeSqlite(bytes: Uint8Array): boolean {
  if (bytes.byteLength < SQLITE_MAGIC.length) return false;
  for (let i = 0; i < SQLITE_MAGIC.length; i++) {
    if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Whether a catalog written by `fileVersion` may be opened here, given the
 * schema version this build knows.
 *
 * Older is fine and the common case: openCatalogDbFromBytes applies the schema
 * idempotently and migrates. Newer is refused, because this build would open
 * it, write it back through its own older schema and quietly drop whatever the
 * newer one added. A file without a recorded version is treated as older -
 * every catalog this app ever wrote carries one, so a missing version means a
 * catalog from before it was recorded.
 */
export function schemaVersionAccepted(fileVersion: number | null, knownVersion: number): boolean {
  if (fileVersion === null) return true;
  return fileVersion <= knownVersion;
}

export interface PreparedCatalog {
  /** catalog.sqlite bytes, ready to be written into the active storage. */
  bytes: Uint8Array;
  /** Photos the imported catalog holds, for the confirmation the user gets. */
  photos: number;
}

/**
 * Validates an offered .sqlite and returns the bytes to install.
 *
 * The thumbnail index is emptied on the way through: it addresses thumb bins
 * by file and offset, and those bins belong to the catalog the file came from,
 * not to this one. Left in place, every tile would resolve to a byte range of
 * a bin that is not there. Dropped, the tiles simply render again.
 */
export async function prepareImportedCatalog(bytes: Uint8Array): Promise<PreparedCatalog> {
  if (!looksLikeSqlite(bytes)) throw new CatalogImportError('not-sqlite');

  const SQL = await getSqlJs();
  let probe: Database;
  try {
    probe = new SQL.Database(bytes);
  } catch {
    throw new CatalogImportError('not-sqlite');
  }
  let fileVersion: number | null;
  try {
    if (!hasTable(probe, 'photos') || !hasTable(probe, 'schema_meta')) {
      throw new CatalogImportError('not-a-catalog');
    }
    fileVersion = readSchemaVersion(probe);
    if (!schemaVersionAccepted(fileVersion, CATALOG_SCHEMA_VERSION)) {
      throw new CatalogImportError('newer-schema', fileVersion ?? undefined);
    }
  } finally {
    probe.close();
  }

  // Only now the migrating open: it rewrites the file, and rewriting one this
  // build cannot read correctly is exactly what the checks above prevent.
  const db = await openCatalogDbFromBytes(bytes);
  try {
    db.run('DELETE FROM thumbIndex');
    const photos = Number(db.exec('SELECT COUNT(*) FROM photos WHERE deletedAt IS NULL')[0]?.values[0][0] ?? 0);
    return { bytes: db.export(), photos };
  } finally {
    db.close();
  }
}

function hasTable(db: Database, name: string): boolean {
  const rows = db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name]);
  return rows.length > 0;
}

function readSchemaVersion(db: Database): number | null {
  const rows = db.exec("SELECT value FROM schema_meta WHERE key = 'version'");
  const raw = rows[0]?.values[0]?.[0];
  if (raw == null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
