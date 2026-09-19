import { describe, expect, it } from 'vitest';
import { SOURCE_CAPABILITIES, isKnownSourceType, type SourceType } from './capabilities';
import { SOURCE_FACTORIES } from './SourceManager';
import { sourceTypeLabel } from './sourcePresentation';
import type { SourceProvider } from './types';

// Built from a directory handle or a file list, never from a persisted config.
const BROWSER_BUILT: readonly SourceType[] = ['local', 'local-files'];

const CONSTRUCTIBLE = (Object.keys(SOURCE_CAPABILITIES) as SourceType[]).filter(
  (type) => SOURCE_CAPABILITIES[type].implemented && !BROWSER_BUILT.includes(type),
);

// Their constructors dereference the missing server URL; left to AP18.
const THROWS_ON_EMPTY_CONFIG: readonly SourceType[] = ['immich', 'immich-v3', 'lychee', 'webdav'];

describe('source factories', () => {
  it('does not construct persisted S3 configs until SigV4 signing exists', () => {
    expect(SOURCE_FACTORIES.s3).toBeNull();
  });

  it.each(CONSTRUCTIBLE)('has a factory for %s', (type) => {
    expect(SOURCE_FACTORIES[type]).toBeTypeOf('function');
  });

  it.each(CONSTRUCTIBLE.filter((type) => !THROWS_ON_EMPTY_CONFIG.includes(type)))(
    'constructs %s from an empty config',
    (type) => {
      let source: SourceProvider | undefined;
      expect(() => {
        source = SOURCE_FACTORIES[type]?.('source-id', 'Label', {});
      }).not.toThrow();
      expect(source?.id).toBe('source-id');
      expect(source?.type).toBe(type);
    },
  );

  for (const type of THROWS_ON_EMPTY_CONFIG) {
    it.todo(`F013 ${type} factory throws on an empty config`);
  }
  it.todo('F013 reconnectAll isolates a failing connect()');
});

// Deleted in 2026-09 (F053 stage 1, tag attic/pre-deadcode-2026-09). The type
// names stay behind so a catalog row written by an older version keeps a name
// in the source list and can still be removed there.
const DELETED: readonly SourceType[] = ['ente', 'ftp', 'smb', 'ssh', 'nfs'];

describe('source types whose code was deleted', () => {
  it.each(DELETED)('has no factory for %s, so an old row is skipped', (type) => {
    expect(isKnownSourceType(type)).toBe(true);
    expect(SOURCE_FACTORIES[type]).toBeNull();
  });

  it.each(DELETED)('still shows a provider name for an old %s row', (type) => {
    expect(sourceTypeLabel(type)).not.toBe(type);
  });
});
