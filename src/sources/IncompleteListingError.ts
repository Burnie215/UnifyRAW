/**
 * What kind of part a listing had to leave out.
 *
 * The kind exists so the user can be told WHAT is wrong where that is
 * actionable: an album the server carries without a name is a thing the user
 * can go and name, while a page that did not answer is not. Everything else
 * stays `other` - the detail text is all there is to say about it.
 */
export type ListingSkipKind = 'album-without-name' | 'other';

/** One part of a listing that was skipped. */
export interface ListingSkip {
  readonly kind: ListingSkipKind;
  /** Which part: a page number, an album id and why. Used in the log message. */
  readonly detail: string;
}

/**
 * The same part reported twice is one skip. A walk can visit a page twice (a
 * scan takes a small first glance and then re-walks from page 1), and an
 * Immich page carries the album map's gaps with every page it answers - so
 * counting raw reports would tell the user "3 albums without a name" for one.
 */
export function dedupeSkips(skips: Iterable<ListingSkip>): ListingSkip[] {
  const byDetail = new Map<string, ListingSkip>();
  for (const skip of skips) if (!byDetail.has(skip.detail)) byDetail.set(skip.detail, skip);
  return [...byDetail.values()];
}

/** How many of these skips are albums the server answered without a name. */
export function countAlbumsWithoutName(skips: readonly ListingSkip[]): number {
  return skips.filter((skip) => skip.kind === 'album-without-name').length;
}

/**
 * How many of these skips are parts that simply did not answer - a page, a
 * folder, an album whose request failed. Nothing about them is actionable, so
 * the user hears how many there were and not what each one was.
 */
export function countFailedParts(skips: readonly ListingSkip[]): number {
  return skips.filter((skip) => skip.kind === 'other').length;
}

/**
 * Thrown by `listPhotos()` AFTER a walk that had to skip part of the source
 * (a failed page, an unreadable folder, an album that did not answer).
 * Everything reachable has been yielded by then, so callers keep it; the
 * listing just proves nothing about the photos it did not return, and a
 * reconcile must not drop them.
 */
export class IncompleteListingError extends Error {
  /** The skipped parts, with their kind. */
  readonly skips: readonly ListingSkip[];
  /** The skipped parts as plain text, in the same order. */
  readonly reasons: readonly string[];

  constructor(sourceName: string, skips: readonly ListingSkip[]) {
    const reasons = skips.map((skip) => skip.detail);
    super(`${sourceName}: listing incomplete, ${reasons.length} part(s) failed (${reasons.slice(0, 3).join('; ')})`);
    this.name = 'IncompleteListingError';
    this.skips = skips;
    this.reasons = reasons;
  }
}

/**
 * Collects the skipped parts of one listing. `finish()` throws when any were
 * recorded - unless the listing was aborted, which callers already detect on
 * their own signal and which must keep ending the listing quietly.
 */
export class ListingFailures {
  private readonly skips: ListingSkip[] = [];

  record = (detail: string, kind: ListingSkipKind = 'other'): void => {
    this.skips.push({ kind, detail });
  };

  finish(sourceName: string, signal?: AbortSignal): void {
    if (this.skips.length === 0 || signal?.aborted) return;
    throw new IncompleteListingError(sourceName, dedupeSkips(this.skips));
  }
}
