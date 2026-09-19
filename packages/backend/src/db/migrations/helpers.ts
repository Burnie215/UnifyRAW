import type { Database } from 'sql.js';

export type SqlParam = string | number | null;

export function tableExists(db: Database, table: string): boolean {
  return firstRow(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [table],
  ) !== null;
}

export function ensureColumn(db: Database, table: string, column: string, definition: string): void {
  if (!tableHasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function tableHasColumn(db: Database, table: string, column: string): boolean {
  return rows(db, `PRAGMA table_info(${table})`).some((entry) => entry.name === column);
}

export function rows(db: Database, sql: string, params: SqlParam[] = []): Array<Record<string, unknown>> {
  const stmt = db.prepare(sql);
  try {
    if (params.length > 0) stmt.bind(params);
    const result: Array<Record<string, unknown>> = [];
    while (stmt.step()) result.push(stmt.getAsObject() as Record<string, unknown>);
    return result;
  } finally {
    stmt.free();
  }
}

export function firstRow(db: Database, sql: string, params: SqlParam[] = []): Record<string, unknown> | null {
  return rows(db, sql, params)[0] ?? null;
}
