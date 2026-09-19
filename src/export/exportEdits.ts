import { defaultAdjustments, type Adjustments } from '../types';
import { documentToAdjustments, type PhotoDocument } from '../engine/DocumentModel';
import { loadDocument } from '../engine/loadEditDocument';

export interface OpenEditorState {
  photoId: number | null | undefined;
  adjustments: Adjustments;
  document: PhotoDocument | null;
}

type StoredEdit = { adjustments: Adjustments; document?: PhotoDocument | null };

/**
 * The edits a photo is exported with. The open photo takes the editor's live
 * state, which can be newer than its stored row while a save is debounced;
 * every other photo takes its own stored master edit, or none at all.
 */
export function exportEditsFor(
  photo: { id: number; contentHash: string | null },
  open: OpenEditorState,
  getMaster: (contentHash: string) => StoredEdit | null,
): { adjustments: Adjustments; document: PhotoDocument | null } {
  if (open.photoId != null && photo.id === open.photoId) {
    return { adjustments: open.adjustments, document: open.document };
  }
  const edit = photo.contentHash ? getMaster(photo.contentHash) : null;
  if (!edit) return { adjustments: { ...defaultAdjustments }, document: null };
  const document = loadDocument(edit);
  return { adjustments: documentToAdjustments(document), document };
}
