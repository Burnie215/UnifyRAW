import { describe, expect, it } from 'vitest';
import {
  buildDavResourceUrl,
  normalizeDavRelativePath,
  normalizeDavRootUrl,
  resolveDavHref,
} from './webdavUrl';

describe('WebDAV URL handling', () => {
  it('normalizes and encodes a configured root', () => {
    expect(normalizeDavRootUrl('https://nas.local/dav/My%20Photos'))
      .toBe('https://nas.local/dav/My%20Photos/');
    expect(normalizeDavRootUrl('https://nas.local/dav', 'Camera Uploads/2026'))
      .toBe('https://nas.local/dav/Camera%20Uploads/2026/');
  });

  it('builds URLs by encoding decoded path segments exactly once', () => {
    expect(buildDavResourceUrl('https://nas.local/dav/', 'Urlaub #1/100%?.jpg'))
      .toBe('https://nas.local/dav/Urlaub%20%231/100%25%3F.jpg');
  });

  it('resolves absolute, root-relative, and request-relative hrefs', () => {
    const root = 'https://nas.local/remote.php/dav/files/me/';
    const request = `${root}Album/`;
    expect(resolveDavHref(root, request, `${root}Album/a.jpg`).relativePath).toBe('Album/a.jpg');
    expect(resolveDavHref(root, request, '/remote.php/dav/files/me/Album/b.jpg').relativePath).toBe('Album/b.jpg');
    expect(resolveDavHref(root, request, 'c.jpg').relativePath).toBe('Album/c.jpg');
  });

  it('returns decoded stable IDs while preserving encoded request URLs', () => {
    const result = resolveDavHref(
      'https://nas.local/dav/',
      'https://nas.local/dav/',
      '/dav/Urlaub%20%231/100%25%3F.jpg',
    );
    expect(result.relativePath).toBe('Urlaub #1/100%?.jpg');
    expect(result.url).toBe('https://nas.local/dav/Urlaub%20%231/100%25%3F.jpg');
  });

  it('rejects cross-origin and outside-root hrefs', () => {
    const root = 'https://nas.local/dav/photos/';
    expect(() => resolveDavHref(root, root, 'https://attacker.invalid/file.jpg')).toThrow(/different origin/);
    expect(() => resolveDavHref(root, root, '/dav/private/file.jpg')).toThrow(/outside/);
    expect(() => resolveDavHref(root, root, '/dav/photos-other/file.jpg')).toThrow(/outside/);
  });

  it('rejects ambiguous and traversing relative paths', () => {
    expect(() => normalizeDavRelativePath('../secret')).toThrow(/dot segments/);
    expect(() => resolveDavHref(
      'https://nas.local/dav/',
      'https://nas.local/dav/',
      '/dav/a%2Fb.jpg',
    )).toThrow(/ambiguous/);
  });
});
