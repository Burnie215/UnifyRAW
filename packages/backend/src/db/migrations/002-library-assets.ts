import type { BackendMigration } from '../migrations.js';

export const libraryAssetsMigration: BackendMigration = {
  version: 2,
  name: 'integrated-library-assets',
  up(db) {
    db.exec(`
      CREATE TABLE server_library_assets (
        id TEXT PRIMARY KEY,
        ownerId TEXT NOT NULL,
        libraryId TEXT NOT NULL,
        rootId TEXT NOT NULL,
        relativePath TEXT NOT NULL,
        fileName TEXT NOT NULL,
        extension TEXT NOT NULL,
        mimeType TEXT,
        size INTEGER NOT NULL,
        mtimeMs INTEGER NOT NULL,
        inode INTEGER,
        quickHash TEXT,
        fullChecksum TEXT,
        width INTEGER,
        height INTEGER,
        orientation INTEGER,
        dateTaken INTEGER,
        metadataJson TEXT,
        sidecarRelativePath TEXT,
        status TEXT NOT NULL DEFAULT 'online'
          CHECK (status IN ('online', 'offline', 'error', 'trashed', 'importing')),
        scanGeneration INTEGER NOT NULL,
        firstSeenGeneration INTEGER NOT NULL,
        lastSeenAt INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        thumbVersion INTEGER NOT NULL DEFAULT 1,
        errorCode TEXT,
        errorMessage TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        trashedAt INTEGER,
        UNIQUE(libraryId, rootId, relativePath)
      );

      CREATE INDEX idx_server_library_assets_revision
        ON server_library_assets(ownerId, libraryId, revision, id);
      CREATE INDEX idx_server_library_assets_status
        ON server_library_assets(ownerId, libraryId, status);
      CREATE INDEX idx_server_library_assets_hash
        ON server_library_assets(ownerId, libraryId, quickHash, size);
      CREATE INDEX idx_server_library_assets_generation
        ON server_library_assets(ownerId, libraryId, rootId, scanGeneration);
    `);
  },
};

