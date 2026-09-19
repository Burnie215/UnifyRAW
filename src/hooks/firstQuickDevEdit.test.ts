import { describe, expect, it, vi } from 'vitest';
import { createFirstEditState, runFirstEdit, type FirstEditPorts } from './firstQuickDevEdit';
import { documentToAdjustments, type PhotoDocument } from '../engine/DocumentModel';
import type { EditRow, PhotoView } from '../storage/repos';
import type { Adjustments } from '../types';

function photo(overrides: Partial<PhotoView> = {}): PhotoView {
  return {
    id: 1, sourceId: 'immich-1', sourcePhotoId: 'asset-1', contentHash: null,
    name: 'DSCF1234.RAF', mimeType: 'image/x-fuji-raf', sizeBytes: 42_000_000,
    dateTaken: null, dateModified: null, sourcePath: null, availability: 'online',
    sourceRevision: 0, indexedAt: 0, updatedAt: 0, deletedAt: null,
    width: null, height: null, sourceBits: null, camera: null, lens: null, iso: null, focalLength: null,
    aperture: null, shutterSpeed: null, latitude: null, longitude: null, blurHash: null,
    stackId: null, stackPosition: null,
    rating: null, flag: null, colorLabel: null, keywords: [],
    ...overrides,
  };
}

/** Master rows keyed by hash, plus a log of the order the ports were used in. */
function harness(opts: { hash?: string | null; hashDelayTicks?: number } = {}) {
  const rows = new Map<string, EditRow>();
  const order: string[] = [];
  /** What the master row held at the moment the hash was handed over. */
  let masterAtHandover: EditRow | null | undefined;
  const ports: FirstEditPorts = {
    ensureContentHash: async () => {
      order.push('ensureContentHash');
      for (let i = 0; i < (opts.hashDelayTicks ?? 0); i++) await Promise.resolve();
      return opts.hash === undefined ? 'HASH1' : opts.hash;
    },
    getMaster: (hash) => rows.get(hash) ?? null,
    upsertMaster: (args) => {
      order.push('upsertMaster');
      rows.set(args.contentHash, {
        contentHash: args.contentHash,
        copyIndex: args.copyIndex,
        copyName: args.copyName ?? null,
        adjustments: args.adjustments,
        document: args.document,
        history: args.history,
        documentHistory: args.documentHistory,
        createdAt: 0, updatedAt: 0, deletedAt: null,
      });
    },
    queueThumbnail: () => { order.push('queueThumbnail'); },
    handOverHash: (hash) => {
      order.push('handOverHash');
      // The FIRST hand-over is the one the editing hook acts on; a later one
      // cannot repair a document it has already loaded.
      if (masterAtHandover === undefined) masterAtHandover = rows.get(hash) ?? null;
    },
  };
  return { rows, order, ports, handover: () => masterAtHandover };
}

describe('runFirstEdit', () => {
  it('has the edit on the master row already at the moment the hash is handed over', async () => {
    const h = harness();
    const hash = await runFirstEdit(photo(), { exposure: 40 }, createFirstEditState(), h.ports);

    expect(hash).toBe('HASH1');
    // Absolute: at the instant the hook was told the identity, the row it will
    // load already carried the edit. Nothing depends on a later write.
    expect(h.handover()).not.toBeNull();
    expect(documentToAdjustments(h.handover()!.document as PhotoDocument).exposure).toBe(40);
  });

  it('fetches, writes and only then hands the identity over', async () => {
    const h = harness();
    await runFirstEdit(photo(), { exposure: 40 }, createFirstEditState(), h.ports);
    expect(h.order).toEqual(['ensureContentHash', 'upsertMaster', 'queueThumbnail', 'handOverHash']);
  });

  it('keeps the patches that arrive while the original is still being fetched', async () => {
    const h = harness({ hashDelayTicks: 4 });
    const state = createFirstEditState();
    const first = runFirstEdit(photo(), { exposure: 40 }, state, h.ports);
    await Promise.resolve();
    // Second and third slider move land while ensureContentHash is in flight.
    await runFirstEdit(photo(), { contrast: 25 }, state, h.ports);
    await runFirstEdit(photo(), { exposure: 55 }, state, h.ports);
    await first;

    const master = h.rows.get('HASH1');
    expect(master).toBeDefined();
    const adj = documentToAdjustments(master!.document as PhotoDocument);
    expect(adj.exposure).toBe(55);
    expect(adj.contrast).toBe(25);
    // One fetch, one row write - not three.
    expect(h.order.filter((step) => step === 'ensureContentHash')).toHaveLength(1);
    expect(h.order.filter((step) => step === 'upsertMaster')).toHaveLength(1);
  });

  it('keeps an existing master edit and only patches the changed keys', async () => {
    const h = harness();
    h.ports.upsertMaster({
      contentHash: 'HASH1', copyIndex: 0, copyName: 'Kopie 1',
      adjustments: { saturation: 70 } as Adjustments,
      document: null as unknown as PhotoDocument,
      history: [], documentHistory: [],
    });
    h.order.length = 0;

    await runFirstEdit(photo(), { exposure: 40 }, createFirstEditState(), h.ports);

    const adj = documentToAdjustments(h.rows.get('HASH1')!.document as PhotoDocument);
    expect(adj.exposure).toBe(40);
    expect(adj.saturation).toBe(70);
    expect(h.rows.get('HASH1')!.copyName).toBe('Kopie 1');
  });

  it('hands over nothing when the photo cannot be identified', async () => {
    const h = harness({ hash: null });
    const state = createFirstEditState();
    const hash = await runFirstEdit(photo(), { exposure: 40 }, state, h.ports);

    expect(hash).toBeNull();
    expect(h.order).toEqual(['ensureContentHash']);
    expect(h.rows.size).toBe(0);
    // The patch is dropped with the run, not kept for an unrelated later photo.
    expect(state.patch).toEqual({});
  });

  it('runs the fetch once even when the user keeps dragging', async () => {
    const h = harness({ hashDelayTicks: 2 });
    const spy = vi.spyOn(h.ports, 'ensureContentHash');
    const state = createFirstEditState();
    await Promise.all([
      runFirstEdit(photo(), { exposure: 10 }, state, h.ports),
      runFirstEdit(photo(), { exposure: 20 }, state, h.ports),
      runFirstEdit(photo(), { exposure: 30 }, state, h.ports),
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(documentToAdjustments(h.rows.get('HASH1')!.document as PhotoDocument).exposure).toBe(30);
  });
});
