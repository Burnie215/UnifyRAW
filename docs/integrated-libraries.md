# Integrated PhotoLib libraries

PhotoLib supports two server-side library modes through the same
`photolib-library` source provider. Its client configuration contains only an
opaque `libraryId`; it never contains a backend URL or an absolute server path.

This implementation was developed within the repository's MIT-only boundary.
The only Immich reference allowed for this feature is tag `v1.94.1`, commit
`07466fa7b7e3cc7696cd239db2507f1a08374fee`. The corresponding MIT text is in
`licenses/immich-v1.94.1-MIT.txt`. No later Immich implementation may be used as
a source for this code.

## Configuration

```env
PHOTOLIB_LIBRARY_ROOTS=/photos,/archive
PHOTOLIB_MANAGED_ROOT=/data/library
PHOTOLIB_THUMB_ROOT=/data/thumbs
PHOTOLIB_SCAN_CONCURRENCY=2
PHOTOLIB_MAX_IMPORT_BYTES=0
```

- `PHOTOLIB_LIBRARY_ROOTS` is the allowlist shown as opaque choices for an
  external library. Mount these paths read-only where possible.
- `PHOTOLIB_MANAGED_ROOT` stores managed originals, staging files and trash.
- `PHOTOLIB_THUMB_ROOT` stores disposable derived WebP thumbnails.
- `PHOTOLIB_MAX_IMPORT_BYTES=0` disables the additional per-file application
  limit. Free-space and declared-size checks still apply.

External roots may not overlap the database, managed root or thumbnail root.
Symlinks are not followed by scans, and every original request resolves and
checks the canonical path again.

## Modes

An external library indexes existing originals without modifying them. A full
scan reconciles added, changed, moved, missing and restored files while keeping
stable asset UUIDs. An unavailable root does not mark all of its assets
offline. Periodic safety scans can be configured in Settings → Sources.

A managed library imports browser files through a persisted three-stage job:

1. create an import record;
2. stream bytes to `.incoming` and verify the declared size;
3. validate the image signature, calculate SHA-256, deduplicate and atomically
   move the file below `originals/YYYY/YYYY-MM-DD`.

Partially uploaded files never enter the asset index. Uploading jobs are marked
failed after a backend restart and can be cancelled through the import API.
The settings page supports later imports and reports duplicates and failures.

Managed deletion first moves an original to `.trash`. Settings → Sources lists
trashed files and exposes separate Restore and two-step Delete permanently
actions. Removing a source or library registry never deletes managed originals.
Raw `DELETE /api/libraries/:id` requests therefore require the explicit
`preserveOriginals=true` confirmation.

A library registry cannot be removed while one of its scans or imports is
active; the API returns `409 LIBRARY_BUSY`. Scan creation, cancellation,
periodic progress and completion are persisted as checkpoints. Database saves
use a synced temporary file followed by an atomic rename, so an interrupted
write does not replace the last complete database image.

## Backup and restore

External libraries require a backup of `photolib.db`; thumbnails are optional
and regenerable. The external originals remain the storage owner's
responsibility.

Managed libraries require a consistent pair:

- the database configured by `DB_PATH`;
- the complete directory configured by `PHOTOLIB_MANAGED_ROOT`.

For a cold backup, stop the PhotoLib container, copy both items, then restart
it. For restore, stop PhotoLib, restore both to their original configured
locations and permissions, and start the container. Run “Check integrity” in
Settings → Sources afterward. The report initializes checksums for older
managed files and flags missing, unreadable or changed originals without
exposing their paths.

Never restore only the database or only the managed media root as the current
state. The thumbnail root may be discarded at any time.

## Relevant API groups

- registry and roots: `/api/libraries`, `/available-roots`, `/validate-root`
- scans and statistics: `/:id/scans`, `/:id/stats`
- snapshot and delta index: `/:id/assets`, `/:id/assets/changes`
- originals and thumbnails: `/:id/assets/:assetId/original|thumbnail`
- managed imports: `/:id/imports/...`
- trash and restore: `/:id/assets/:assetId/trash|restore`
- full managed checksum verification: `/:id/integrity-check`

All endpoints use the same authenticated owner scope as catalog sync. In
self-hosted anonymous mode that owner is `_anon`.
