import { describe, expect, it } from 'vitest';
import { INITIAL_DENSITY, nextDensityLevel, type DensityState } from './useToolbarDensity';

const MAX = 3;

function step(state: DensityState, width: number, overflowing: boolean): DensityState {
  return nextDensityLevel(state, { width, overflowing, maxLevel: MAX });
}

describe('nextDensityLevel', () => {
  it('steps down one level per overflow until the bar fits', () => {
    let state = step(INITIAL_DENSITY, 700, true);
    expect(state.level).toBe(1);
    state = step(state, 700, true);
    expect(state.level).toBe(2);
    state = step(state, 700, false);
    expect(state.level).toBe(2);
  });

  it('stops at maxLevel and keeps the same state object', () => {
    let state: DensityState = { level: MAX, floors: [900, 800, 700] };
    const same = step(state, 400, true);
    expect(same).toBe(state);

    state = { level: 0, floors: [] };
    expect(step(state, 1400, false)).toBe(state);
  });

  it('only relaxes once the container clears the width that overflowed', () => {
    const state: DensityState = { level: 2, floors: [900, 800] };
    expect(step(state, 810, false).level).toBe(2);
    expect(step(state, 824, false).level).toBe(2);
    expect(step(state, 830, false).level).toBe(1);
  });

  it('does not oscillate between two neighbouring levels', () => {
    let state = step(INITIAL_DENSITY, 800, true);
    expect(state.level).toBe(1);
    // Level 1 fits at the very width that broke level 0 - without the floor the
    // bar would relax to 0, overflow again, and flicker forever.
    state = step(state, 800, false);
    expect(state.level).toBe(1);
    state = step(state, 800, false);
    expect(state.level).toBe(1);
  });

  it('clamps to a lowered maxLevel, e.g. when the layout switches to tablet', () => {
    const state: DensityState = { level: 3, floors: [900, 800, 700] };
    expect(nextDensityLevel(state, { width: 600, overflowing: true, maxLevel: 0 }).level).toBe(0);
  });
});
