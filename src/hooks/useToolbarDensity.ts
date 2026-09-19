import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Container-driven density for a single-row bar.
 *
 * A media query cannot see how much room a bar actually has: open side panels
 * take width the viewport knows nothing about, so a wide window can still leave
 * the grid toolbar too narrow for its controls. The level is therefore derived
 * from the bar's own box.
 *
 * Callers render level 0 (everything) down to `maxLevel`, each step strictly
 * narrower than the one before it.
 */
export interface DensityState {
  level: number;
  /** Per level: the widest container width at which that level still overflowed. */
  floors: number[];
}

/**
 * Extra room required before stepping back to a richer level. Without it the bar
 * oscillates: level N+1 fits, so it drops to N, which overflows, and so on.
 */
const RELAX_MARGIN_PX = 24;

const OVERFLOW_TOLERANCE_PX = 1;

export const INITIAL_DENSITY: DensityState = { level: 0, floors: [] };

export function nextDensityLevel(
  state: DensityState,
  { width, overflowing, maxLevel }: { width: number; overflowing: boolean; maxLevel: number },
): DensityState {
  const { level, floors } = state;

  if (level > maxLevel) return { level: maxLevel, floors };

  if (overflowing) {
    if (level >= maxLevel) return state;
    const nextFloors = floors.slice();
    nextFloors[level] = Math.max(nextFloors[level] ?? 0, width);
    return { level: level + 1, floors: nextFloors };
  }

  if (level === 0) return state;
  const floor = floors[level - 1] ?? 0;
  if (width <= floor + RELAX_MARGIN_PX) return state;
  return { level: level - 1, floors };
}

/** Whether the node sits outside normal flow (itself or via an ancestor). */
function isOutOfFlow(node: HTMLElement, stopAt: HTMLElement): boolean {
  for (let el: HTMLElement | null = node; el && el !== stopAt; el = el.parentElement) {
    const position = getComputedStyle(el).position;
    if (position === 'absolute' || position === 'fixed') return true;
  }
  return false;
}

/**
 * True when anything paints outside the box it belongs to.
 *
 * Measured from rects rather than `scrollWidth`: a squeezed flex section keeps
 * `scrollWidth === clientWidth` while its own children (a nowrap label, a select
 * at its min-width) already stick out and paint over the next section — which is
 * exactly the state that has to trigger a density step.
 */
function overflows(el: HTMLElement): boolean {
  if (el.scrollWidth > el.clientWidth + OVERFLOW_TOLERANCE_PX) return true;

  for (const section of Array.from(el.children)) {
    if (!(section instanceof HTMLElement)) continue;
    const box = section.getBoundingClientRect();
    if (box.width === 0) continue;
    // Every descendant, not just the direct children: a control can keep its own
    // box inside the section while the label and select inside it stick out.
    for (const node of Array.from(section.querySelectorAll<HTMLElement>('*'))) {
      const rect = node.getBoundingClientRect();
      if (rect.width === 0) continue;
      if (rect.right <= box.right + OVERFLOW_TOLERANCE_PX
        && rect.left >= box.left - OVERFLOW_TOLERANCE_PX) continue;
      // Popovers and badges are meant to leave the bar; only in-flow content
      // sticking out means the bar has run out of room.
      if (!isOutOfFlow(node, section)) return true;
    }
  }
  return false;
}

export function useToolbarDensity<T extends HTMLElement>(maxLevel: number) {
  const ref = useRef<T | null>(null);
  const [state, setState] = useState<DensityState>(INITIAL_DENSITY);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const width = el.clientWidth;
    if (width === 0) return;
    setState((prev) => nextDensityLevel(prev, { width, overflowing: overflows(el), maxLevel }));
  }, [maxLevel]);

  // After every render, so a level change is re-checked until the bar fits.
  // nextDensityLevel returns the same object when nothing changes, which lets
  // React bail out instead of looping.
  useLayoutEffect(measure);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  return { ref, level: state.level };
}
