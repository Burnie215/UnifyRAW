/**
 * The toast a user-triggered source refresh leaves behind.
 *
 * One toast, because a second one pushes the first off the screen: the
 * outcome sentence (finished, or what the walk had to leave out) and, when
 * there is one, the sentence about photos the rescan brought back.
 *
 * A revival needs saying for the same reason a removal does. The 10-minute
 * background sync deliberately leaves removed photos removed; only a rescan
 * the user asked for reactivates them (F079), and without this sentence it
 * does so silently.
 *
 * An incomplete listing says WHY it is incomplete, because the three causes
 * ask different things of the user: an album without a name is his to fix, a
 * part that did not answer is the source's, and only the page cap is the
 * library being longer than one walk. One sentence claiming "too long" for
 * all three sent him looking in the wrong place.
 */

/** What `t` has to be able to do here - the i18next signature, narrowed. */
type Translate = (key: string, options: Record<string, unknown>) => string;

export interface RefreshOutcome {
  added: number;
  removed: number;
  /** Rows the user had removed that this walk reactivated. */
  revived: number;
  /** The walk reached the end AND left nothing out. */
  complete: boolean;
  /** Skipped albums the server carries without a name - the actionable part. */
  namelessAlbums: number;
  /** Skipped parts that simply did not answer: a page, a folder, an album. */
  failedParts: number;
}

export function refreshToastMessage(t: Translate, source: string, outcome: RefreshOutcome): string {
  const base = outcome.complete
    ? t('sources.refreshDone', { source, added: outcome.added, removed: outcome.removed })
    : outcome.namelessAlbums > 0
      ? t('sources.refreshPartialAlbumsWithoutName', { source, added: outcome.added, count: outcome.namelessAlbums })
      : outcome.failedParts > 0
        ? t('sources.refreshPartialFailedParts', { source, added: outcome.added, count: outcome.failedParts })
        // Nothing was skipped and the walk still stopped short: it ran out of pages.
        : t('sources.refreshPartialPageCap', { source, added: outcome.added });
  if (outcome.revived <= 0) return base;
  return `${base} ${t('sources.refreshRevived', { count: outcome.revived })}`;
}
