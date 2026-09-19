import { describe, expect, it } from 'vitest';
import type { PhotoMetaRow, PhotoRow, PresetRow } from '../storage/repos';
import type { PhotoRef } from '../sources/types';
import { planIngest } from './useSources';
import { DEFAULT_IMPORT_PRESET, type ImportPreset } from './useImportPreset';
import {
  findDevelopPreset,
  planImportPresetEdits,
  planImportPresetMeta,
  type AddedPhoto,
} from './importPresetPlan';

function preset(patch: Partial<ImportPreset> = {}): ImportPreset {
  return { ...DEFAULT_IMPORT_PRESET, ...patch };
}

function meta(contentHash: string, patch: Partial<PhotoMetaRow> = {}): PhotoMetaRow {
  return {
    contentHash,
    rating: null,
    flag: null,
    colorLabel: null,
    keywords: [],
    updatedAt: 1,
    deletedAt: null,
    ...patch,
  };
}

function metaMap(...rows: PhotoMetaRow[]): Map<string, PhotoMetaRow> {
  return new Map(rows.map((row) => [row.contentHash, row]));
}

const added: AddedPhoto[] = [{ id: 1, contentHash: 'hash-a' }];

const FULL_PRESET = preset({
  defaultRating: 3,
  defaultFlag: 'pick',
  defaultLabel: 'green',
  defaultKeywords: ['Import', '2026'],
});

describe('planImportPresetMeta', () => {
  it('writes every default the tab carries onto a fresh photo', () => {
    expect(planImportPresetMeta(added, FULL_PRESET, metaMap())).toEqual([{
      contentHash: 'hash-a',
      patch: { rating: 3, flag: 'pick', colorLabel: 'green', keywords: ['Import', '2026'] },
    }]);
  });

  it('writes nothing when the tab is at its defaults', () => {
    expect(planImportPresetMeta(added, preset(), metaMap())).toEqual([]);
  });

  it('treats rating 0 as "no rating", the way the tab labels it', () => {
    expect(planImportPresetMeta(added, preset({ defaultRating: 0 }), metaMap())).toEqual([]);
  });

  it('leaves a rating, flag and label the photo already carries alone', () => {
    const existing = metaMap(meta('hash-a', { rating: 5, flag: 'reject', colorLabel: 'red' }));
    expect(planImportPresetMeta(added, FULL_PRESET, existing)).toEqual([{
      contentHash: 'hash-a',
      patch: { keywords: ['Import', '2026'] },
    }]);
  });

  it('merges keywords instead of replacing them', () => {
    const existing = metaMap(meta('hash-a', { keywords: ['Urlaub', 'Import'] }));
    expect(planImportPresetMeta(added, preset({ defaultKeywords: ['Import', 'Neu'] }), existing)).toEqual([{
      contentHash: 'hash-a',
      patch: { keywords: ['Urlaub', 'Import', 'Neu'] },
    }]);
  });

  it('asks for no write when the keywords are already there', () => {
    const existing = metaMap(meta('hash-a', { keywords: ['Import'] }));
    expect(planImportPresetMeta(added, preset({ defaultKeywords: [' Import '] }), existing)).toEqual([]);
  });

  it('skips a row that has no content hash yet - photoMeta is keyed by it', () => {
    const withoutHash: AddedPhoto[] = [{ id: 7, contentHash: null }];
    expect(planImportPresetMeta(withoutHash, FULL_PRESET, metaMap())).toEqual([]);
  });

  it('writes one patch per hash, not per row', () => {
    const twice: AddedPhoto[] = [{ id: 1, contentHash: 'hash-a' }, { id: 2, contentHash: 'hash-a' }];
    expect(planImportPresetMeta(twice, FULL_PRESET, metaMap())).toHaveLength(1);
  });

  it('ignores a colour label the tab does not offer', () => {
    expect(planImportPresetMeta(added, preset({ defaultLabel: 'chartreuse' }), metaMap())).toEqual([]);
  });
});

describe('a second scan of the same source', () => {
  const refs: PhotoRef[] = [
    { sourceId: 's', sourcePhotoId: 'p1', name: 'p1.jpg', contentHash: 'hash-a' },
  ];

  /** What `ingestBatch` hands the import preset: the rows this listing created. */
  function ingest(known: Map<string, PhotoRow>): AddedPhoto[] {
    const plan = planIngest('s', refs, known, 1_700_000_000_000);
    return plan.additions.map((addition, index) => {
      const row = { ...addition, id: index + 1, updatedAt: 1, deletedAt: null } as PhotoRow;
      known.set(addition.sourcePhotoId, row);
      return { id: row.id, contentHash: row.contentHash };
    });
  }

  it('does not take the user\'s rating and keywords back to the import defaults', () => {
    const known = new Map<string, PhotoRow>();

    const firstRun = planImportPresetMeta(ingest(known), FULL_PRESET, metaMap());
    expect(firstRun).toHaveLength(1);

    // The user rates the photo 5 and gives it a keyword of their own.
    const afterUser = metaMap(meta('hash-a', {
      rating: 5,
      flag: 'reject',
      colorLabel: 'red',
      keywords: ['Import', '2026', 'Portfolio'],
    }));

    // Same source listed again: the photo is an update now, not an addition.
    const secondRun = ingest(known);
    expect(secondRun).toEqual([]);
    expect(planImportPresetMeta(secondRun, FULL_PRESET, afterUser)).toEqual([]);
  });
});

describe('findDevelopPreset', () => {
  const presets = [
    { id: 1, syncId: 'a', name: 'Warm', adjustments: {}, category: null } as PresetRow,
    { id: 2, syncId: 'b', name: 'Kalt', adjustments: {}, category: null } as PresetRow,
  ];

  it('resolves the tab\'s name to the preset row', () => {
    expect(findDevelopPreset(presets, ' Kalt ')?.id).toBe(2);
  });

  it('answers null for "none" and for a preset that was deleted', () => {
    expect(findDevelopPreset(presets, '')).toBeNull();
    expect(findDevelopPreset(presets, 'Weg')).toBeNull();
  });
});

describe('planImportPresetEdits', () => {
  const developPreset = {
    id: 1,
    syncId: 'preset-sync-id',
    name: 'Warm',
    adjustments: { temperature: 20 },
    category: null,
  } as PresetRow;

  it('puts the preset on a new photo as a replaceable layer', () => {
    const writes = planImportPresetEdits(added, developPreset, new Set());
    expect(writes).toHaveLength(1);
    const layers = writes[0].document.layers;
    expect(layers).toHaveLength(2);
    expect(layers[1].presetSyncId).toBe('preset-sync-id');
    expect(layers[1].adjustments?.temperature).toBe(20);
    // The base layer stays untouched, so the look can be dialled back or dropped.
    expect(layers[0].presetSyncId).toBeUndefined();
  });

  it('writes nothing when the tab names no develop preset', () => {
    expect(planImportPresetEdits(added, null, new Set())).toEqual([]);
  });

  it('never overwrites a photo that already has an edit', () => {
    expect(planImportPresetEdits(added, developPreset, new Set(['hash-a']))).toEqual([]);
  });

  it('skips a row without a content hash and writes once per hash', () => {
    const rows: AddedPhoto[] = [
      { id: 1, contentHash: null },
      { id: 2, contentHash: 'hash-b' },
      { id: 3, contentHash: 'hash-b' },
    ];
    expect(planImportPresetEdits(rows, developPreset, new Set()).map((w) => w.contentHash)).toEqual(['hash-b']);
  });
});
