import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhotoView } from '../../storage/repos';

const fixture = vi.hoisted(() => ({
  getFile: vi.fn(),
  schedule: vi.fn(),
}));

vi.mock('../../hooks/useThumbnail', () => ({
  useThumbnail: () => ({ url: undefined, hasEdit: false }),
}));
vi.mock('../../engine/RawDecoder', () => ({
  RawDecoder: { isRawFile: (name: string) => name.toLowerCase().endsWith('.dng') },
}));
vi.mock('../../engine/raw', () => ({
  prefetchManager: {
    subscribe: () => () => {},
    isCompleted: () => false,
    hasInFlight: () => false,
    schedule: fixture.schedule,
  },
  getSmartPreviewSize: () => 1200,
  isLocalRawSourceType: () => false,
  hoverPrefetchAllowed: () => true,
}));
vi.mock('../../sources', () => ({
  sourceManager: { get: () => ({ type: 'immich', getFile: fixture.getFile }) },
}));
vi.mock('../../contexts/AdaptiveLayoutContext', () => ({
  useAdaptiveLayout: () => ({ hoverAvailable: true }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { TileItem } from './TileItem';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const photo = {
  id: 1,
  sourceId: 'immich',
  sourcePhotoId: 'asset-1',
  name: 'IMG_0001.DNG',
  contentHash: null,
  availability: 'online',
  dateTaken: null,
  indexedAt: 1,
  updatedAt: 1,
} as PhotoView;

let host: HTMLDivElement | null = null;
let root: Root | null = null;

function mountTile(): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(createElement(TileItem, {
      photo,
      selected: false,
      multiSelect: false,
      tileSize: 180,
      onSelect: () => {},
      onOpen: () => {},
    }));
  });
  return host.querySelector<HTMLElement>('.tile')!;
}

function unmount(): void {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
}

async function startHover(tile: HTMLElement): Promise<void> {
  act(() => tile.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  unmount();
  vi.useRealTimers();
});

describe('TileItem RAW hover ownership', () => {
  it('aborts an active original read when its tile unmounts', async () => {
    let received: AbortSignal | undefined;
    let release!: (file: File | null) => void;
    const pending = new Promise<File | null>((resolve) => { release = resolve; });
    fixture.getFile.mockImplementation(async (_ref, signal?: AbortSignal) => {
      received = signal;
      return pending;
    });

    await startHover(mountTile());
    expect(received).toBeInstanceOf(AbortSignal);

    unmount();
    expect(received?.aborted).toBe(true);
    await act(async () => {
      release(new File(['raw'], photo.name));
      await Promise.resolve();
    });

    expect(fixture.schedule).not.toHaveBeenCalled();
  });

  it('still cancels a scheduled preview job when its tile unmounts', async () => {
    const cancelPrefetch = vi.fn();
    fixture.getFile.mockResolvedValue(new File(['raw'], photo.name));
    fixture.schedule.mockReturnValue(cancelPrefetch);

    await startHover(mountTile());
    expect(fixture.schedule).toHaveBeenCalledOnce();

    unmount();
    expect(cancelPrefetch).toHaveBeenCalledOnce();
  });
});
