import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${String(options.max)}` : key,
  }),
}));

import { RetouchTool } from './RetouchTool';
import { MAX_RETOUCH_SPOTS } from '../engine/graph';
import type { SpotRemoval } from '../engine/Mask';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; });

const spot = (id: string): SpotRemoval => ({
  id, mode: 'clone',
  target: { x: 0.5, y: 0.5, radius: 0.1 },
  source: { x: 0.2, y: 0.5 },
  feather: 0.5, opacity: 1,
});

function mount(
  spots: SpotRemoval[],
  onSpotAdd: (spot: Omit<SpotRemoval, 'id'>) => void,
): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  let root!: Root;
  act(() => {
    root = createRoot(host);
    root.render(createElement(RetouchTool, {
      active: true,
      mode: 'clone',
      spots,
      brushRadius: 20,
      onBrushRadiusChange: () => {},
      onSpotAdd,
      onSpotDelete: () => {},
      imageWidth: 200,
      imageHeight: 100,
    }));
  });
  cleanup = () => { act(() => root.unmount()); host.remove(); };
  return host;
}

describe('RetouchTool spot limit', () => {
  it('shows the shader limit and refuses another point pair', () => {
    const onSpotAdd = vi.fn();
    const host = mount(
      Array.from({ length: MAX_RETOUCH_SPOTS }, (_, i) => spot(`s${i}`)),
      onSpotAdd,
    );
    const tool = host.querySelector<HTMLElement>('.retouch-tool')!;
    tool.getBoundingClientRect = () => ({
      x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 100,
      width: 200, height: 100, toJSON: () => {},
    });

    act(() => {
      tool.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 50 }));
    });
    act(() => {
      tool.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 40, clientY: 50 }));
    });

    expect(tool.getAttribute('aria-disabled')).toBe('true');
    expect(host.querySelector('.retouch-phase')?.textContent)
      .toBe(`adjustments.retouch.limitReached:${MAX_RETOUCH_SPOTS}`);
    expect(onSpotAdd).not.toHaveBeenCalled();
  });
});
