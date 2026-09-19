import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebDAVSource } from './WebDAVSource';
import { IncompleteListingError } from './IncompleteListingError';

const multistatus = (responses: string[]) => `<?xml version="1.0" encoding="utf-8"?>
  <d:multistatus xmlns:d="DAV:">${responses.join('')}</d:multistatus>`;

const davResponse = (
  href: string,
  options: { collection?: boolean; contentType?: string; size?: number } = {},
) => `<d:response>
  <d:href>${href}</d:href>
  <d:propstat><d:prop>
    <d:resourcetype>${options.collection ? '<d:collection/>' : ''}</d:resourcetype>
    ${options.contentType ? `<d:getcontenttype>${options.contentType}</d:getcontenttype>` : ''}
    ${options.size ? `<d:getcontentlength>${options.size}</d:getcontentlength>` : ''}
  </d:prop></d:propstat>
</d:response>`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WebDAV multistatus listing', () => {
  it('follows root-relative folders and keeps decoded stable photo IDs', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === 'https://nas.local/dav/Album%20%231/') {
        return new Response(multistatus([
          davResponse('/dav/Album%20%231/', { collection: true }),
          davResponse('/dav/Album%20%231/photo%20%231.jpg', { contentType: 'image/jpeg', size: 123 }),
          davResponse('/dav/Album%20%231/camera.RAF', { contentType: 'application/octet-stream', size: 456 }),
          davResponse('/dav/Album%20%231/Nested/', { collection: true }),
          davResponse('https://attacker.invalid/steal/', { collection: true }),
        ]), { status: 207, headers: { 'Content-Type': 'application/xml' } });
      }
      if (url === 'https://nas.local/dav/Album%20%231/Nested/') {
        return new Response(multistatus([
          davResponse('/dav/Album%20%231/Nested/', { collection: true }),
          davResponse('/dav/Album%20%231/Nested/Gr%C3%BC%C3%9Fe%20100%25%3F.heic', { contentType: 'application/octet-stream' }),
        ]), { status: 207, headers: { 'Content-Type': 'application/xml' } });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const source = new WebDAVSource('dav', 'WebDAV', {
      url: 'https://nas.local/dav',
      username: 'alice',
      password: 'secret',
      transport: 'browser-direct',
      selectedPaths: ['Album #1'],
    });

    const photos = [];
    for await (const photo of source.listPhotos()) photos.push(photo);

    expect(photos.map((photo) => photo.sourcePhotoId)).toEqual([
      'Album #1/photo #1.jpg',
      'Album #1/camera.RAF',
      'Album #1/Nested/Grüße 100%?.heic',
    ]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://nas.local/dav/Album%20%231/',
      'https://nas.local/dav/Album%20%231/Nested/',
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toEqual(expect.objectContaining({ method: 'PROPFIND', mode: 'cors' }));
    }
  });

  it('returns canonical full relative folder IDs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(multistatus([
      davResponse('/remote.php/dav/files/me/', { collection: true }),
      davResponse('/remote.php/dav/files/me/Camera%20Uploads/', { collection: true }),
      davResponse('/remote.php/dav/files/me/not-a-folder.jpg', { contentType: 'image/jpeg' }),
    ]), { status: 207, headers: { 'Content-Type': 'application/xml' } }));
    vi.stubGlobal('fetch', fetchMock);
    const source = new WebDAVSource('dav', 'WebDAV', {
      url: 'https://cloud.local/remote.php/dav/files/me',
      username: 'me',
      password: 'secret',
      transport: 'browser-direct',
    });

    await expect(source.listAlbumsOrFolders()).resolves.toEqual([
      { id: 'Camera Uploads', name: 'Camera Uploads', type: 'folder' },
    ]);
  });

  it('keeps the photos around a denied sub-folder and then reports the listing incomplete', async () => {
    const xml = (responses: string[]) =>
      new Response(multistatus(responses), { status: 207, headers: { 'Content-Type': 'application/xml' } });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://nas.local/dav/') {
        return xml([
          davResponse('/dav/', { collection: true }),
          davResponse('/dav/a.jpg', { contentType: 'image/jpeg' }),
          davResponse('/dav/Locked/', { collection: true }),
          davResponse('/dav/Open/', { collection: true }),
        ]);
      }
      if (url === 'https://nas.local/dav/Open/') {
        return xml([
          davResponse('/dav/Open/', { collection: true }),
          davResponse('/dav/Open/b.jpg', { contentType: 'image/jpeg' }),
        ]);
      }
      return new Response(null, { status: 403 });
    }));
    const source = new WebDAVSource('dav', 'WebDAV', {
      url: 'https://nas.local/dav',
      username: 'alice',
      password: 'secret',
      transport: 'browser-direct',
    });

    const ids: string[] = [];
    let error: unknown = null;
    try {
      for await (const photo of source.listPhotos()) ids.push(photo.sourcePhotoId);
    } catch (e) {
      error = e;
    }

    expect(ids).toEqual(['a.jpg', 'Open/b.jpg']);
    expect(error).toBeInstanceOf(IncompleteListingError);
    expect((error as IncompleteListingError).reasons).toEqual([expect.stringContaining('Locked')]);
  });

  it('rejects malformed multistatus XML instead of accepting an empty scan', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<not-closed>', {
      status: 207,
      headers: { 'Content-Type': 'application/xml' },
    })));
    const source = new WebDAVSource('dav', 'WebDAV', {
      url: 'https://nas.local/dav',
      username: 'alice',
      password: 'secret',
      transport: 'browser-direct',
    });

    const scan = async () => {
      for await (const photo of source.listPhotos()) void photo;
    };
    await expect(scan()).rejects.toThrow('WebDAV returned invalid XML');
  });
});

describe('WebDAV original-read cancellation', () => {
  it('aborts the browser-direct request that is already in flight', async () => {
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => { readStarted = resolve; });
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        readStarted();
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      }));
    vi.stubGlobal('fetch', fetchMock);
    const source = new WebDAVSource('dav', 'WebDAV', {
      url: 'https://nas.local/dav',
      username: 'alice',
      password: 'secret',
      transport: 'browser-direct',
    });
    const controller = new AbortController();

    const result = source.getFile({
      sourceId: 'dav',
      sourcePhotoId: 'Album/photo.jpg',
      name: 'photo.jpg',
    }, controller.signal);
    await started;
    expect(fetchMock).toHaveBeenCalledWith(
      'https://nas.local/dav/Album/photo.jpg',
      expect.objectContaining({ signal: controller.signal }),
    );
    controller.abort();

    await expect(result).resolves.toBeNull();
  });
});

describe('WebDAV thumbnail-read cancellation', () => {
  it('aborts the browser-direct preview request that is already in flight', async () => {
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => { readStarted = resolve; });
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        readStarted();
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      }));
    vi.stubGlobal('fetch', fetchMock);
    const source = new WebDAVSource('dav', 'WebDAV', {
      url: 'https://cloud.local/remote.php/dav/files/me',
      username: 'me',
      password: 'secret',
      transport: 'browser-direct',
    });
    const controller = new AbortController();

    const result = source.getThumbnailUrl({
      sourceId: 'dav',
      sourcePhotoId: 'Album/photo.jpg',
      name: 'photo.jpg',
    }, controller.signal);
    await started;
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/index.php/core/preview?'),
      expect.objectContaining({ signal: controller.signal }),
    );
    controller.abort();

    await expect(result).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
