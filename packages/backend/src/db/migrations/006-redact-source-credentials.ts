import type { Database } from 'sql.js';
import { redactSourceConfigForSync } from '@photolib/shared';
import type { BackendMigration } from '../migrations.js';
import { tableExists, tableHasColumn } from './helpers.js';

export const redactSourceCredentialsMigration: BackendMigration = {
  version: 6,
  name: 'redact-source-credentials',
  up(db) {
    redactStoredSourceCredentials(db);
  },
};

export function redactStoredSourceCredentials(db: Database): void {
  if (!tableExists(db, 'sources') || !tableHasColumn(db, 'sources', 'userId')) return;
  const stmt = db.prepare('SELECT userId, id, config FROM sources');
  const updates: Array<[string, string, string]> = [];
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject() as { userId: string; id: string; config: string };
      updates.push([
        JSON.stringify(redactSourceConfigForSync(row.config)),
        row.userId,
        row.id,
      ]);
    }
  } finally {
    stmt.free();
  }
  for (const [config, userId, id] of updates) {
    // Keep updatedAt unchanged: redaction is a storage security migration,
    // not a user edit that should overwrite device-local credentials.
    db.run('UPDATE sources SET config = ? WHERE userId = ? AND id = ?', [config, userId, id]);
  }
}
