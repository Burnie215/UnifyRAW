import { integratedLibrariesMigration } from './001-integrated-libraries.js';
import { libraryAssetsMigration } from './002-library-assets.js';
import { libraryImportsMigration } from './003-library-imports.js';
import { authRolesMigration } from './004-auth-roles.js';
import { syncIdentitiesMigration } from './005-sync-identities.js';
import { redactSourceCredentialsMigration } from './006-redact-source-credentials.js';
import { syncRevisionsMigration } from './007-sync-revisions.js';
import { userTokenVersionMigration } from './008-user-token-version.js';
import { reclaimDocumentHistoryMigration } from './009-reclaim-document-history.js';
import { catalogSchemaOverlayMigration } from './010-catalog-schema-overlay.js';
import { photoSourceBitsMigration } from './011-photo-source-bits.js';
import { exportLedgerSyncMigration } from './012-export-ledger-sync.js';

export const BACKEND_MIGRATIONS = [
  integratedLibrariesMigration,
  libraryAssetsMigration,
  libraryImportsMigration,
  authRolesMigration,
  syncIdentitiesMigration,
  redactSourceCredentialsMigration,
  syncRevisionsMigration,
  userTokenVersionMigration,
  reclaimDocumentHistoryMigration,
  catalogSchemaOverlayMigration,
  photoSourceBitsMigration,
  exportLedgerSyncMigration,
] as const;
