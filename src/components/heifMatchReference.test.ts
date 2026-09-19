import { describe, expect, it, vi } from 'vitest';
import type { PhotoView } from '../storage/repos';
import { createHeifMatchReferenceResource } from './heifMatchReference';

const partner = {
  id: 2,
  sourceId: 'local',
  sourcePhotoId: 'IMG_0001.HIF',
  name: 'IMG_0001.HIF',
} as PhotoView;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('HEIF match-reference lifetime', () => {
  it('aborts an active source read with the editor-owned signal', async () => {
    const read = deferred<File | null>();
    let received: AbortSignal | undefined;
    const ports = {
      getFile: vi.fn(async (_photo: PhotoView, signal?: AbortSignal) => {
        received = signal;
        return read.promise;
      }),
      decode: vi.fn(async () => new Blob(['decoded'])),
      createObjectUrl: vi.fn(() => 'blob:reference'),
      revokeObjectUrl: vi.fn(),
    };
    const resource = createHeifMatchReferenceResource(partner, ports);

    const result = resource.reference.resolveUrl();
    await vi.waitFor(() => expect(ports.getFile).toHaveBeenCalledOnce());
    expect(received).toBeInstanceOf(AbortSignal);
    resource.dispose();
    expect(received?.aborted).toBe(true);
    read.resolve(new File(['heif'], partner.name));

    await expect(result).resolves.toBeNull();
    expect(ports.decode).not.toHaveBeenCalled();
    expect(ports.createObjectUrl).not.toHaveBeenCalled();
  });

  it('does not create a URL when a pending decode finishes after disposal', async () => {
    const decode = deferred<Blob>();
    const ports = {
      getFile: vi.fn(async () => new File(['heif'], partner.name)),
      decode: vi.fn(() => decode.promise),
      createObjectUrl: vi.fn(() => 'blob:late-reference'),
      revokeObjectUrl: vi.fn(),
    };
    const resource = createHeifMatchReferenceResource(partner, ports);

    const result = resource.reference.resolveUrl();
    await vi.waitFor(() => expect(ports.decode).toHaveBeenCalledOnce());
    resource.dispose();
    decode.resolve(new Blob(['decoded']));

    await expect(result).resolves.toBeNull();
    expect(ports.createObjectUrl).not.toHaveBeenCalled();
  });

  it('revokes the URL it created when its editor lifetime ends', async () => {
    const ports = {
      getFile: vi.fn(async () => new File(['heif'], partner.name)),
      decode: vi.fn(async () => new Blob(['decoded'])),
      createObjectUrl: vi.fn(() => 'blob:reference'),
      revokeObjectUrl: vi.fn(),
    };
    const resource = createHeifMatchReferenceResource(partner, ports);

    await expect(resource.reference.resolveUrl()).resolves.toBe('blob:reference');
    resource.dispose();

    expect(ports.revokeObjectUrl).toHaveBeenCalledWith('blob:reference');
  });
});
