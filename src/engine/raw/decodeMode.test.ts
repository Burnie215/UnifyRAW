import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  availableRawDecodeModes,
  defaultRawDecodeMode,
  getRawDecodeMode,
  rawDecodeModeNeedsBackend,
  selectableRawDecodeModes,
} from './RawDecoderStrategy';
import { rawDecodeModesForSource, rawDecodeModeForSource } from './sourcePolicy';
import { stubOnlineBuild, stubSelfhostBuild, unstubBuild } from '../../test/build';

const BACKEND_URL_KEY = 'photolib.backendUrl';
const DECODE_MODE_KEY = 'photolib.rawDecodeMode';

function installBuild(
  { selfhosted, stored = {} }: { selfhosted: boolean; stored?: Record<string, string> },
): void {
  const values = new Map(Object.entries(stored));
  if (selfhosted) stubSelfhostBuild();
  else stubOnlineBuild();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
    removeItem: (k: string) => values.delete(k),
    clear: () => values.clear(),
    key: (i: number) => [...values.keys()][i] ?? null,
    get length() { return values.size; },
  } satisfies Storage);
}

afterEach(unstubBuild);

describe('RAW decoder default per build', () => {
  it('knows which decoders reach for the backend', () => {
    expect(rawDecodeModeNeedsBackend('smart-preview')).toBe(true);
    expect(rawDecodeModeNeedsBackend('libraw-wasm')).toBe(false);
    expect(rawDecodeModeNeedsBackend('embedded-jpeg')).toBe(false);
  });

  // hybrid-auto and backend were decoders until 2026-09 and can still sit in a
  // user's localStorage; they must land on a decoder this build offers.
  it.each(['hybrid-auto', 'backend', 'embedded-jpeg'])(
    'maps a stored %s from an earlier build to a selectable decoder',
    (legacy) => {
      installBuild({ selfhosted: true, stored: { [DECODE_MODE_KEY]: legacy } });
      expect(getRawDecodeMode()).toBe('smart-preview');

      installBuild({ selfhosted: false, stored: { [DECODE_MODE_KEY]: legacy } });
      expect(getRawDecodeMode()).toBe('libraw-wasm');
      expect(selectableRawDecodeModes()).toContain(getRawDecodeMode());
    },
  );

  it('keeps smart-preview as the default in the selfhost build', () => {
    installBuild({ selfhosted: true });
    expect(defaultRawDecodeMode()).toBe('smart-preview');
    expect(selectableRawDecodeModes()).toEqual(['smart-preview', 'libraw-wasm']);
  });

  it('decodes in the browser when there is no backend', () => {
    installBuild({ selfhosted: false });
    expect(defaultRawDecodeMode()).toBe('libraw-wasm');
    // No dead option in the settings.
    expect(selectableRawDecodeModes()).toEqual(['libraw-wasm']);
  });

  it('ignores a stored smart-preview preference a build cannot honour', () => {
    installBuild({ selfhosted: false, stored: { [DECODE_MODE_KEY]: 'smart-preview' } });
    expect(getRawDecodeMode()).toBe('libraw-wasm');

    installBuild({ selfhosted: true, stored: { [DECODE_MODE_KEY]: 'smart-preview' } });
    expect(getRawDecodeMode()).toBe('smart-preview');
  });

  it('honours a server URL configured in the online build (§P9)', () => {
    installBuild({ selfhosted: false, stored: { [BACKEND_URL_KEY]: 'https://backend.test' } });
    expect(defaultRawDecodeMode()).toBe('smart-preview');
    expect(availableRawDecodeModes(['smart-preview', 'libraw-wasm'])).toEqual(
      ['smart-preview', 'libraw-wasm'],
    );
  });

  it('redirects remote sources too, not just local files', () => {
    // The old forced redirect only covered local/local-files, so an Immich RAW
    // in the online build still asked /api/raw.
    installBuild({ selfhosted: false });
    expect(rawDecodeModesForSource('immich')).toEqual(['libraw-wasm']);
    expect(rawDecodeModeForSource('immich', 'smart-preview')).toBe('libraw-wasm');
    expect(rawDecodeModeForSource('lychee', 'smart-preview')).toBe('libraw-wasm');
    expect(rawDecodeModeForSource('local', 'smart-preview')).toBe('libraw-wasm');

    installBuild({ selfhosted: true });
    expect(rawDecodeModeForSource('immich', 'smart-preview')).toBe('smart-preview');
    expect(rawDecodeModeForSource('local', 'smart-preview')).toBe('libraw-wasm');
  });
});
