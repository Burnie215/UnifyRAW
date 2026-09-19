import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { CropTool } from './CropTool';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; });

describe('CropTool persisted rectangle', () => {
  it('opens on the saved crop and confirms that exact rectangle without a drag', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onConfirm = vi.fn();
    let root!: Root;
    act(() => {
      root = createRoot(host);
      root.render(createElement(CropTool, {
        imageWidth: 1000,
        imageHeight: 500,
        aspect: 'free',
        initialCrop: { x: 0.1, y: 0.2, width: 0.7, height: 0.6 },
        onCropChange: () => {},
        onCropConfirm: onConfirm,
        onCancel: () => {},
      }));
    });
    cleanup = () => { act(() => root.unmount()); host.remove(); };

    const area = host.querySelector<HTMLElement>('.crop-area')!;
    expect([area.style.left, area.style.top, area.style.width, area.style.height])
      .toEqual(['10%', '20%', '70%', '60%']);

    act(() => host.querySelector<HTMLButtonElement>('.crop-confirm-btn')!.click());
    expect(onConfirm).toHaveBeenCalledWith({ x: 0.1, y: 0.2, width: 0.7, height: 0.6 });
  });
});
