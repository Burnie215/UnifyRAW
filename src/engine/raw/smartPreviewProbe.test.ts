import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeSmartPreviewCache } from './smartPreviewProbe';

function tiffResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'image/tiff', 'X-Cache-Hit': '1' } });
}

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('probeSmartPreviewCache', () => {
  it('asks the cache route for the key and size and returns the hit', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(tiffResponse('tiff-bytes'));

    const hit = await probeSmartPreviewCache('source_1/photo 2', 1200, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/raw/smart-preview/source_1%2Fphoto%202?size=1200');
    expect(await hit?.text()).toBe('tiff-bytes');
  });

  it('reports a miss without noise so the upload can follow', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'not cached' }), { status: 404 }),
    );

    expect(await probeSmartPreviewCache('key', 1200, fetchImpl)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('treats a server error as a miss and says so once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchImpl = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));

    expect(await probeSmartPreviewCache('key', 1200, fetchImpl)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('treats a network error as a miss', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    expect(await probeSmartPreviewCache('key', 1200, fetchImpl)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('passes the caller signal on and rethrows an abort instead of uploading', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockRejectedValue(abortError());

    await expect(probeSmartPreviewCache('key', 1200, fetchImpl, controller.signal)).rejects.toThrow(
      'The operation was aborted',
    );
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined)?.signal).toBe(controller.signal);
  });
});
