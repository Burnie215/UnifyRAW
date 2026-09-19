/**
 * Photo stacks.
 *
 * A stack is an explicit grouping the user makes: several frames of one moment
 * that should occupy one tile in the library. Unlike RAW+JPEG pairing it is
 * stored — `photos.stackId` plus `photos.stackPosition` — and therefore travels
 * with the catalog and its sync. Position 0 is the head: the photo the library
 * shows while the stack is folded.
 *
 * Every rule lives here as a pure function, so "what is the head" and "what
 * gets folded away" can be tested without React and without a catalog. The
 * hook ([useStacking](../hooks/useStacking.ts)) only turns the plans below into
 * repository writes.
 */
import type { PhotoView } from '../storage/repos';

export interface PhotoStack {
  /** The shared `stackId` of all members. */
  id: string;
  /** Members in stack order; the head is first. */
  members: PhotoView[];
  /** The member the library shows for the whole stack. */
  head: PhotoView;
}

/** Stack members keyed by photo id; every member points at the same stack. */
export type StackIndex = ReadonlyMap<number, PhotoStack>;

export const EMPTY_STACK_INDEX: StackIndex = new Map();

const NO_EXPANDED_STACKS: ReadonlySet<string> = new Set();

/** One repository patch, shaped for `PhotoRepository.bulkUpdate`. */
export interface StackUpdate {
  id: number;
  patch: { stackId: string | null; stackPosition: number | null };
}

/**
 * How far apart two frames may be and still count as one burst. A camera
 * shooting continuously is well below this; two deliberate shots of the same
 * scene are well above it.
 */
export const BURST_THRESHOLD_MS = 1500;

/** Capture time, with the file time as the fallback an ordering needs. */
function captureTime(photo: PhotoView): number {
  return photo.dateTaken ?? photo.dateModified ?? 0;
}

/**
 * Stored order first, id as the tie-breaker. A row that never got a position
 * sorts last instead of silently claiming the head.
 */
function byStackOrder(a: PhotoView, b: PhotoView): number {
  const left = a.stackPosition ?? Number.MAX_SAFE_INTEGER;
  const right = b.stackPosition ?? Number.MAX_SAFE_INTEGER;
  return left !== right ? left - right : a.id - b.id;
}

export function buildStackIndex(photos: readonly PhotoView[]): StackIndex {
  const groups = new Map<string, PhotoView[]>();
  for (const photo of photos) {
    if (!photo.stackId) continue;
    const group = groups.get(photo.stackId);
    if (group) group.push(photo);
    else groups.set(photo.stackId, [photo]);
  }

  const index = new Map<number, PhotoStack>();
  for (const [id, members] of groups) {
    // A lone leftover — the remainder of a stack whose other members were
    // unstacked — is not a stack. Indexing it would fold a photo away behind a
    // badge reading "1".
    if (members.length < 2) continue;
    members.sort(byStackOrder);
    const stack: PhotoStack = { id, members, head: members[0] };
    for (const member of members) index.set(member.id, stack);
  }
  return index;
}

/**
 * Keeps one photo per stack — the head — and drops the rest. A stack whose id
 * is in `expanded` stays open, and a stack whose head was filtered away is led
 * by its first surviving member: folding must never make a photo disappear
 * from the library entirely.
 */
export function collapseStacks(
  photos: readonly PhotoView[],
  index: StackIndex,
  expanded: ReadonlySet<string> = NO_EXPANDED_STACKS,
): PhotoView[] {
  if (index.size === 0) return photos as PhotoView[];

  const present = new Set(photos.map((photo) => photo.id));
  const visibleHead = new Map<string, number>();
  for (const photo of photos) {
    const stack = index.get(photo.id);
    if (!stack || visibleHead.has(stack.id)) continue;
    const head = stack.members.find((member) => present.has(member.id));
    if (head) visibleHead.set(stack.id, head.id);
  }

  return photos.filter((photo) => {
    const stack = index.get(photo.id);
    if (!stack) return true;
    if (expanded.has(stack.id)) return true;
    return visibleHead.get(stack.id) === photo.id;
  });
}

/** Every member of `photoId`'s stack, or just the photo when it has none. */
export function stackMemberIds(photoId: number, index: StackIndex): number[] {
  const stack = index.get(photoId);
  return stack ? stack.members.map((member) => member.id) : [photoId];
}

export function isStackHead(photoId: number, index: StackIndex): boolean {
  return index.get(photoId)?.head.id === photoId;
}

/**
 * Numbers `photos` into one new stack, oldest frame first — the order a burst
 * was shot in. Fewer than two photos is not a stack and plans nothing.
 */
export function planCreateStack(photos: readonly PhotoView[], stackId: string): StackUpdate[] {
  if (photos.length < 2) return [];
  return [...photos]
    .sort((a, b) => (captureTime(a) - captureTime(b)) || (a.id - b.id))
    .map((photo, stackPosition) => ({ id: photo.id, patch: { stackId, stackPosition } }));
}

/** Clears the stack columns of every photo that actually carries them. */
export function planUnstack(photos: readonly PhotoView[]): StackUpdate[] {
  return photos
    .filter((photo) => !!photo.stackId)
    .map((photo) => ({ id: photo.id, patch: { stackId: null, stackPosition: null } }));
}

/**
 * Moves `photoId` to position 0 and renumbers the rest behind it, keeping the
 * positions a dense 0..n-1 run. A photo that already leads plans nothing.
 */
export function planSetStackHead(photoId: number, index: StackIndex): StackUpdate[] {
  const stack = index.get(photoId);
  if (!stack || stack.head.id === photoId) return [];

  const next = stack.members.find((member) => member.id === photoId);
  if (!next) return [];
  const reordered = [next, ...stack.members.filter((member) => member.id !== photoId)];

  const updates: StackUpdate[] = [];
  reordered.forEach((member, stackPosition) => {
    if (member.stackPosition === stackPosition) return;
    updates.push({ id: member.id, patch: { stackId: stack.id, stackPosition } });
  });
  return updates;
}

/**
 * Groups consecutive shots whose capture times lie within `thresholdMs` of
 * each other into one stack each. Only photos that are not stacked yet and
 * that carry a capture time take part — a file time says when the file was
 * written, which is not when the shutter fired.
 */
export function planAutoStack(
  photos: readonly PhotoView[],
  makeStackId: () => string,
  thresholdMs: number = BURST_THRESHOLD_MS,
): StackUpdate[] {
  const candidates = photos
    .filter((photo) => !photo.stackId && photo.dateTaken != null)
    .sort((a, b) => (a.dateTaken! - b.dateTaken!) || (a.id - b.id));

  const updates: StackUpdate[] = [];
  let burst: PhotoView[] = [];
  const flush = () => {
    if (burst.length >= 2) updates.push(...planCreateStack(burst, makeStackId()));
    burst = [];
  };

  for (const photo of candidates) {
    const previous = burst[burst.length - 1];
    if (previous && photo.dateTaken! - previous.dateTaken! > thresholdMs) flush();
    burst.push(photo);
  }
  flush();
  return updates;
}

/** How many distinct stacks a plan creates. */
export function plannedStackCount(updates: readonly StackUpdate[]): number {
  const ids = new Set<string>();
  for (const update of updates) {
    if (update.patch.stackId) ids.add(update.patch.stackId);
  }
  return ids.size;
}
