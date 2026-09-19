import { describe, expect, it } from 'vitest';

import { canonicalize, editStackFingerprint, editStackHash } from './editStackHash';
import { createDocument, createDocLayer, type DocLayer, type PhotoDocument } from '../engine/DocumentModel';
import { defaultAdjustments } from '../types';
import type { MaskDefinition } from '../engine/Mask';

const MASK: MaskDefinition = {
  id: 'm1', name: 'Radial', type: 'radial-gradient', visible: true,
  center: { x: 0.4, y: 0.6 }, radiusX: 0.3, radiusY: 0.25, feather: 0.5,
};

function docWith(...layers: Partial<DocLayer>[]): PhotoDocument {
  const base = createDocument();
  return {
    ...base,
    layers: [
      ...base.layers,
      ...layers.map((over, i) => ({
        ...createDocLayer('adjustment'), id: `L${i}`, ...over,
      })),
    ],
  };
}

const fingerprintOf = (doc: PhotoDocument | null) =>
  canonicalize(editStackFingerprint(doc, defaultAdjustments));

describe('editStackFingerprint', () => {
  /**
   * The bug this pins: the hash decides the export filename, and the source
   * skips a filename it already has. While only the flattened adjustments
   * were hashed, two versions differing in a layer were the same file — so
   * the second one never got uploaded.
   */
  it('separates two documents that differ only in a layer', () => {
    const withPreset = docWith({ adjustments: { saturation: 30 }, presetSyncId: 'kodak' });
    expect(fingerprintOf(withPreset)).not.toEqual(fingerprintOf(createDocument()));
  });

  it('separates two documents that differ only in a layer\'s opacity', () => {
    const a = docWith({ adjustments: { saturation: 30 }, opacity: 1 });
    const b = docWith({ adjustments: { saturation: 30 }, opacity: 0.5 });
    expect(fingerprintOf(a)).not.toEqual(fingerprintOf(b));
  });

  it('separates two documents that differ only in a retouch spot', () => {
    // The spots reach the exported pixels now (F009), so two documents that
    // differ in one may not share a filename — the source would skip the
    // second as "already there".
    const spot = {
      id: 's1', mode: 'heal' as const,
      target: { x: 0.5, y: 0.5, radius: 0.1 },
      source: { x: 0.2, y: 0.5 }, feather: 0.5, opacity: 1,
    };
    const a: PhotoDocument = { ...createDocument(), retouch: [spot] };
    const b: PhotoDocument = { ...a, retouch: [{ ...spot, target: { ...spot.target, x: 0.9 } }] };
    expect(fingerprintOf(a)).not.toEqual(fingerprintOf(b));
    // …and the spot's own id is not the difference: a fresh id changes no
    // pixel, exactly like a renamed layer.
    expect(fingerprintOf({ ...a, retouch: [{ ...spot, id: 'other' }] })).toEqual(fingerprintOf(a));
  });

  it('hashes a document with no spots exactly as it did before retouch existed', () => {
    // Otherwise every photo in every library gets a new export filename for
    // a feature it does not use.
    const plain = createDocument();
    expect(fingerprintOf({ ...plain, retouch: [] })).toEqual(fingerprintOf(plain));
  });

  it('separates a masked layer from an unmasked one', () => {
    const a = docWith({ adjustments: { exposure: 10 }, mask: null });
    const b = docWith({ adjustments: { exposure: 10 }, mask: MASK });
    expect(fingerprintOf(a)).not.toEqual(fingerprintOf(b));
  });

  it('ignores what changes no pixel: layer id and name', () => {
    const a = docWith({ id: 'L-a', name: 'Himmel', adjustments: { exposure: 10 } });
    const b = docWith({ id: 'L-b', name: 'Sky', adjustments: { exposure: 10 } });
    expect(fingerprintOf(a)).toEqual(fingerprintOf(b));
  });

  it('follows the graph when the document is graph-led', () => {
    const graph = {
      id: 'g', output: 'n1', nodes: [{ id: 'n1', kind: 'tone', params: { exposure: 0.2 } }],
      edges: [], metadata: { createdAt: 1, updatedAt: 2, revision: 3 },
    };
    const led: PhotoDocument = { ...createDocument(), pipelineMode: 'graph', pipelineGraph: graph };
    const other: PhotoDocument = {
      ...led,
      pipelineGraph: { ...graph, nodes: [{ id: 'n1', kind: 'tone', params: { exposure: 0.9 } }] },
    };
    expect(fingerprintOf(led)).not.toEqual(fingerprintOf(other));

    // Moving a node or bumping the revision is not an edit.
    const moved: PhotoDocument = {
      ...led,
      pipelineGraph: {
        ...graph,
        metadata: { createdAt: 9, updatedAt: 9, revision: 99, nodePositions: { n1: { x: 500, y: 40 } } },
      },
    };
    expect(fingerprintOf(moved)).toEqual(fingerprintOf(led));
  });

  it('ignores the size the graph happens to be stored at', () => {
    // A graph is built at whatever the preview measured, and
    // `buildDocumentGraph` replaces that geometry with the size the caller
    // renders at. Hashing it would hand the same edit a new filename on a
    // device with a different preview size, and the source would upload it
    // again for nothing.
    const source = {
      id: '__source.imageBitmap', kind: '__source.imageBitmap',
      params: { width: 1600, height: 1067, pixelRatio: 2 },
    };
    const graph = {
      id: 'g', output: 'n1',
      nodes: [source, { id: 'n1', kind: 'tone', params: { exposure: 0.2 } }],
      edges: [], metadata: { createdAt: 1, updatedAt: 2, revision: 3 },
    };
    const led: PhotoDocument = { ...createDocument(), pipelineMode: 'graph', pipelineGraph: graph };
    const smaller: PhotoDocument = {
      ...led,
      pipelineGraph: {
        ...graph,
        nodes: [{ ...source, params: { width: 300, height: 200, pixelRatio: 1 } }, graph.nodes[1]],
      },
    };
    expect(fingerprintOf(smaller)).toEqual(fingerprintOf(led));

    // A pass named `width` is a different matter — that one is an edit.
    const cropped: PhotoDocument = {
      ...led,
      pipelineGraph: {
        ...graph,
        nodes: [source, { id: 'n1', kind: 'tone', params: { exposure: 0.2, width: 10 } }],
      },
    };
    expect(fingerprintOf(cropped)).not.toEqual(fingerprintOf(led));
  });

  it('falls back to the plain adjustments without a document', () => {
    expect(editStackFingerprint(null, defaultAdjustments)).toBe(defaultAdjustments);
  });
});

describe('editStackHash', () => {
  it('is stable for the same stack and different for a changed one', async () => {
    const a = docWith({ adjustments: { saturation: 30 } });
    const b = docWith({ adjustments: { saturation: 31 } });
    const hashA = await editStackHash(editStackFingerprint(a, defaultAdjustments));
    const hashAgain = await editStackHash(editStackFingerprint(a, defaultAdjustments));
    const hashB = await editStackHash(editStackFingerprint(b, defaultAdjustments));
    expect(hashA).toBe(hashAgain);
    expect(hashA).not.toBe(hashB);
  });

  it('lands in a different hash space than v1 did', async () => {
    // The prefix bump is what keeps the new filenames apart from the old
    // ones; without it a photo exported under v1 would keep its stale file.
    const v1 = 'unifyraw-edit-stack-v1\n' + canonicalize(defaultAdjustments);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v1));
    const v1Hash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(await editStackHash(defaultAdjustments)).not.toBe(v1Hash);
  });
});
