import { CATALOG_SCHEMA_SQL } from '@photolib/shared';
import type { BackendMigration } from '../migrations.js';
import { applyUserIdOverlay } from '../user-id-overlay.js';
import { ensureSyncRevisionSchema } from './007-sync-revisions.js';
import { tableExists, tableHasColumn } from './helpers.js';

/**
 * The export ledger joins the sync set, so a device learns what another one
 * has already written back to a source.
 *
 * A hub that is already at migration 010 carries `exports`, but in the shape
 * the shared schema gave a local-only table then: no userId, no revision, one
 * ledger for every account. Neither the overlay rebuild nor
 * CREATE TABLE IF NOT EXISTS would reach it again, so this migration runs the
 * table through the same steps 010 ran the other eight through, and adds the
 * (userId, revision) index that 007 only creates for tables that exist when it
 * runs. On a fresh database 010 already built it that way and every step here
 * finds its work done.
 */
export const exportLedgerSyncMigration: BackendMigration = {
  version: 12,
  name: 'export-ledger-sync',
  up(db) {
    // No route ever wrote this table on the hub, so it is empty in practice.
    // A row that is there anyway predates the identity column and must not be
    // rebuilt with an empty one, which the per-user unique key would refuse:
    // derive it the way exportSyncId does in the client.
    if (tableExists(db, 'exports') && !tableHasColumn(db, 'exports', 'syncId')) {
      db.exec('ALTER TABLE exports ADD COLUMN syncId TEXT');
      db.exec(`UPDATE exports SET syncId =
        contentHash || '/' || copyIndex || '/' || targetSourceId || '/' || editStackHash || '/' || format`);
    }
    applyUserIdOverlay(db);
    // The rebuild drops the table and its indexes; the canonical schema puts
    // the ones it declares back.
    db.exec(CATALOG_SCHEMA_SQL);
    ensureSyncRevisionSchema(db, 'unnumbered');
  },
};
