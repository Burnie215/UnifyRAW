import { describe, expect, it } from 'vitest';
import { historyStep, type HistoryState } from './editHistory';

// Three edits: D0 -> D1 -> D2. The list holds the states before D2.
const atTip: HistoryState<string> = { entries: ['D0', 'D1'], index: 2 };

function walk(start: HistoryState<string>, current: string, moves: number[]) {
  let state = start;
  let shown = current;
  const seen: string[] = [];
  for (const move of moves) {
    const step = historyStep(state, shown, state.index + move);
    if (!step) { seen.push('-'); continue; }
    state = step;
    shown = step.show;
    seen.push(shown);
  }
  return { state, shown, seen };
}

describe('historyStep', () => {
  it('reaches the newest state again after undoing past it', () => {
    const { seen, state } = walk(atTip, 'D2', [-1, -1, +1, +1]);
    expect(seen).toEqual(['D1', 'D0', 'D1', 'D2']);
    expect(state).toMatchObject({ entries: ['D0', 'D1'], index: 2 });
  });

  it('does nothing past either end', () => {
    expect(historyStep(atTip, 'D2', 3)).toBeNull();
    expect(walk(atTip, 'D2', [-1, -1, -1]).seen).toEqual(['D1', 'D0', '-']);
    expect(historyStep({ entries: [], index: 0 }, 'D0', -1)).toBeNull();
  });

  it('persists only the past of the state it shows', () => {
    const back = historyStep(atTip, 'D2', 1)!;
    expect(back.show).toBe('D1');
    expect(back.persisted).toEqual(['D0']);
    const home = historyStep(back, back.show, 2)!;
    expect(home.persisted).toEqual(['D0', 'D1']);
  });

  it('jumps straight to an earlier entry and back to the newest', () => {
    const jump = historyStep(atTip, 'D2', 0)!;
    expect(jump).toMatchObject({ show: 'D0', index: 0, entries: ['D0', 'D1', 'D2'] });
    const back = historyStep(jump, jump.show, 2)!;
    expect(back).toMatchObject({ show: 'D2', index: 2, entries: ['D0', 'D1'] });
  });
});
