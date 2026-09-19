import { CATALOG_SCHEMA_SQL } from '@photolib/shared';
import type { BackendMigration } from '../migrations.js';
import { applyUserIdOverlay } from '../user-id-overlay.js';
import {
  backfillLegacySyncIdentities,
  ensureSyncIdentitySchema,
} from './005-sync-identities.js';
import { redactStoredSourceCredentials } from './006-redact-source-credentials.js';
import { ensureSyncRevisionSchema } from './007-sync-revisions.js';
import { ensureColumn } from './helpers.js';

export const catalogSchemaOverlayMigration: BackendMigration = {
  version: 10,
  name: 'catalog-schema-user-id-overlay',
  up(db) {
    // Create/rebuild sync tables first so the canonical schema creates its
    // indexes against their final, per-user identity in the same transaction.
    const rebuiltLegacyTables = applyUserIdOverlay(db);
    db.exec(CATALOG_SCHEMA_SQL);
    ensureColumn(db, 'photos', 'sourcePath', 'TEXT');
    ensureColumn(db, 'photos', 'availability', "TEXT NOT NULL DEFAULT 'online'");
    ensureColumn(db, 'photos', 'sourceRevision', 'INTEGER NOT NULL DEFAULT 0');

    // Migrations 005-007 precede schema creation on a fresh database and guard
    // legacy tables without userId. Reassert their idempotent invariants now.
    ensureSyncIdentitySchema(db);
    if (rebuiltLegacyTables) backfillLegacySyncIdentities(db);
    redactStoredSourceCredentials(db);
    ensureSyncRevisionSchema(db, 'unnumbered');
  },
};
