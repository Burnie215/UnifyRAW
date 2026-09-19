import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { LayerPanel } from './LayerPanel';
import { createDocLayer, type DocLayer } from '../engine/DocumentModel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

function openMenu(layer: DocLayer): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(createElement(LayerPanel, {
      layers: [layer],
      activeLayerId: layer.id,
      onSelectLayer: vi.fn(),
      onAddLayer: vi.fn(),
      onDeleteLayer: vi.fn(),
      onDuplicateLayer: vi.fn(),
      onToggleVisibility: vi.fn(),
      onToggleLock: vi.fn(),
      onOpacityChange: vi.fn(),
      onBlendModeChange: vi.fn(),
      onReorderLayers: vi.fn(),
      onRenameLayer: vi.fn(),
      onAddMask: vi.fn(),
    }));
  });
  act(() => {
    host!.querySelector('.layer-item')!.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      clientX: 20,
      clientY: 20,
    }));
  });
  return host;
}

function menuText(layer: DocLayer): string {
  return openMenu(layer).querySelector('.layer-context-menu')?.textContent ?? '';
}

describe('layer mask menu', () => {
  it('does not promise a mask for the base layer', () => {
    expect(menuText(createDocLayer('base'))).not.toContain('panels.layers.addBrushMask');
  });

  it('offers masks for an adjustment layer', () => {
    expect(menuText(createDocLayer('adjustment'))).toContain('panels.layers.addBrushMask');
  });
});
