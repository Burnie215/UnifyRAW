import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorage } from '../MemoryStorage';
import { PresetRepository } from './PresetRepository';
import { DEFAULT_PRESETS, DEFAULT_PRESETS_STAMP } from '../../data/defaultPresets';
import { mergeRemoteRow } from '../SyncedStorage';

// sqljs-init passes the Vite `?url` asset path ('/node_modules/...') as the
// wasm location, which node cannot open; without it sql.js finds its own wasm.
vi.mock('sql.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sql.js')>();
  return { ...actual, default: () => actual.default() };
});

describe('a preset row never carries the lens correction', () => {
  let storage: MemoryStorage;
  let repo: PresetRepository;

  /** What an editor hands in when the user saves the whole panel set. */
  const fromCorrectedPhoto = {
    exposure: 10,
    lensCorrection: true,
    lensCorrectionProfile: 'X',
    lensCorrectionStrength: 60,
    vignette: -20,
    vignetteFeather: 70,
    distortion: 12,
  };

  function storedAdjustments(id: number): Record<string, unknown> {
    const raw = storage.db.exec('SELECT adjustments FROM presets WHERE id = ?', [id])[0].values[0][0];
    return JSON.parse(String(raw)) as Record<string, unknown>;
  }

  beforeEach(async () => {
    storage = await MemoryStorage.create();
    repo = new PresetRepository(storage, () => {});
  });

  it('stores the look and drops the glass when a preset is created', () => {
    const id = repo.add({ name: 'Film', adjustments: fromCorrectedPhoto });

    expect(storedAdjustments(id)).toEqual({
      exposure: 10, vignette: -20, vignetteFeather: 70, distortion: 12,
    });
    expect(repo.get(id)?.adjustments.lensCorrectionProfile).toBeUndefined();
    expect(repo.get(id)?.adjustments.lensCorrectionStrength).toBeUndefined();
  });

  it('drops it again when an older row is rewritten', () => {
    const id = repo.add({ name: 'Film', adjustments: { exposure: 10 } });
    repo.update(id, { adjustments: fromCorrectedPhoto });

    expect(Object.keys(storedAdjustments(id))).not.toContain('lensCorrection');
    expect(storedAdjustments(id).distortion).toBe(12);
  });

  it('lets a newer sync tombstone win over a freshly seeded default', () => {
    const definition = DEFAULT_PRESETS[0];
    expect(repo.ensureDefaults([definition])).toBe(1);
    const seeded = repo.list()[0];
    expect(seeded.createdAt).toBe(DEFAULT_PRESETS_STAMP);
    expect(seeded.updatedAt).toBe(DEFAULT_PRESETS_STAMP);

    expect(mergeRemoteRow(storage.db, 'presets', {
      ...definition,
      createdAt: DEFAULT_PRESETS_STAMP,
      updatedAt: DEFAULT_PRESETS_STAMP + 1,
      deletedAt: DEFAULT_PRESETS_STAMP + 1,
    })).toBe(true);
    expect(repo.ensureDefaults([definition])).toBe(0);
    expect(repo.list()).toEqual([]);
    expect(repo.get(seeded.id)?.deletedAt).toBe(DEFAULT_PRESETS_STAMP + 1);
  });
});
