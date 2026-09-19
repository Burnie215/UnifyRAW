import { afterEach, describe, expect, it, vi } from 'vitest';
import { revokeBlobUrls } from './objectUrls';

function stubUrl(): string[] {
  const revoked: string[] = [];
  vi.stubGlobal('URL', { revokeObjectURL: (url: string) => revoked.push(url) });
  return revoked;
}

afterEach(() => vi.unstubAllGlobals());

describe('revokeBlobUrls', () => {
  it('releases exactly the blob URLs it was given', () => {
    const revoked = stubUrl();
    const released = revokeBlobUrls(['blob:https://app.test/aaa', 'blob:https://app.test/bbb']);
    expect(revoked).toEqual(['blob:https://app.test/aaa', 'blob:https://app.test/bbb']);
    expect(released).toEqual(revoked);
  });

  it('leaves a server URL alone - it was never this document to release', () => {
    const revoked = stubUrl();
    const released = revokeBlobUrls([
      'https://immich.test/api/assets/a1/thumbnail',
      'blob:https://app.test/aaa',
    ]);
    expect(revoked).toEqual(['blob:https://app.test/aaa']);
    expect(released).toEqual(['blob:https://app.test/aaa']);
  });

  it('survives the empty slots a cleanup hands it', () => {
    const revoked = stubUrl();
    expect(revokeBlobUrls([null, undefined, ''])).toEqual([]);
    expect(revoked).toEqual([]);
  });

  it('takes a Map of URLs, which is how the survey view holds them', () => {
    const revoked = stubUrl();
    const shown = new Map<number, string>([[1, 'blob:https://app.test/1'], [2, 'blob:https://app.test/2']]);
    revokeBlobUrls(shown.values());
    expect(revoked).toEqual(['blob:https://app.test/1', 'blob:https://app.test/2']);
  });
});
