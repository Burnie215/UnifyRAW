-- PhotoLib catalog.sqlite schema (v4)
--
-- Canonical Client schema used by all three CatalogStorage transports
-- (Memory, Filesystem, OPFS). The Sync-Hub Backend derives its nine sync
-- tables (SYNC_TABLES in catalog-schema.ts) from this schema:
-- packages/backend/src/services/db.ts reads their columns, adds the
-- BACKEND_OVERLAY columns from sync-protocol.ts and a per-user key.
-- Hub-only columns come from packages/backend/src/db/migrations/.
-- packages/backend/src/services/db.schema.test.ts keeps both in step.
--
-- Conventions
--   * camelCase identifiers throughout, matching the TypeScript row types
--     in src/storage/repos/types.ts, the frontend's catalog row types.
--     Round-trip without column-name mapping.
--   * Every sync-relevant table carries `updatedAt INTEGER NOT NULL` and
--     `deletedAt INTEGER NULL`. LWW compares `updatedAt`; rows with
--     `deletedAt IS NOT NULL` are treated as deleted and propagated as
--     tombstones. Old tombstones are compacted by the Phase 6 job.
--   * Local-only tables are never sent through /api/sync. They are all
--     recomputable from this device's files (thumbIndex, exifScan, faces) and
--     carry no sync lifecycle columns.
--
-- Schema versioning: bumped via schema_meta('version', '<n>'). Initial
-- value '1' is inserted by the runtime, not by this file, so the file
-- stays idempotent under CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- sources: registered photo backends (Immich, Lychee, LocalSource, ...)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,                 -- UUID
  type TEXT NOT NULL,                  -- 'immich' | 'lychee' | 'local' | ...
  label TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',   -- JSON: source-specific; plaintext unless the whole catalog file is encrypted
  addedAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sources_updatedAt ON sources(updatedAt);

-- ---------------------------------------------------------------------------
-- photos: cache of what we have indexed from each source
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sourceId TEXT NOT NULL REFERENCES sources(id),
  sourcePhotoId TEXT NOT NULL,         -- ID on the source side
  contentHash TEXT,                    -- SHA-256(first 64 KiB + size); LWW-key for user-metadata
  name TEXT NOT NULL,
  mimeType TEXT,
  sizeBytes INTEGER,
  dateTaken INTEGER,
  dateModified INTEGER,
  sourcePath TEXT,                     -- relative source path; never an absolute server path
  availability TEXT NOT NULL DEFAULT 'online',
  sourceRevision INTEGER NOT NULL DEFAULT 0,
  indexedAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER,
  -- Image dimensions
  width INTEGER,
  height INTEGER,
  sourceBits INTEGER,                  -- encoded source precision; 0 = probed, unknown; NULL = not probed yet
  -- EXIF
  camera TEXT,
  lens TEXT,
  iso INTEGER,
  focalLength REAL,
  aperture REAL,
  shutterSpeed TEXT,                   -- stored as string (e.g. '1/250') to preserve rational fractions
  latitude REAL,
  longitude REAL,
  -- Presentation
  blurHash TEXT,                       -- inline ~20-30 char placeholder
  -- Stacking
  stackId TEXT,                        -- shared by all photos in a stack; NULL = standalone
  stackPosition INTEGER,               -- 0 = representative
  UNIQUE(sourceId, sourcePhotoId)
);
CREATE INDEX IF NOT EXISTS idx_photos_hash ON photos(contentHash);
CREATE INDEX IF NOT EXISTS idx_photos_source ON photos(sourceId);
CREATE INDEX IF NOT EXISTS idx_photos_dateTaken ON photos(dateTaken DESC);
CREATE INDEX IF NOT EXISTS idx_photos_updatedAt ON photos(updatedAt);
CREATE INDEX IF NOT EXISTS idx_photos_stackId ON photos(stackId);

-- ---------------------------------------------------------------------------
-- photoMeta: user metadata keyed by content hash (LWW per-content)
-- Same photo on two devices via different sources shares its metadata.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS photoMeta (
  contentHash TEXT PRIMARY KEY,
  rating INTEGER,
  flag TEXT,                           -- 'pick' | 'reject' | NULL
  colorLabel TEXT,                     -- 'red' | 'yellow' | 'green' | 'blue' | 'purple' | NULL
  keywords TEXT,                       -- JSON array of strings
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_photoMeta_updatedAt ON photoMeta(updatedAt);

-- ---------------------------------------------------------------------------
-- edits: Adjustments + PhotoDocument + history per (contentHash, copyIndex).
-- copyIndex=0 is the master edit; >=1 are virtual copies.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS edits (
  contentHash TEXT NOT NULL,
  copyIndex INTEGER NOT NULL DEFAULT 0,
  copyName TEXT,                       -- display name for virtual copies
  adjustments TEXT NOT NULL,           -- JSON: flat Adjustments
  document TEXT,                       -- JSON: PhotoDocument (v8+); when present, takes precedence
  history TEXT NOT NULL DEFAULT '[]',  -- JSON array of Adjustments
  documentHistory TEXT,                -- JSON array of PhotoDocument (v8+); paired with `document`
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER,
  PRIMARY KEY (contentHash, copyIndex)
);
CREATE INDEX IF NOT EXISTS idx_edits_updatedAt ON edits(updatedAt);

-- ---------------------------------------------------------------------------
-- presets: saved Adjustments recipes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  syncId TEXT NOT NULL,
  name TEXT NOT NULL,
  adjustments TEXT NOT NULL,           -- JSON: Partial<Adjustments>
  category TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_presets_updatedAt ON presets(updatedAt);
CREATE INDEX IF NOT EXISTS idx_presets_syncId ON presets(syncId);

-- ---------------------------------------------------------------------------
-- collections: manual albums + smart filters; can be nested via parentId
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  syncId TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,                  -- 'manual' | 'smart'
  parentId INTEGER REFERENCES collections(id),
  rules TEXT,                          -- JSON: CollectionRule[] for smart filters
  photoIds TEXT,                       -- JSON: number[] for manual collections
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_collections_updatedAt ON collections(updatedAt);
CREATE INDEX IF NOT EXISTS idx_collections_parentId ON collections(parentId);
CREATE INDEX IF NOT EXISTS idx_collections_syncId ON collections(syncId);

-- ---------------------------------------------------------------------------
-- developProfiles: base development per camera or per RAW format.
--
-- Not presets. A preset is an edit the user applies and can take off again;
-- a profile is the RAW converter's own rendering of a sensor and runs
-- underneath the sliders, which is why a photo that has one still shows
-- every slider at zero. Keyed by `scope` + `key` (a normalised camera name
-- or a file extension), optionally narrowed to an ISO band.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS developProfiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  syncId TEXT NOT NULL,
  name TEXT NOT NULL,
  scope TEXT NOT NULL,                 -- 'camera' | 'extension'
  key TEXT NOT NULL,                   -- normalised camera name, or extension without the dot
  isoFrom INTEGER,                     -- inclusive; NULL = no lower bound
  isoTo INTEGER,                       -- inclusive; NULL = no upper bound
  adjustments TEXT NOT NULL,           -- JSON: Partial<Adjustments>
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_developProfiles_updatedAt ON developProfiles(updatedAt);
CREATE INDEX IF NOT EXISTS idx_developProfiles_syncId ON developProfiles(syncId);

-- ---------------------------------------------------------------------------
-- lensProfiles: measured lens corrections, keyed by lens and focal range.
--
-- Separate from developProfiles because it is a different measurement of a
-- different object: eight Brown-Conrady coefficients for a piece of glass,
-- not a partial adjustment set for a sensor. They take precedence over the
-- approximated built-ins in src/engine/LensCorrection.ts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lensProfiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  syncId TEXT NOT NULL,
  name TEXT NOT NULL,
  key TEXT NOT NULL,                   -- normalised lens name
  focalFrom REAL,                      -- inclusive mm; NULL = no lower bound
  focalTo REAL,                        -- inclusive mm; NULL = no upper bound
  coefficients TEXT NOT NULL,          -- JSON: k1..k3, v1..v3, caR, caB
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_lensProfiles_updatedAt ON lensProfiles(updatedAt);
CREATE INDEX IF NOT EXISTS idx_lensProfiles_syncId ON lensProfiles(syncId);

-- ---------------------------------------------------------------------------
-- exports: durable ledger of rendered assets written back to a source, so
-- every device knows what has already left the app.
--
-- A ledger entry is identified by the export it describes: which original,
-- which copy, which target source, which edit stack, which format. `syncId`
-- is that identity as one string (`exportSyncId` in
-- src/storage/repos/ExportRepository.ts). Deriving it rather than drawing a
-- UUID is what makes the row mergeable: two devices that make the same export
-- write the same syncId, so LWW settles them into one row instead of leaving
-- a duplicate the unique key would then refuse. It also gives the upsert its
-- conflict target - a retry or a provider's "already exists" answer updates
-- the entry it belongs to.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS exports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  syncId TEXT NOT NULL,                -- the five identity columns as one string
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

-- ---------------------------------------------------------------------------
-- thumbIndex (LOCAL-ONLY): locator for thumbs in append-only bin files.
-- Per (contentHash, size), points into thumbs/<size>/<binId>.bin.
-- Never sent through sync (offsets are per-file-layout).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS thumbIndex (
  contentHash TEXT NOT NULL,
  size TEXT NOT NULL,                  -- 'small' | 'large'
  binId TEXT NOT NULL,                 -- '00'..'ff' (contentHash hex prefix)
  offset INTEGER NOT NULL,
  length INTEGER NOT NULL,
  PRIMARY KEY (contentHash, size)
);

-- ---------------------------------------------------------------------------
-- exifScan (LOCAL-ONLY): photos whose file this device has already read for
-- EXIF, whether or not the file turned out to carry any.
--
-- It records work done on the files of this device, which is why it stays out
-- of the sync set: a device that has never seen a file must not inherit
-- "already scanned" and leave its capture metadata empty forever. Rows are
-- keyed by the local photo id (AUTOINCREMENT, never reused), like faces.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS exifScan (
  photoId INTEGER PRIMARY KEY REFERENCES photos(id),
  scannedAt INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- faces (LOCAL-ONLY): face detection results per photo.
-- Embeddings are large and recomputable from the source image, so faces
-- live next to thumbIndex outside the sync set.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS faces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  photoId INTEGER NOT NULL REFERENCES photos(id),
  x REAL NOT NULL,                     -- bounding box, normalized 0..1
  y REAL NOT NULL,
  width REAL NOT NULL,
  height REAL NOT NULL,
  confidence REAL NOT NULL,            -- 0..1
  embedding TEXT,                      -- JSON: 128-dim number[]
  clusterId INTEGER,
  name TEXT,                           -- user-assigned person
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_faces_photoId ON faces(photoId);
CREATE INDEX IF NOT EXISTS idx_faces_clusterId ON faces(clusterId);
