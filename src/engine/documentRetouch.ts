/**
 * The two document edits the retouch tool makes, as pure functions.
 *
 * They live here rather than inside the hook for the same reason
 * `addMaskToDocument` does: the rules are worth testing, and a React hook is
 * not where a rule can be measured. The hook stays the three lines that turn a
 * click into one of these calls.
 */
import { MAX_RETOUCH_SPOTS } from './graph';
import type { SpotRemoval } from './Mask';
import type { PhotoDocument } from './DocumentModel';

/**
 * Put a spot on the document, with the id the caller minted.
 *
 * Returns the document unchanged when the list is full: the shader declares a
 * fixed number of discs, so this is a hard edge, and a refused spot is better
 * than one that is stored and never rendered.
 */
export function addRetouchSpot(
  document: PhotoDocument,
  spot: Omit<SpotRemoval, 'id'>,
  id: string,
): PhotoDocument {
  const spots = document.retouch ?? [];
  if (spots.length >= MAX_RETOUCH_SPOTS) return document;
  return { ...document, retouch: [...spots, { ...spot, id }] };
}

/**
 * Take a spot off the document. The last one takes the field with it: a
 * document carrying `retouch: []` is not the document it was before the first
 * spot — it hashes to a different export filename (`editStackFingerprint`)
 * and would not project back byte-identically.
 */
export function removeRetouchSpot(document: PhotoDocument, id: string): PhotoDocument {
  const spots = document.retouch ?? [];
  const left = spots.filter((s) => s.id !== id);
  if (left.length === spots.length) return document;
  if (left.length === 0) {
    const { retouch: _gone, ...rest } = document;
    return rest as PhotoDocument;
  }
  return { ...document, retouch: left };
}
