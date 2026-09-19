// MIRROR of packages/shared/src/catalog-schema.sql.
// Inlined here so both frontend (Vite) and backend (Node) can consume the
// schema as a string without bundler-specific raw imports. Keep in sync:
// catalog-schema.test.ts compares this mirror with the .sql source after
// stripping comments and normalizing whitespace.

export const CATALOG_SCHEMA_VERSION = 6;

export const CATALOG_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  addedAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sources_updatedAt ON sources(updatedAt);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sourceId TEXT NOT NULL REFERENCES sources(id),
  sourcePhotoId TEXT NOT NULL,
  contentHash TEXT,
  name TEXT NOT NULL,
  mimeType TEXT,
  sizeBytes INTEGER,
  dateTaken INTEGER,
  dateModified INTEGER,
  sourcePath TEXT,
  availability TEXT NOT NULL DEFAULT 'online',
  sourceRevision INTEGER NOT NULL DEFAULT 0,
  indexedAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER,
  width INTEGER,
  height INTEGER,
  sourceBits INTEGER,
  camera TEXT,
  lens TEXT,
  iso INTEGER,
  focalLength REAL,
  aperture REAL,
  shutterSpeed TEXT,
  latitude REAL,
  longitude REAL,
  blurHash TEXT,
  stackId TEXT,
  stackPosition INTEGER,
  UNIQUE(sourceId, sourcePhotoId)
);
CREATE INDEX IF NOT EXISTS idx_photos_hash ON photos(contentHash);
CREATE INDEX IF NOT EXISTS idx_photos_source ON photos(sourceId);
CREATE INDEX IF NOT EXISTS idx_photos_dateTaken ON photos(dateTaken DESC);
CREATE INDEX IF NOT EXISTS idx_photos_updatedAt ON photos(updatedAt);
CREATE INDEX IF NOT EXISTS idx_photos_stackId ON photos(stackId);

CREATE TABLE IF NOT EXISTS photoMeta (
  contentHash TEXT PRIMARY KEY,
  rating INTEGER,
  flag TEXT,
  colorLabel TEXT,
  keywords TEXT,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_photoMeta_updatedAt ON photoMeta(updatedAt);

CREATE TABLE IF NOT EXISTS edits (
  contentHash TEXT NOT NULL,
  copyIndex INTEGER NOT NULL DEFAULT 0,
  copyName TEXT,
  adjustments TEXT NOT NULL,
  document TEXT,
  history TEXT NOT NULL DEFAULT '[]',
  documentHistory TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER,
  PRIMARY KEY (contentHash, copyIndex)
);
CREATE INDEX IF NOT EXISTS idx_edits_updatedAt ON edits(updatedAt);

CREATE TABLE IF NOT EXISTS presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  syncId TEXT NOT NULL,
  name TEXT NOT NULL,
  adjustments TEXT NOT NULL,
  category TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_presets_updatedAt ON presets(updatedAt);
CREATE INDEX IF NOT EXISTS idx_presets_syncId ON presets(syncId);

CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  syncId TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  parentId INTEGER REFERENCES collections(id),
  rules TEXT,
  photoIds TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_collections_updatedAt ON collections(updatedAt);
CREATE INDEX IF NOT EXISTS idx_collections_parentId ON collections(parentId);
CREATE INDEX IF NOT EXISTS idx_collections_syncId ON collections(syncId);

CREATE TABLE IF NOT EXISTS developProfiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  syncId TEXT NOT NULL,
  name TEXT NOT NULL,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  isoFrom INTEGER,
  isoTo INTEGER,
  adjustments TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_developProfiles_updatedAt ON developProfiles(updatedAt);
CREATE INDEX IF NOT EXISTS idx_developProfiles_syncId ON developProfiles(syncId);

CREATE TABLE IF NOT EXISTS lensProfiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  syncId TEXT NOT NULL,
  name TEXT NOT NULL,
  key TEXT NOT NULL,
  focalFrom REAL,
  focalTo REAL,
  coefficients TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_lensProfiles_updatedAt ON lensProfiles(updatedAt);
CREATE INDEX IF NOT EXISTS idx_lensProfiles_syncId ON lensProfiles(syncId);

CREATE TABLE IF NOT EXISTS exports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  syncId TEXT NOT NULL,
  contentHash TEXT NOT NULL,
  copyIndex INTEGER NOT NULL DEFAULT 0,
  targetSourceId TEXT NOT NULL,
  targetAssetId TEXT NOT NULL,
  targetUrl TEXT,
  format TEXT NOT NULL,
  editStackHash TEXT NOT NULL,
  filename TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok',
  uploadedAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER,
  UNIQUE(syncId)
);
CREATE INDEX IF NOT EXISTS idx_exports_updatedAt ON exports(updatedAt);
CREATE INDEX IF NOT EXISTS idx_exports_hash ON exports(contentHash);

CREATE TABLE IF NOT EXISTS thumbIndex (
  contentHash TEXT NOT NULL,
  size TEXT NOT NULL,
  binId TEXT NOT NULL,
  offset INTEGER NOT NULL,
  length INTEGER NOT NULL,
  PRIMARY KEY (contentHash, size)
);

CREATE TABLE IF NOT EXISTS exifScan (
  photoId INTEGER PRIMARY KEY REFERENCES photos(id),
  scannedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS faces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  photoId INTEGER NOT NULL REFERENCES photos(id),
  x REAL NOT NULL,
  y REAL NOT NULL,
  width REAL NOT NULL,
  height REAL NOT NULL,
  confidence REAL NOT NULL,
  embedding TEXT,
  clusterId INTEGER,
  name TEXT,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_faces_photoId ON faces(photoId);
CREATE INDEX IF NOT EXISTS idx_faces_clusterId ON faces(clusterId);
`;

/** Names of tables that participate in /api/sync — i.e. carry updatedAt + deletedAt. */
export const SYNC_TABLES = ['sources', 'photos', 'photoMeta', 'edits', 'presets', 'developProfiles', 'lensProfiles', 'collections', 'exports'] as const;

/** Names of tables that live only locally (never synced). */
export const LOCAL_ONLY_TABLES = ['thumbIndex', 'exifScan', 'faces'] as const;

export type SyncTableName = (typeof SYNC_TABLES)[number];
export type LocalOnlyTableName = (typeof LOCAL_ONLY_TABLES)[number];
