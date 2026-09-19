import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * Counter that increments whenever the element's box changes size.
 *
 * Canvas drawing needs this: the bitmap is sized to the element's real width
 * (see {@link import('../image/hiDpiCanvas').prepareCanvas}), so a resize has
 * to trigger a redraw. Use the returned value as an effect dependency, or call
 * the hook and ignore it when the drawing effect already runs every render.
 */
export function useResizeTick(ref: RefObject<HTMLElement | null>): number {
  const [tick, setTick] = useState(0);
  const lastSize = useRef('');

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const size = `${Math.round(rect.width)}x${Math.round(rect.height)}`;
    if (size === lastSize.current) return;
    lastSize.current = size;
    setTick((t) => t + 1);
  }, [ref]);

  useLayoutEffect(measure);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  return tick;
}
