import {
  adjustmentsToDocument,
  documentToAdjustments,
  isPhotoDocument,
  patchBaseAdjustments,
  type PhotoDocument,
} from '../engine/DocumentModel';
import { defaultAdjustments, type Adjustments } from '../types';
import type { EditRow, PhotoView } from '../storage/repos';

export interface FirstEditPorts {
  /** Fetches the original once and writes the hash to the catalogue row. */
  ensureContentHash: (photo: PhotoView) => Promise<string | null>;
  getMaster: (contentHash: string) => EditRow | null;
  upsertMaster: (args: {
    contentHash: string;
    copyIndex: number;
    copyName?: string;
    adjustments: Adjustments;
    document: PhotoDocument;
    history: Adjustments[];
    documentHistory: PhotoDocument[] | null;
  }) => void;
  queueThumbnail: (contentHash: string, adjustments: Adjustments, document: PhotoDocument) => void;
  /** Hands the identity to the editing hook. Deliberately the last step. */
  handOverHash: (contentHash: string) => void;
}

/** Patches waiting for an identity, plus the flag that keeps one run at a time. */
export interface FirstEditState {
  patch: Partial<Adjustments>;
  running: boolean;
}

export function createFirstEditState(): FirstEditState {
  return { patch: {}, running: false };
}

/**
 * The first edit of a photo whose identity does not exist yet.
 *
 * A remote library hands out no original until it has to (F022), so the
 * content hash comes into being here, at the first edit - not on selection.
 * That leaves a window in which the user has already moved a slider and there
 * is nothing to write it to, and the order out of that window is the whole
 * point of this function: the patch goes onto the MASTER ROW first, the hash
 * is handed to the editing hook afterwards. The other way round, handing the
 * hash over first makes the hook load the (still untouched) master from the
 * catalogue and the edit that started all this is gone.
 *
 * Patches that arrive while the original is still being fetched belong to the
 * same first edit and are merged into `state.patch` instead of starting a
 * second run.
 */
export async function runFirstEdit(
  photo: PhotoView,
  patch: Partial<Adjustments>,
  state: FirstEditState,
  ports: FirstEditPorts,
): Promise<string | null> {
  state.patch = { ...state.patch, ...patch };
  if (state.running) return null;
  state.running = true;
  try {
    const contentHash = await ports.ensureContentHash(photo);
    if (!contentHash) {
      state.patch = {};
      return null;
    }
    while (Object.keys(state.patch).length > 0) {
      const pending = state.patch;
      state.patch = {};
      const master = ports.getMaster(contentHash);
      const base = master?.document && isPhotoDocument(master.document)
        ? master.document
        : adjustmentsToDocument({ ...defaultAdjustments, ...(master?.adjustments ?? {}) });
      const document = patchBaseAdjustments(base, pending);
      const adjustments = documentToAdjustments(document);
      ports.upsertMaster({
        contentHash,
        copyIndex: 0,
        copyName: master?.copyName ?? undefined,
        adjustments,
        document,
        history: master?.history ?? [],
        documentHistory: master?.documentHistory ?? [],
      });
      ports.queueThumbnail(contentHash, adjustments, document);
    }
    ports.handOverHash(contentHash);
    return contentHash;
  } finally {
    state.running = false;
  }
}
