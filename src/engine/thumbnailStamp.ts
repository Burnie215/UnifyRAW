/**
 * The identity of everything that develops a RAW without the user having
 * touched it: the base-development profile and the measured lens profile.
 *
 * A developed thumbnail is stored under the photo's content hash, and that
 * hash does not move when a profile does. Before profiles existed there was
 * nothing to go stale; now there is, and the gallery would keep serving the
 * old rendering under an unchanged key while the editor shows the new one.
 *
 * Putting the stamp in the key rather than deleting on write is what makes
 * this correct in the case nobody can hook: a profile arriving from another
 * device through sync. `onEditPulled` re-renders pulled edits
 * ([StorageContext.tsx:252](../contexts/StorageContext.tsx)), but there is no
 * equivalent for a pulled profile - and with the stamp there does not need to
 * be one. The key simply stops matching and the tile re-renders itself.
 *
 * Photos with no profile get no stamp at all, so their key stays exactly what
 * it was and no existing thumbnail is invalidated by introducing this.
 */
import { developProfileFor } from './developProfileStore';
import { measuredLensProfileFor } from './lensProfileStore';
import type { DevelopProfileSubject } from './developProfile';
import type { LensSubject } from './lensProfile';
import { RawDecoder } from './RawDecoder';

export type StampSubject = DevelopProfileSubject & LensSubject;

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * A short, deterministic stamp for the profiles covering this photo, or null
 * when none do.
 *
 * Deliberately derived from profile content (`syncId` + `updatedAt`) and not
 * from `developProfileRevision()`: that counter is session-local and restarts
 * at 0 on every reload, so a key built on it would discard every developed
 * thumbnail each time the app starts.
 */
export function thumbnailStampFor(subject: StampSubject): string | null {
  // Only RAW is stamped. `developProfileFor` already refuses anything else,
  // and the lens correction rides on the raw16 source too - a JPEG whose lens
  // happens to be measured renders identically either way, so stamping it
  // would retire a thumbnail to replace it with the same picture.
  if (!RawDecoder.isRawFile(subject.name)) return null;
  const develop = developProfileFor(subject);
  const lens = measuredLensProfileFor(subject);
  if (!develop && !lens) return null;
  const parts = [
    develop ? `d${develop.syncId}:${develop.updatedAt}` : 'd-',
    lens ? `l${lens.syncId}:${lens.updatedAt}` : 'l-',
  ];
  return fnv1a(parts.join('|'));
}
