import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { CATALOG_SCHEMA_SQL, CATALOG_SCHEMA_VERSION, SYNC_TABLES, LOCAL_ONLY_TABLES } from './catalog-schema';
import fs from 'fs';
import path from 'path';

describe('catalog schema', () => {
  it('loads cleanly into a fresh sql.js DB', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.exec(CATALOG_SCHEMA_SQL);
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")[0];
    expect(tables.values.map((r) => r[0])).toContain('photos');
    expect(tables.values.map((r) => r[0])).toContain('photoMeta');
    expect(tables.values.map((r) => r[0])).toContain('schema_meta');
    expect(tables.values.map((r) => r[0])).toContain('exports');
    expect(CATALOG_SCHEMA_VERSION).toBe(6);
    db.close();
  });

  it('gives the export ledger one unique identity column and syncs it', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.exec(CATALOG_SCHEMA_SQL);
    // The upsert in ExportRepository names syncId as its conflict target, so
    // the ledger only reconciles a repeated export if the schema makes it unique.
    const unique = db.exec('PRAGMA index_list(exports)')[0].values
      .filter((row) => row[2] === 1)
      .map((row) => db.exec(`PRAGMA index_info(${String(row[1])})`)[0].values.map((info) => info[2]));
    expect(unique).toEqual([['syncId']]);
    expect(SYNC_TABLES).toContain('exports');
    expect(LOCAL_ONLY_TABLES).not.toContain('exports' as never);
    db.close();
  });

  it('inlined SQL matches the .sql source file (whitespace tolerant)', () => {
    const sqlFile = fs.readFileSync(path.join(__dirname, 'catalog-schema.sql'), 'utf8');
    const fromFile = stripComments(sqlFile);
    const fromTs = stripComments(CATALOG_SCHEMA_SQL);
    expect(normalize(fromTs)).toEqual(normalize(fromFile));
  });

  it('SYNC_TABLES + LOCAL_ONLY_TABLES cover every user table', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.exec(CATALOG_SCHEMA_SQL);
    const r = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")[0];
    const tables = new Set(r.values.map((row) => row[0] as string));
    tables.delete('schema_meta');
    const covered = new Set<string>([...SYNC_TABLES, ...LOCAL_ONLY_TABLES]);
    for (const t of tables) {
      expect(covered.has(t), `${t} should be in SYNC_TABLES or LOCAL_ONLY_TABLES`).toBe(true);
    }
    db.close();
  });

  it('every sync table has updatedAt + deletedAt', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.exec(CATALOG_SCHEMA_SQL);
    for (const t of SYNC_TABLES) {
      const cols = db.exec(`PRAGMA table_info(${t})`)[0];
      const names = cols.values.map((r) => r[1] as string);
      expect(names, `${t} must have updatedAt`).toContain('updatedAt');
      expect(names, `${t} must have deletedAt`).toContain('deletedAt');
    }
    db.close();
  });
});

function stripComments(s: string): string {
  // Strip `-- …` to end-of-line. No `--` appears inside SQL string literals
  // in our schema, so this is safe.
  return s.replace(/--[^\n]*/g, '');
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
