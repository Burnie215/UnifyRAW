import type { BackendMigration } from '../migrations.js';
import { ensureColumn } from './helpers.js';

/**
 * Carries the encoded source precision (currently HEIF) for catalogs that
 * already exist on the hub. A fresh database gets the column from the shared
 * catalog schema in migration 010; this one only reaches the older ones.
 */
export const photoSourceBitsMigration: BackendMigration = {
  version: 11,
  name: 'photo-source-bits',
  up(db) {
    ensureColumn(db, 'photos', 'sourceBits', 'INTEGER');
  },
};
