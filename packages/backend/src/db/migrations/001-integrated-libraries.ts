import type { BackendMigration } from '../migrations.js';

export const integratedLibrariesMigration: BackendMigration = {
  version: 1,
  name: 'integrated-library-registry',
  up(db) {
    db.exec(`
      CREATE TABLE server_libraries (
        id TEXT PRIMARY KEY,
        ownerId TEXT NOT NULL,
        name TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('external', 'managed')),
        readOnly INTEGER NOT NULL DEFAULT 1 CHECK (readOnly IN (0, 1)),
        exclusionPatterns TEXT NOT NULL DEFAULT '[]',
        includeHidden INTEGER NOT NULL DEFAULT 0 CHECK (includeHidden IN (0, 1)),
        watchEnabled INTEGER NOT NULL DEFAULT 0 CHECK (watchEnabled IN (0, 1)),
        scanIntervalMinutes INTEGER NOT NULL DEFAULT 0 CHECK (scanIntervalMinutes >= 0),
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        status TEXT NOT NULL DEFAULT 'idle'
          CHECK (status IN ('idle', 'scanning', 'error', 'unavailable')),
        lastScanAt INTEGER,
        lastError TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE INDEX idx_server_libraries_owner
        ON server_libraries(ownerId, updatedAt DESC);

      CREATE TABLE server_library_roots (
        id TEXT PRIMARY KEY,
        libraryId TEXT NOT NULL,
        ownerId TEXT NOT NULL,
        path TEXT NOT NULL,
        canonicalPath TEXT NOT NULL,
        label TEXT NOT NULL,
        writable INTEGER NOT NULL DEFAULT 0 CHECK (writable IN (0, 1)),
        lastSeenAt INTEGER,
        lastError TEXT,
        createdAt INTEGER NOT NULL,
        UNIQUE(ownerId, canonicalPath)
      );

      CREATE INDEX idx_server_library_roots_library
        ON server_library_roots(ownerId, libraryId);

      CREATE TABLE server_library_scans (
        id TEXT PRIMARY KEY,
        libraryId TEXT NOT NULL,
        ownerId TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'full',
        status TEXT NOT NULL
          CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
        generation INTEGER NOT NULL DEFAULT 0,
        discovered INTEGER NOT NULL DEFAULT 0,
        added INTEGER NOT NULL DEFAULT 0,
        updated INTEGER NOT NULL DEFAULT 0,
        offline INTEGER NOT NULL DEFAULT 0,
        restored INTEGER NOT NULL DEFAULT 0,
        errors INTEGER NOT NULL DEFAULT 0,
        currentPath TEXT,
        cancelRequested INTEGER NOT NULL DEFAULT 0 CHECK (cancelRequested IN (0, 1)),
        startedAt INTEGER,
        finishedAt INTEGER,
        createdAt INTEGER NOT NULL,
        errorSummary TEXT
      );

      CREATE INDEX idx_server_library_scans_library
        ON server_library_scans(ownerId, libraryId, createdAt DESC);
    `);
  },
};

