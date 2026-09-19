import { describe, expect, it } from 'vitest';
import { mergeSourceConfigFromSync, redactSourceConfigForSync } from './source-config-sync';

describe('source config sync redaction', () => {
  it('removes common credentials recursively while preserving connection settings', () => {
    expect(redactSourceConfigForSync({
      serverUrl: 'https://photos.example',
      apiKey: 'secret-api-key',
      username: 'alice',
      nested: { accessToken: 'token', album: 'Family' },
    })).toEqual({
      serverUrl: 'https://photos.example',
      username: 'alice',
      nested: { album: 'Family' },
    });
  });

  it('keeps locally entered credentials when applying a remote config', () => {
    expect(mergeSourceConfigFromSync(
      { serverUrl: 'https://new.example', nested: { album: 'Travel' } },
      { serverUrl: 'https://old.example', password: 'local-only', nested: { apiKey: 'nested-secret' } },
    )).toEqual({
      serverUrl: 'https://new.example',
      password: 'local-only',
      nested: { album: 'Travel', apiKey: 'nested-secret' },
    });
  });
});
