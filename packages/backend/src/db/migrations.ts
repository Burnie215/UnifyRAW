import type { Database } from 'sql.js';
import { BACKEND_MIGRATIONS } from './migrations/index.js';

export interface BackendMigration {
  version: number;
  name: string;
  up(db: Database): void;
}

const MIGRATION_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS server_schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    appliedAt INTEGER NOT NULL
  )
`;

export function runBackendMigrations(
  db: Database,
  migrations: readonly BackendMigration[] = BACKEND_MIGRATIONS,
): void {
  assertValidMigrationList(migrations);
  db.exec(MIGRATION_TABLE_SQL);

  const applied = getAppliedVersions(db);
  const ordered = [...migrations].sort((a, b) => a.version - b.version);

  for (const migration of ordered) {
    if (applied.has(migration.version)) continue;

    db.exec('BEGIN');
    try {
      migration.up(db);
      db.run(
        `INSERT INTO server_schema_migrations (version, name, appliedAt)
         VALUES (?, ?, ?)`,
        [migration.version, migration.name, Date.now()],
      );
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Preserve the original migration error.
      }
      throw new Error(
        `Backend migration ${migration.version} (${migration.name}) failed`,
        { cause: error },
      );
    }
  }
}

function getAppliedVersions(db: Database): Set<number> {
  const stmt = db.prepare('SELECT version FROM server_schema_migrations');
  const versions = new Set<number>();
  while (stmt.step()) {
    const row = stmt.getAsObject() as { version?: number };
    if (typeof row.version === 'number') versions.add(row.version);
  }
  stmt.free();
  return versions;
}

function assertValidMigrationList(migrations: readonly BackendMigration[]): void {
  const versions = new Set<number>();
  const names = new Set<string>();

  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= 0) {
      throw new Error(`Invalid backend migration version: ${migration.version}`);
    }
    if (!migration.name.trim()) throw new Error('Backend migration name must not be empty');
    if (versions.has(migration.version)) {
      throw new Error(`Duplicate backend migration version: ${migration.version}`);
    }
    if (names.has(migration.name)) {
      throw new Error(`Duplicate backend migration name: ${migration.name}`);
    }
    versions.add(migration.version);
    names.add(migration.name);
  }
}

