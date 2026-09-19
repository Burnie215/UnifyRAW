import type { Database } from 'sql.js';
import type { BackendMigration } from '../migrations.js';

export const authRolesMigration: BackendMigration = {
  version: 4,
  name: 'auth-users-and-roles',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        passwordHash TEXT NOT NULL,
        salt TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
        createdAt INTEGER NOT NULL
      )
    `);

    if (!hasColumn(db, 'users', 'role')) {
      db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
    }

    // Existing installations pre-date roles. Promote exactly the oldest user
    // when no administrator exists, preserving access without granting every
    // legacy account global filesystem privileges.
    db.exec(`
      UPDATE users SET role = 'admin'
      WHERE id = (
        SELECT id FROM users ORDER BY createdAt ASC, id ASC LIMIT 1
      )
      AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')
    `);
  },
};

function hasColumn(db: Database, table: string, column: string): boolean {
  const stmt = db.prepare(`PRAGMA table_info(${table})`);
  let found = false;
  while (stmt.step()) {
    if (stmt.getAsObject().name === column) {
      found = true;
      break;
    }
  }
  stmt.free();
  return found;
}
