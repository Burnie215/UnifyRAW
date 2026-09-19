import type { BackendMigration } from '../migrations.js';
import { rows, tableExists } from './helpers.js';

export const reclaimDocumentHistoryMigration: BackendMigration = {
  version: 9,
  name: 'reclaim-edit-document-history',
  up(db) {
    if (!tableExists(db, 'edits')) return;
    const hasDocumentHistory = rows(db, 'PRAGMA table_info(edits)')
      .some((column) => column.name === 'documentHistory');
    if (!hasDocumentHistory) return;

    db.exec('UPDATE edits SET documentHistory = NULL');
  },
};
