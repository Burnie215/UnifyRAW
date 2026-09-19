import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { MemoryStorage } from '../MemoryStorage';
import { CollectionRepository } from './CollectionRepository';
import type { CollectionRule, RevisionTable } from './types';

vi.mock('sql.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sql.js')>();
  return { ...actual, default: () => actual.default() };
});

describe('CollectionRepository smart rules', () => {
  let storage: MemoryStorage;
  let repo: CollectionRepository;
  let revisions: Mock<(table: RevisionTable) => void>;

  beforeEach(async () => {
    storage = await MemoryStorage.create();
    revisions = vi.fn();
    repo = new CollectionRepository(storage, revisions);
  });

  afterEach(async () => {
    await storage.close();
  });

  it('persists smart rules on create and update through the collection row', () => {
    const initial: CollectionRule[] = [{ field: 'iso', operator: 'between', value: 100, value2: 800 }];
    const id = repo.add({ name: 'Low light', type: 'smart', rules: initial, photoIds: null });
    expect(repo.get(id)?.rules).toEqual(initial);

    const updated: CollectionRule[] = [{ field: 'mimeType', operator: 'contains', value: 'raw' }];
    repo.update(id, { rules: updated });

    expect(repo.get(id)?.rules).toEqual(updated);
    expect(repo.list().find((row) => row.id === id)?.rules).toEqual(updated);
    expect(revisions).toHaveBeenCalledTimes(2);
    expect(revisions).toHaveBeenLastCalledWith('collections');
  });
});
