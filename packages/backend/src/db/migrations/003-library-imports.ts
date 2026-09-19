import type { BackendMigration } from '../migrations.js';

export const libraryImportsMigration: BackendMigration = {
  version: 3,
  name: 'managed-library-imports',
  up(db) {
    db.exec(`
      CREATE TABLE server_library_imports (
        id TEXT PRIMARY KEY,
        ownerId TEXT NOT NULL,
        libraryId TEXT NOT NULL,
        fileName TEXT NOT NULL,
        expectedSize INTEGER NOT NULL CHECK (expectedSize >= 0),
        receivedSize INTEGER NOT NULL DEFAULT 0 CHECK (receivedSize >= 0),
        expectedChecksum TEXT,
        dateModified INTEGER,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'uploading', 'uploaded', 'committed', 'failed', 'cancelled')),
        resultAssetId TEXT,
        errorCode TEXT,
        errorMessage TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE INDEX idx_server_library_imports_library
        ON server_library_imports(ownerId, libraryId, createdAt DESC);
    `);
  },
};
