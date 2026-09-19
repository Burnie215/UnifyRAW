import { describe, expect, it, vi } from 'vitest';
import { editThumbnailKey } from '../cache/editThumbnailKey';
import {
  loadThumbnail,
  SOURCE_RETRIES,
  type ThumbnailLoadPorts,
  type ThumbnailLoadSource,
  type ThumbnailRequest,
} from './thumbnailLoad';

/**
 * The tile loader without React. Every question the old effect could only be
 * asked by rendering a grid - which step did it take, did it give its queue
 * slot back, what does it do when the tile scrolls away mid-flight - is a
 * direct call here.
 */

type Edit = { adjustments?: unknown; document?: unknown };

const blob = (text: string) => new Blob([text], { type: 'image/jpeg' });
const file = (size: number) => ({ size } as unknown as File);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeSource(over: Partial<ThumbnailLoadSource> = {}): ThumbnailLoadSource {
  return {
    getThumbnailUrl: async () => null,
    getFile: async () => null,
    ...over,
  };
}

function request(over: Partial<ThumbnailRequest> = {}): ThumbnailRequest {
  return {
    mode: 'auto',
    ref: { sourcePhotoId: 'p1', sourceId: 's1', name: 'IMG_1.ARW' },
    contentHash: 'hash1',
    stamp: null,
    isRaw: false,
    thumbKeys: ['src:current', 'src:previous'],
    ...over,
  };
}

function harness(options: {
  getSource?: () => ThumbnailLoadSource | null;
  stored?: Record<string, Blob>;
  memory?: Blob | null;
  edit?: Edit | null;
  fetchThumb?: (url: string) => Promise<Blob | null>;
  claimSourceSlot?: (value: Blob) => Promise<Blob>;
} = {}) {
  const shown: Blob[] = [];
  const phases: string[] = [];
  const stored = new Map(Object.entries(options.stored ?? {}));
  const state = {
    cancelled: false,
    memory: options.memory ?? null,
    hasEdit: null as boolean | null,
    baseRequests: 0,
    sidecarWrites: 0,
    waits: 0,
    taken: 0,
    given: 0,
  };

  const ports: ThumbnailLoadPorts<Edit> = {
    cancelled: () => state.cancelled,
    log: (phase) => { phases.push(phase); },
    readEdit: () => options.edit ?? null,
    setHasEdit: (value) => { state.hasEdit = value; },
    requestBaseThumbnail: () => { state.baseRequests++; },
    readStored: async (key) => stored.get(key) ?? null,
    writeStored: (key, value) => { stored.set(key, value); },
    readMemory: () => state.memory,
    writeMemory: (value) => { state.memory = value; },
    claimSourceSlot: options.claimSourceSlot ?? (async (value) => value),
    show: (value) => { shown.push(value); },
    getSource: options.getSource ?? (() => null),
    wait: async () => { state.waits++; },
    enqueue: async () => { state.taken++; },
    dequeue: () => { state.given++; },
    fetchThumb: options.fetchThumb ?? (async () => null),
    fromOriginal: async () => blob('generated'),
    onSidecarWritten: () => { state.sidecarWrites++; },
  };

  return { ports, shown, phases, stored, state };
}

describe('thumbnail load order', () => {
  it('prefers the developed rendering and never asks a source for it', async () => {
    const developed = blob('developed');
    const getSource = vi.fn(() => fakeSource());
    const h = harness({
      stored: { [editThumbnailKey('hash1', 'stamp-a')]: developed },
      getSource,
    });

    await loadThumbnail(request({ stamp: 'stamp-a', isRaw: true }), h.ports);

    expect(h.shown).toEqual([developed]);
    expect(h.state.memory).toBe(developed);
    expect(getSource).not.toHaveBeenCalled();
    expect(h.state.taken).toBe(0);
    expect(h.phases).toContain('EDIT-HIT');
  });

  it('reports the edit badge from the edits table, not from a developed thumbnail', async () => {
    const withEdit = harness({ edit: { adjustments: {} } });
    await loadThumbnail(request(), withEdit.ports);
    expect(withEdit.state.hasEdit).toBe(true);

    const without = harness({ edit: null });
    await loadThumbnail(request(), without.ports);
    expect(without.state.hasEdit).toBe(false);
  });

  it('asks for a developed rendering only for a stamped RAW without one', async () => {
    const stampedRaw = harness();
    await loadThumbnail(request({ stamp: 'stamp-a', isRaw: true }), stampedRaw.ports);
    expect(stampedRaw.state.baseRequests).toBe(1);

    const unstamped = harness();
    await loadThumbnail(request({ stamp: null, isRaw: true }), unstamped.ports);
    expect(unstamped.state.baseRequests).toBe(0);

    const jpeg = harness();
    await loadThumbnail(request({ stamp: 'stamp-a', isRaw: false }), jpeg.ports);
    expect(jpeg.state.baseRequests).toBe(0);
  });

  it('serves the memory cache without taking a queue slot', async () => {
    const cached = blob('cached');
    const getSource = vi.fn(() => fakeSource());
    const h = harness({ memory: cached, getSource });

    await loadThumbnail(request(), h.ports);

    expect(h.shown).toEqual([cached]);
    expect(getSource).not.toHaveBeenCalled();
    expect(h.state.taken).toBe(0);
    expect(h.phases).toContain('MEM-HIT');
  });

  it('serves a sidecar thumbnail without taking a queue slot', async () => {
    const sidecar = blob('sidecar');
    const getFile = vi.fn(async () => file(1024));
    const h = harness({
      getSource: () => fakeSource({ readSidecarThumb: async () => sidecar, getFile }),
    });

    await loadThumbnail(request(), h.ports);

    expect(h.shown).toEqual([sidecar]);
    expect(getFile).not.toHaveBeenCalled();
    expect(h.state.taken).toBe(0);
    expect(h.phases).toContain('CACHE-HIT');
  });

  it('falls through the source keys in order and stops at the first hit', async () => {
    const previous = blob('previous');
    const h = harness({
      stored: { 'src:previous': previous },
      getSource: () => fakeSource(),
    });

    await loadThumbnail(request(), h.ports);

    expect(h.shown).toEqual([previous]);
    expect(h.state.taken).toBe(0);
    expect(h.phases).toContain('REPO-HIT');
  });

  it('generates from the original, persists under the current key and writes the sidecar', async () => {
    const writeSidecarThumb = vi.fn(async () => true);
    const h = harness({
      getSource: () => fakeSource({ getFile: async () => file(2048), writeSidecarThumb }),
    });

    await loadThumbnail(request(), h.ports);

    expect(h.shown).toHaveLength(1);
    expect(h.stored.get('src:current')).toBe(h.shown[0]);
    expect(h.stored.has('src:previous')).toBe(false);
    expect(writeSidecarThumb).toHaveBeenCalledTimes(1);
    await flush();
    expect(h.state.sidecarWrites).toBe(1);
    expect(h.state.taken).toBe(1);
    expect(h.state.given).toBe(1);
  });

  it('keeps the developed rendering when it wins the shared slot during the fetch', async () => {
    const developed = blob('developed');
    const h = harness({
      getSource: () => fakeSource({
        getThumbnailUrl: async () => 'http://source/thumb',
      }),
      fetchThumb: async () => blob('camera-jpeg'),
      claimSourceSlot: async () => developed,
    });

    await loadThumbnail(request(), h.ports);

    expect(h.shown).toEqual([developed]);
    expect(h.phases).toContain('developed-won-the-race');
  });

  it('takes the camera picture unchecked in "show originals" mode', async () => {
    const camera = blob('camera-jpeg');
    const claimSourceSlot = vi.fn(async () => blob('developed'));
    const readEdit = vi.fn(() => null);
    const h = harness({
      memory: blob('developed-in-memory'),
      getSource: () => fakeSource({ readSidecarThumb: async () => camera }),
      claimSourceSlot,
    });
    h.ports.readEdit = readEdit;

    await loadThumbnail(request({ mode: 'source' }), h.ports);

    expect(h.shown).toEqual([camera]);
    expect(h.state.memory).toBe(camera);
    expect(claimSourceSlot).not.toHaveBeenCalled();
    expect(readEdit).not.toHaveBeenCalled();
    expect(h.state.baseRequests).toBe(0);
  });

  it('waits for a source that is still reconnecting, then gives up', async () => {
    let calls = 0;
    const late = harness({
      getSource: () => (++calls > 3 ? fakeSource() : null),
    });
    await loadThumbnail(request(), late.ports);
    expect(late.phases).not.toContain('no-source');

    const never = harness({ getSource: () => null });
    await loadThumbnail(request(), never.ports);
    expect(never.state.waits).toBe(SOURCE_RETRIES);
    expect(never.phases).toContain('no-source');
    expect(never.state.taken).toBe(0);
  });
});

describe('thumbnail load and the shared queue', () => {
  it('gives the slot back when the tile disappears while it waited for one', async () => {
    const getThumbnailUrl = vi.fn(async () => 'http://source/thumb');
    const h = harness({ getSource: () => fakeSource({ getThumbnailUrl }) });
    // The tile scrolls away between asking for a slot and getting one.
    h.ports.enqueue = async () => { h.state.taken++; h.state.cancelled = true; };

    await loadThumbnail(request(), h.ports);

    expect(getThumbnailUrl).not.toHaveBeenCalled();
    expect(h.shown).toEqual([]);
    expect(h.state.given).toBe(1);
    expect(h.phases).toContain('cancelled-in-queue');
  });

  it('gives the slot back exactly once when the decode fails', async () => {
    const h = harness({
      getSource: () => fakeSource({ getFile: async () => { throw new Error('offline'); } }),
    });

    await loadThumbnail(request(), h.ports);

    expect(h.shown).toEqual([]);
    expect(h.state.taken).toBe(1);
    expect(h.state.given).toBe(1);
    expect(h.phases).toContain('decode-error');
  });

  it('gives the slot back and paints nothing when the tile disappears during the decode', async () => {
    const h = harness({ getSource: () => fakeSource({ getFile: async () => file(4096) }) });
    h.ports.fromOriginal = async () => { h.state.cancelled = true; return blob('generated'); };

    await loadThumbnail(request(), h.ports);

    expect(h.shown).toEqual([]);
    expect(h.stored.has('src:current')).toBe(false);
    expect(h.state.given).toBe(1);
    expect(h.phases).toContain('not-displayed(cancelled=true)');
  });

  it('never takes a slot for a tile that is already gone', async () => {
    const h = harness({ getSource: () => fakeSource() });
    h.ports.readStored = async (key) => { if (key === 'src:previous') h.state.cancelled = true; return null; };

    await loadThumbnail(request(), h.ports);

    expect(h.state.taken).toBe(0);
    expect(h.state.given).toBe(0);
  });
});
