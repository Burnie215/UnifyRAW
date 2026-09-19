import { describe, expect, it } from 'vitest';
import {
  CHUNK_RELOAD_COOLDOWN_MS,
  CHUNK_RELOAD_STORAGE_KEY,
  claimChunkRecoveryReload,
} from './chunkRecovery';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    values,
  };
}

describe('chunk recovery reload guard', () => {
  it('claims the first reload and stores its timestamp', () => {
    const storage = memoryStorage();
    expect(claimChunkRecoveryReload(storage, 1_000)).toBe(true);
    expect(storage.values.get(CHUNK_RELOAD_STORAGE_KEY)).toBe('1000');
  });

  it('prevents a reload loop inside the cooldown', () => {
    const storage = memoryStorage();
    expect(claimChunkRecoveryReload(storage, 1_000)).toBe(true);
    expect(claimChunkRecoveryReload(storage, 1_000 + CHUNK_RELOAD_COOLDOWN_MS)).toBe(false);
    expect(claimChunkRecoveryReload(storage, 1_001 + CHUNK_RELOAD_COOLDOWN_MS)).toBe(true);
  });
});
