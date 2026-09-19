import { describe, expect, it } from 'vitest';
import { defaultAdjustments } from '../types';
import { SIDECAR_VERSION, buildSidecar, mergeSidecar, parseSidecar, serializeSidecar } from './Sidecar';
import { createDocument } from './DocumentModel';

const edit = (copyIndex: number, updatedAt: number) => ({
  copyIndex,
  adjustments: { ...defaultAdjustments, exposure: copyIndex },
  updatedAt,
});

describe('the sidecar a write produces', () => {
  it('carries the schema version, the photo it belongs to and the metadata verbatim', () => {
    const text = serializeSidecar(
      buildSidecar('9f8e7d6c', [edit(0, 1_700_000_000_000)], {
        rating: 4,
        flag: 'pick',
        colorLabel: 'green',
        keywords: ['Alpen', 'Sonne'],
      }),
    );

    // Absolute values, read off the written text: a round trip through
    // buildSidecar/parseSidecar would pass even if both agreed on a wrong shape.
    const written = JSON.parse(text);
    expect(written.version).toBe(1);
    expect(written.contentHash).toBe('9f8e7d6c');
    expect(written.rating).toBe(4);
    expect(written.flag).toBe('pick');
    expect(written.colorLabel).toBe('green');
    expect(written.keywords).toEqual(['Alpen', 'Sonne']);
    expect(written.edits).toHaveLength(1);
    expect(written.edits[0].updatedAt).toBe(1_700_000_000_000);
    expect(typeof written.updatedAt).toBe('number');
  });

  it('is the version parseSidecar accepts', () => {
    expect(SIDECAR_VERSION).toBe(1);
    expect(parseSidecar(serializeSidecar(buildSidecar('h', [], {})))?.contentHash).toBe('h');
  });

  it('round-trips the persisted crop inside the document edit', () => {
    const document = createDocument();
    document.transform.crop = { x: 0.1, y: 0.2, width: 0.7, height: 0.6 };
    const parsed = parseSidecar(serializeSidecar(buildSidecar('crop-hash', [
      { ...edit(0, 500), document },
    ])));

    expect(parsed?.edits[0].document?.transform.crop).toEqual(document.transform.crop);
  });

  it('adds export ledger entries without changing the sidecar version', () => {
    const written = JSON.parse(serializeSidecar(buildSidecar('export-hash', [], undefined, [{
      targetAssetId: 'asset-42',
      targetSourceId: 'immich-main',
      format: 'tif',
      editStackHash: 'edit-stack-9',
      filename: 'photo__edit-edit-sta.tif',
      uploadedAt: 1_700_000_000_000,
      bytes: 9_876_543,
    }])));

    expect(written.version).toBe(1);
    expect(written.exports).toEqual([{
      targetAssetId: 'asset-42',
      targetSourceId: 'immich-main',
      format: 'tif',
      editStackHash: 'edit-stack-9',
      filename: 'photo__edit-edit-sta.tif',
      uploadedAt: 1_700_000_000_000,
      bytes: 9_876_543,
    }]);
  });
});

describe('parseSidecar', () => {
  it('rejects the old PhotoWriteService format that had no version, hash or edits', () => {
    expect(parseSidecar('{"rating":4}')).toBeNull();
    expect(parseSidecar('{"version":1,"rating":4}')).toBeNull();
    expect(parseSidecar('{"version":1,"contentHash":"h"}')).toBeNull();
  });

  it('rejects a future schema version and anything that is not JSON', () => {
    expect(parseSidecar('{"version":2,"contentHash":"h","edits":[]}')).toBeNull();
    expect(parseSidecar('not json')).toBeNull();
  });
});

describe('mergeSidecar', () => {
  const sidecar = buildSidecar('h', [edit(0, 500), edit(1, 500)]);

  it('takes only the copies the sidecar has newer', () => {
    const { editsToApply } = mergeSidecar(sidecar, [{ copyIndex: 0, updatedAt: 900 }]);
    expect(editsToApply.map((e) => e.copyIndex)).toEqual([1]);
  });

  it('applies the metadata only when the sidecar is newer than every local edit', () => {
    expect(mergeSidecar({ ...sidecar, updatedAt: 1_000 }, [{ copyIndex: 0, updatedAt: 900 }]).metaToApply).toBe(true);
    expect(mergeSidecar({ ...sidecar, updatedAt: 800 }, [{ copyIndex: 0, updatedAt: 900 }]).metaToApply).toBe(false);
  });
});
