import type { DocumentUpdate, PhotoDocument } from '../engine/DocumentModel';

/**
 * The one place a document write is resolved.
 *
 * React state lags a render behind the handlers that write it: two
 * `{ ...photoDocument, oneField }` writes in the same handler both start from
 * the same rendered copy, and the second drops the first one's field. The
 * writer keeps the newest document itself and resolves every updater against
 * it on the spot, so the next write in the same tick already sees the last
 * one. An updater that hands `prev` back unchanged writes nothing.
 */
export interface DocumentWriter {
  /** The newest document, including writes React has not rendered yet. */
  readonly current: PhotoDocument;
  /** Resolve `next` against `current`, keep the result and hand it to the sink. */
  write(next: DocumentUpdate): PhotoDocument;
  /** Adopt a document that did not come from an edit (load, copy switch, undo): no sink call. */
  replace(doc: PhotoDocument): void;
}

export function createDocumentWriter(
  initial: PhotoDocument,
  sink: (next: PhotoDocument, prev: PhotoDocument) => void,
): DocumentWriter {
  let current = initial;
  return {
    get current() {
      return current;
    },
    write(next) {
      const prev = current;
      const resolved = typeof next === 'function' ? next(prev) : next;
      if (resolved === prev) return prev;
      current = resolved;
      sink(resolved, prev);
      return resolved;
    },
    replace(doc) {
      current = doc;
    },
  };
}
