import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubOnlineBuild, stubSelfhostBuild, unstubBuild } from '../test/build';
import { ImmichSource } from '../sources/ImmichSource';
import { WebDAVSource } from '../sources/WebDAVSource';
import { PhotoLibLibrarySource } from '../sources/PhotoLibLibrarySource';
import {
  createSourceFetch,
  directOriginHeaderLine,
  resolveSourceTransportMode,
  supportsBrowserDirectTransport,
} from './sourceTransport';

beforeEach(() => {
  // These exercise the backend proxy, so they describe the selfhost build.
  stubSelfhostBuild();
});

afterEach(unstubBuild);

describe('source transport', () => {
  it('keeps missing and unknown persisted modes on the server proxy', () => {
    expect(resolveSourceTransportMode(undefined)).toBe('server-proxy');
    expect(resolveSourceTransportMode('unexpected')).toBe('server-proxy');
    expect(resolveSourceTransportMode('browser-direct')).toBe('browser-direct');
  });

  it('only exposes browser-direct for the supported HTTP source types', () => {
    expect(supportsBrowserDirectTransport('immich')).toBe(true);
    expect(supportsBrowserDirectTransport('immich-v3')).toBe(true);
    expect(supportsBrowserDirectTransport('lychee')).toBe(true);
    expect(supportsBrowserDirectTransport('webdav')).toBe(true);
    expect(supportsBrowserDirectTransport('photolib-library')).toBe(false);
    expect(supportsBrowserDirectTransport('smb')).toBe(false);
  });

  it('routes server mode through the PhotoLib proxy', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const request = createSourceFetch('server-proxy');
    await request('https://photos.example.test/api/ping', {
      headers: { 'x-api-key': 'secret' },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/proxy');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      url: 'https://photos.example.test/api/ping',
      method: 'GET',
      headers: { 'x-api-key': 'secret' },
    });
  });

  it('uses the original HTTPS URL in browser-direct mode', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const request = createSourceFetch('browser-direct');
    await request('https://photos.home.example/api/ping', {
      headers: { 'x-api-key': 'secret' },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://photos.home.example/api/ping',
      expect.objectContaining({
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
      }),
    );
  });

  it('rejects an HTTP source in browser-direct mode before sending credentials', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const request = createSourceFetch('browser-direct');
    await expect(request('http://photos.home.example/api/ping', {
      headers: { 'x-api-key': 'secret' },
    })).rejects.toThrow('requires HTTPS');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('WebDAV browser-direct transport', () => {
  it('keeps RAW fetches in the selected DNS domain', () => {
    const browserSource = new WebDAVSource('source', 'WebDAV', {
      url: 'https://dav.home.example/photos',
      username: 'alice',
      password: 'secret',
      transport: 'browser-direct',
    });
    const serverSource = new WebDAVSource('source', 'WebDAV', {
      url: 'https://dav.home.example/photos',
      username: 'alice',
      password: 'secret',
      transport: 'server-proxy',
    });
    const ref = { sourceId: 'source', sourcePhotoId: 'RAW/camera #1.RAF', name: 'camera #1.RAF' };

    expect(browserSource.getRemoteFetchHint(ref)).toBeNull();
    expect(serverSource.getRemoteFetchHint(ref)).toEqual({
      url: 'https://dav.home.example/photos/RAW/camera%20%231.RAF',
      headers: { Authorization: `Basic ${btoa('alice:secret')}` },
    });
  });

  it('sends the connection PROPFIND directly to the WebDAV HTTPS origin', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 207 }));
    vi.stubGlobal('fetch', fetchMock);
    const source = new WebDAVSource('source', 'WebDAV', {
      url: 'https://dav.home.example/photos',
      username: 'alice',
      password: 'secret',
      transport: 'browser-direct',
    });

    await expect(source.connect()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://dav.home.example/photos/',
      expect.objectContaining({
        method: 'PROPFIND',
        mode: 'cors',
        headers: expect.objectContaining({
          Authorization: `Basic ${btoa('alice:secret')}`,
          Depth: '0',
        }),
      }),
    );
  });

  it('uses browser-direct transport for WebDAV sidecar writes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const source = new WebDAVSource('source', 'WebDAV', {
      url: 'https://dav.home.example/photos',
      username: 'alice',
      password: 'secret',
      transport: 'browser-direct',
    });

    await expect(source.writeSidecar({
      sourceId: 'source',
      sourcePhotoId: 'album #1/photo 100%?.jpg',
      name: 'photo 100%?.jpg',
    }, '{"rating":5}')).resolves.toBe(true);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://dav.home.example/photos/album%20%231/.photolib/',
      'https://dav.home.example/photos/album%20%231/.photolib/photo%20100%25%3F.jpg.json',
    ]);
    expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ method: 'MKCOL' }));
    expect(fetchMock.mock.calls[1][1]).toEqual(expect.objectContaining({ method: 'PUT' }));
  });

  it('surfaces a failed initial collection listing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    const source = new WebDAVSource('source', 'WebDAV', {
      url: 'https://dav.home.example/photos',
      username: 'alice',
      password: 'secret',
      transport: 'browser-direct',
      selectedPaths: ['Private'],
    });

    const scan = async () => {
      for await (const photo of source.listPhotos()) void photo;
    };
    await expect(scan()).rejects.toThrow('WebDAV PROPFIND failed for Private: 403');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://dav.home.example/photos/Private/',
      expect.objectContaining({ method: 'PROPFIND' }),
    );
  });
});

describe('Immich RAW fetch routing', () => {
  const ref = { sourceId: 'source', sourcePhotoId: 'asset-id', name: 'photo.dng' };

  it('disables the backend remote-fetch hint in browser-direct mode', () => {
    const source = new ImmichSource('source', 'Immich', {
      serverUrl: 'https://photos.home.example',
      apiKey: 'secret',
      transport: 'browser-direct',
    });

    expect(source.getRemoteFetchHint(ref)).toBeNull();
  });

  it('keeps the backend remote-fetch hint for existing server-mode sources', () => {
    const source = new ImmichSource('source', 'Immich', {
      serverUrl: 'https://photos.example.test',
      apiKey: 'secret',
    });

    expect(source.getRemoteFetchHint(ref)).toEqual({
      url: 'https://photos.example.test/api/assets/asset-id/original',
      headers: { 'x-api-key': 'secret' },
    });
  });
});

describe('integrated library RAW routing', () => {
  it('uses the authenticated backend preview endpoint instead of transferring the original', () => {
    const source = new PhotoLibLibrarySource('source', 'Local library', {
      libraryId: 'library / one',
    });

    expect(source.getRawPreviewHint({
      sourceId: 'source',
      sourcePhotoId: 'asset / one',
      name: 'photo.dng',
    })).toEqual({
      url: '/api/libraries/library%20%2F%20one/assets/asset%20%2F%20one/raw-preview',
    });
  });
});

describe('transport default per build (§P4)', () => {
  it('keeps the proxy when a backend exists', () => {
    stubSelfhostBuild();
    expect(resolveSourceTransportMode(undefined, 'immich')).toBe('server-proxy');
    expect(resolveSourceTransportMode(undefined, 'lychee')).toBe('server-proxy');
  });

  it('goes direct when there is no backend to proxy through', () => {
    stubOnlineBuild();
    for (const type of ['immich', 'immich-v3', 'lychee', 'webdav']) {
      expect(resolveSourceTransportMode(undefined, type)).toBe('browser-direct');
    }
  });

  it('leaves sources that cannot go direct on the proxy', () => {
    stubOnlineBuild();
    expect(resolveSourceTransportMode(undefined, 'smb')).toBe('server-proxy');
    expect(resolveSourceTransportMode(undefined, 'photoprism')).toBe('server-proxy');
    expect(resolveSourceTransportMode(undefined, undefined)).toBe('server-proxy');
  });

  it('never overrides what the user stored', () => {
    stubOnlineBuild();
    expect(resolveSourceTransportMode('server-proxy', 'immich')).toBe('server-proxy');
    stubSelfhostBuild();
    expect(resolveSourceTransportMode('browser-direct', 'immich')).toBe('browser-direct');
  });

  it('spells out the header line for the source server', () => {
    stubOnlineBuild('https://unifyraw.com');
    expect(directOriginHeaderLine()).toBe('Access-Control-Allow-Origin: https://unifyraw.com');
  });
});
