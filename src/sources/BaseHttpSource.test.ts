import { afterEach, describe, expect, it, vi } from 'vitest';
import { BaseHttpSource } from './BaseHttpSource';

class TestHttpSource extends BaseHttpSource {
  protected authHeaders(): Record<string, string> {
    return { Authorization: 'Bearer source-secret' };
  }

  download(url: string): Promise<string | null> {
    return this.fetchAsObjectUrl(url);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BaseHttpSource binary URL credentials', () => {
  it('keeps source credentials on same-origin absolute and relative URLs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Blob(['image'])));
    vi.stubGlobal('fetch', fetchMock);
    const source = new TestHttpSource(
      'source',
      'Gallery',
      'https://gallery.example.test:8443/root',
      'browser-direct',
    );

    await source.download('/api/photo/1');
    await source.download('https://gallery.example.test:8443/media/2.jpg');

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://gallery.example.test:8443/root/api/photo/1',
      expect.objectContaining({ headers: { Authorization: 'Bearer source-secret' } }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://gallery.example.test:8443/media/2.jpg',
      expect.objectContaining({ headers: { Authorization: 'Bearer source-secret' } }),
    );
  });

  it('fetches a public CDN URL without forwarding source credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Blob(['image'])));
    vi.stubGlobal('fetch', fetchMock);
    const source = new TestHttpSource(
      'source',
      'Lychee',
      'https://gallery.example.test',
      'browser-direct',
    );

    await source.download('https://cdn.example.test/public/photo.jpg');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://cdn.example.test/public/photo.jpg',
      expect.objectContaining({ headers: {} }),
    );
  });
});
