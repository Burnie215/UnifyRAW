import { afterEach, describe, expect, it } from 'vitest';
import { stubSelfhostBuild, unstubBuild } from '../test/build';
import {
  SOURCE_CAPABILITIES,
  SOURCE_TYPES,
  isKnownSourceType,
  sourceAvailability,
  sourceCapability,
} from './capabilities';
import { supportsBrowserDirectTransport } from '../platform/sourceTransport';
import { isLocalRawSourceType, rawDecodeModeForSource } from '../engine/raw/sourcePolicy';

afterEach(unstubBuild);

describe('source capability table', () => {
  it('has exactly one entry per source type', () => {
    expect(SOURCE_TYPES).toHaveLength(new Set(SOURCE_TYPES).size);
    for (const type of SOURCE_TYPES) {
      expect(sourceCapability(type)).toBe(SOURCE_CAPABILITIES[type]);
    }
  });

  it('covers every source the picker and the factory know', () => {
    // Both lists are maintained by hand elsewhere; a source missing here would
    // silently fall through to "unknown" at runtime.
    const inPicker = [
      'local', 'photolib-library', 'immich', 'immich-v3', 'photoprism', 'piwigo',
      'lychee', 'synology', 'librephotos', 'nextcloud-photos', 'ente',
      'dropbox', 'google-drive', 'onedrive', 'google-photos', 'flickr', 'smugmug', 's3',
      'webdav', 'server-path', 'ftp', 'smb', 'ssh', 'nfs',
    ];
    for (const type of inPicker) expect(isKnownSourceType(type)).toBe(true);
    expect(isKnownSourceType('nextcloud')).toBe(false);
    expect(isKnownSourceType(undefined)).toBe(false);
  });

  it('never offers a decoder a source is not allowed to use', () => {
    // Against the build that has every decoder — the online build narrows this
    // further, which decodeMode.test.ts covers.
    stubSelfhostBuild();
    for (const type of SOURCE_TYPES) {
      const cap = SOURCE_CAPABILITIES[type];
      expect(cap.decodeModes.length).toBeGreaterThan(0);
      expect(rawDecodeModeForSource(type, 'smart-preview')).toBe(
        cap.decodeModes.includes('smart-preview') ? 'smart-preview' : cap.decodeModes[0],
      );
    }
  });

  it('keeps requiresBackend and onlineReady consistent', () => {
    for (const type of SOURCE_TYPES) {
      const cap = SOURCE_CAPABILITIES[type];
      if (cap.onlineReady) {
        expect(cap.implemented).toBe(true);
        expect(cap.requiresBackend).toBe(false);
        expect(cap.transport).not.toBe('server-proxy');
      }
      if (cap.requiresBackend) expect(cap.transport).toBe('server-proxy');
    }
  });

  it('is the single source of truth for the transport seam', () => {
    for (const type of SOURCE_TYPES) {
      expect(supportsBrowserDirectTransport(type)).toBe(
        SOURCE_CAPABILITIES[type].transport === 'browser-direct',
      );
      expect(isLocalRawSourceType(type)).toBe(
        SOURCE_CAPABILITIES[type].transport === 'browser-native',
      );
    }
  });

  it('releases only the sources the §P4 probe passed', () => {
    // Sondierung 2026-09-05: Immich v2/v3 and Lychee answered browser-direct
    // from the hosted app; WebDAV has no test instance yet.
    expect(SOURCE_TYPES.filter((t) => SOURCE_CAPABILITIES[t].onlineReady)).toEqual([
      'local', 'local-files', 'immich', 'immich-v3', 'lychee',
    ]);
    expect(SOURCE_CAPABILITIES['webdav'].transport).toBe('browser-direct');
    expect(SOURCE_CAPABILITIES['webdav'].onlineReady).toBe(false);
  });
});

describe('source picker states (§P2)', () => {
  const SELFHOST_BOUND = ['server-path', 'ftp', 'smb', 'ssh', 'nfs', 'photolib-library'] as const;

  it('names the sources that need a server instead of promising them soon', () => {
    for (const type of SELFHOST_BOUND) {
      expect(sourceAvailability(type, 'online')).toBe('selfhost-only');
    }
    // Same sources in the selfhost build: photolib-library works, the rest is
    // genuinely not built yet.
    expect(sourceAvailability('photolib-library', 'hosted')).toBe('available');
    for (const type of SELFHOST_BOUND.filter((t) => t !== 'photolib-library')) {
      expect(sourceAvailability(type, 'hosted')).toBe('coming-soon');
    }
  });

  it('offers the sources the probe released, in both builds', () => {
    for (const type of ['local', 'immich', 'immich-v3', 'lychee'] as const) {
      expect(sourceAvailability(type, 'online')).toBe('available');
      expect(sourceAvailability(type, 'hosted')).toBe('available');
    }
  });

  it('holds WebDAV back online without calling it unbuilt', () => {
    // It is finished and runs in the selfhost build; online it lacks the proxy.
    expect(sourceAvailability('webdav', 'hosted')).toBe('available');
    expect(sourceAvailability('webdav', 'online')).toBe('selfhost-only');
  });

  it('still says Coming Soon for what nobody has built', () => {
    for (const type of ['photoprism', 'piwigo', 'dropbox', 's3', 'ente'] as const) {
      expect(sourceAvailability(type, 'online')).toBe('coming-soon');
      expect(sourceAvailability(type, 'hosted')).toBe('coming-soon');
    }
  });
});
