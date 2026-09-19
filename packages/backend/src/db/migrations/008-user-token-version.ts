import type { BackendMigration } from '../migrations.js';
import { ensureColumn, tableExists } from './helpers.js';

/**
 * Every token carries the version it was issued under; bumping the column
 * revokes all of a user's tokens at once. Existing rows start at 0, which is
 * also what a token without a version counts as, so the deploy logs no one out.
 */
export const userTokenVersionMigration: BackendMigration = {
  version: 8,
  name: 'user-token-version',
  up(db) {
    if (!tableExists(db, 'users')) return;
    ensureColumn(db, 'users', 'tokenVersion', 'INTEGER NOT NULL DEFAULT 0');
  },
};
