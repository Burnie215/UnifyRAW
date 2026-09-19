/**
 * Undo/redo over a list of earlier states.
 *
 * `entries` holds the states before the one on screen. At `index ===
 * entries.length` the screen shows the newest state, which lives outside the
 * list; stepping back from there has to put it into the list first, or no
 * redo can ever reach it again. Arriving back at that newest state takes it
 * out again, so the list is the plain past once more.
 */
export interface HistoryState<T> {
  entries: T[];
  index: number;
}

export interface HistoryStep<T> extends HistoryState<T> {
  /** The state to show now. */
  show: T;
  /** The past of `show`: what a reload should offer to undo. */
  persisted: T[];
}

export function historyStep<T>(state: HistoryState<T>, current: T, target: number): HistoryStep<T> | null {
  if (target === state.index) return null;
  const entries = state.index === state.entries.length ? [...state.entries, current] : state.entries;
  if (target < 0 || target >= entries.length) return null;
  if (target === entries.length - 1) {
    const past = entries.slice(0, -1);
    return { entries: past, index: past.length, show: entries[target], persisted: past };
  }
  return { entries, index: target, show: entries[target], persisted: entries.slice(0, target) };
}
