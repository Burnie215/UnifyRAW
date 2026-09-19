/**
 * May THIS selection be written back to its source?
 *
 * A push writes new assets into somebody's library, so the answer has to be
 * the same whether one photo is open in the editor or forty are ticked in the
 * grid. It is decided here, away from React, because the editor case used to
 * be the only one the app could answer: `pushToSourceCaps` looked at the open
 * photo and nothing else, which left the destination row invisible for every
 * grid selection.
 *
 * Two rules:
 *
 *  1. **Somebody has to be able to write.** A source needs `exportAsset` and
 *     has to declare `canWrite`; the caller folds both into `writable` so this
 *     file never has to know a `SourceProvider`.
 *  2. **One source, not several.** A mixed selection is refused even when
 *     every source in it could write. The dialog offers exactly one
 *     destination button with one label, while the export loop pushes each
 *     photo to the source it came from - a mixed batch would promise one
 *     target and write to several.
 *
 * The order matters for what the user gets told. `mixed-sources` is the only
 * refusal worth a sentence on screen, so it is reserved for the case where
 * un-mixing the selection would actually produce a push. A selection of
 * read-only sources reads as `source-read-only` whether it is mixed or not -
 * most libraries cannot write back, and a hint under nearly every export
 * would be noise.
 */

import type { SourceFormat } from './exportChoices';

/** The one fact about a source that a push depends on. */
export interface PushSourceInfo {
  /** Implements `exportAsset` AND declares `exportCapabilities.canWrite`. */
  writable: boolean;
  /** The name the destination button carries. */
  label: string;
  /**
   * What this target accepts. It rides along because the decision is what
   * resolves WHICH source the push goes to, and the dialog needs that answer
   * to know whether a 16-bit container is reachable at destination "source".
   */
  allowedFormats?: readonly SourceFormat[];
}

export type PushBlockedReason = 'no-photos' | 'mixed-sources' | 'source-read-only';

export type PushToSourceDecision =
  | { canPush: true; sourceId: string; label: string; allowedFormats?: readonly SourceFormat[] }
  | { canPush: false; reason: PushBlockedReason };

/**
 * @param photos  the originals an export would render, in any order
 * @param describeSource  what the app knows about one source id, or null when
 *                        no source is registered under it. Asked once per
 *                        distinct id, however long the selection is.
 */
export function decidePushToSource(
  photos: readonly { sourceId: string }[],
  describeSource: (sourceId: string) => PushSourceInfo | null,
): PushToSourceDecision {
  if (photos.length === 0) return { canPush: false, reason: 'no-photos' };

  const known = new Map<string, PushSourceInfo | null>();
  for (const photo of photos) {
    if (!known.has(photo.sourceId)) known.set(photo.sourceId, describeSource(photo.sourceId));
  }

  const writable: { sourceId: string; label: string; allowedFormats?: readonly SourceFormat[] }[] = [];
  for (const [sourceId, info] of known) {
    if (info?.writable) writable.push({ sourceId, label: info.label, allowedFormats: info.allowedFormats });
  }

  const [target] = writable;
  if (!target) return { canPush: false, reason: 'source-read-only' };
  if (known.size > 1) return { canPush: false, reason: 'mixed-sources' };
  return {
    canPush: true, sourceId: target.sourceId, label: target.label, allowedFormats: target.allowedFormats,
  };
}
