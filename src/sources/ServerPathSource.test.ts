import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerPathSource } from './ServerPathSource';
import type { PhotoRef } from './types';

const ref: PhotoRef = {
  sourceId: 'server',
  sourcePhotoId: 'album/photo.jpg',
  name: 'photo.jpg',
};

function source(): ServerPathSource {
  return new ServerPathSource('server', 'Server', {
    serverUrl: 'https://backend.example.test',
    rootPath: '/photos',
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ServerPathSource original-read cancellation', () => {
  it('does not start IO for an already-aborted request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();

    await expect(source().getFile(ref, controller.signal)).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hands the caller signal to an active backend download', async () => {
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => { readStarted = resolve; });
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        readStarted();
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const result = source().getFile(ref, controller.signal);
    await started;
    expect(fetchMock).toHaveBeenCalledWith(
      'https://backend.example.test/api/files/download?path=%2Fphotos%2Falbum%2Fphoto.jpg',
      expect.objectContaining({ signal: controller.signal }),
    );
    controller.abort();

    await expect(result).resolves.toBeNull();
  });
});
