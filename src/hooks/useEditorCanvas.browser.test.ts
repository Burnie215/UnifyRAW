import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const pipelineMocks = vi.hoisted(() => ({
  setImage: vi.fn(),
  setImageRaw: vi.fn(),
  retryInitialization: vi.fn(),
  error: false,
}));

vi.mock('./useRenderPipeline', () => ({
  useRenderPipeline: () => ({
    ready: true,
    error: pipelineMocks.error,
    hdr: false,
    setImage: pipelineMocks.setImage,
    setImageRaw: pipelineMocks.setImageRaw,
    retryInitialization: pipelineMocks.retryInitialization,
    render: vi.fn(),
    renderDoc: vi.fn(),
  }),
}));

import { useEditorCanvas } from './useEditorCanvas';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.clearAllMocks();
  pipelineMocks.error = false;
});

describe('useEditorCanvas retry', () => {
  it('forces a failed source through the same-source load guard again', async () => {
    pipelineMocks.setImage
      .mockRejectedValueOnce(new Error('worker render failed'))
      .mockResolvedValueOnce({ w: 4, h: 3 });
    const blob = new Blob(['pixels'], { type: 'image/jpeg' });
    let latest: ReturnType<typeof useEditorCanvas> | null = null;

    function Probe() {
      const canvas = useEditorCanvas('blob:preview', blob, null, 9);
      useEffect(() => { latest = canvas; }, [canvas]);
      return null;
    }

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(Probe));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(pipelineMocks.setImage).toHaveBeenCalledOnce();
    expect(latest!.useWebGL).toBe(false);

    await act(async () => {
      latest!.retryRender();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(pipelineMocks.setImage).toHaveBeenCalledTimes(2);
    expect(latest!.useWebGL).toBe(true);
    expect(latest!.glImageLoaded).toBe(true);
    expect(latest!.loadedPhotoId).toBe(9);
    expect(latest!.sourceLoadGen).toBe(1);
  });

  it('reinitializes a failed pipeline before retrying the source load', async () => {
    pipelineMocks.error = true;
    pipelineMocks.retryInitialization.mockImplementation(() => { pipelineMocks.error = false; });
    pipelineMocks.setImage.mockResolvedValue({ w: 4, h: 3 });
    const blob = new Blob(['pixels'], { type: 'image/jpeg' });
    let latest: ReturnType<typeof useEditorCanvas> | null = null;

    function Probe() {
      const canvas = useEditorCanvas('blob:preview', blob, null, 10);
      useEffect(() => { latest = canvas; }, [canvas]);
      return null;
    }

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(Probe));
      await Promise.resolve();
    });
    expect(pipelineMocks.setImage).not.toHaveBeenCalled();

    await act(async () => {
      latest!.retryRender();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(pipelineMocks.retryInitialization).toHaveBeenCalledOnce();
    expect(pipelineMocks.setImage).toHaveBeenCalledOnce();
    expect(latest!.glImageLoaded).toBe(true);
  });
});
