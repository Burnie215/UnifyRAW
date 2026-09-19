import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PresetRow } from '../storage/repos';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { PresetsPanel } from './PresetsPanel';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

function preset(): PresetRow {
  return {
    id: 3,
    syncId: 'preset-3',
    name: 'Warm portrait',
    adjustments: { exposure: 0.2 },
    category: 'Portrait',
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  };
}

function mount() {
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  const props = {
    presets: [preset()],
    onApply: vi.fn(),
    onSave: vi.fn(),
    onDelete: vi.fn(),
    onExport: vi.fn(),
    onImport: vi.fn(),
  };
  act(() => root!.render(createElement(PresetsPanel, props)));
  // Categories start collapsed; the tiles only exist once one is open.
  act(() => host!.querySelector<HTMLButtonElement>('.preset-group-label')!.click());
  return props;
}

describe('preset tiles', () => {
  it('exports from the tile without applying the preset underneath it', () => {
    const props = mount();

    const exportButton = host!.querySelector<HTMLButtonElement>('.preset-thumb .preset-thumb-export');
    expect(exportButton, 'the grid view must offer the export the list view has').not.toBeNull();
    act(() => exportButton!.click());

    expect(props.onExport).toHaveBeenCalledTimes(1);
    expect(props.onExport.mock.calls[0][0]).toMatchObject({ id: 3, name: 'Warm portrait' });
    expect(props.onApply, 'the tile click must not fire through the export button').not.toHaveBeenCalled();
  });

  it('still applies the preset when the tile itself is clicked', () => {
    const props = mount();
    act(() => host!.querySelector<HTMLDivElement>('.preset-thumb')!.click());
    expect(props.onApply).toHaveBeenCalledTimes(1);
    expect(props.onExport).not.toHaveBeenCalled();
  });
});
