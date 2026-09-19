import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubOnlineBuild, stubSelfhostBuild, unstubBuild } from '../../test/build';
import { PrefetchManager } from './prefetchManager';
import { isLocalRawSourceType, rawDecodeModeForSource } from './sourcePolicy';

afterEach(unstubBuild);

describe('source-aware RAW decoding', () => {
  it.each(['local', 'local-files'])('forces %s sources to decode in the browser', (sourceType) => {
    expect(isLocalRawSourceType(sourceType)).toBe(true);
    expect(rawDecodeModeForSource(sourceType, 'smart-preview')).toBe('libraw-wasm');
  });

  it('keeps the selected decoder for remote sources', () => {
    stubSelfhostBuild();
    expect(isLocalRawSourceType('immich')).toBe(false);
    expect(rawDecodeModeForSource('immich', 'smart-preview')).toBe('smart-preview');
    expect(rawDecodeModeForSource('webdav', 'libraw-wasm')).toBe('libraw-wasm');
  });

  it('sends remote sources to the browser decoder when there is no backend', () => {
    // The old redirect only covered local files, so an Immich RAW in the
    // online build still asked /api/raw (§P3).
    stubOnlineBuild();
    expect(rawDecodeModeForSource('immich', 'smart-preview')).toBe('libraw-wasm');
  });

  it('does not enqueue a local file for server-backed prefetch', () => {
    const manager = new PrefetchManager();
    manager.schedule({} as File, 'local-key', 1200, 'local');
    expect(manager.hasInFlight('local-key')).toBe(false);
  });

  it('does not read local files during bulk server prefetch', async () => {
    const manager = new PrefetchManager();
    const getFile = vi.fn(async () => null);

    await manager.bulk([{ cacheKey: 'local-key', sourceType: 'local-files', getFile }]);

    expect(getFile).not.toHaveBeenCalled();
  });
});
