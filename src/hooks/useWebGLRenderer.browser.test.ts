import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { adjustmentsToDocument, documentToAdjustments, type PhotoDocument } from '../engine/DocumentModel';
import { bitmapFromPixels } from '../engine/graph/compat/glReadout';
import { defaultAdjustments } from '../types';
import type { RenderOverlay } from './useRenderPipeline';
import { useWebGLRenderer } from './useWebGLRenderer';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

describe('useWebGLRenderer pre-curve publication', () => {
  it('publishes a separate generation after the idle document tap completes', async () => {
    let idle: IdleRequestCallback | null = null;
    const cancelIdle = vi.fn();
    vi.stubGlobal('requestIdleCallback', vi.fn((callback: IdleRequestCallback) => {
      idle = callback;
      return 17;
    }));
    vi.stubGlobal('cancelIdleCallback', cancelIdle);

    const makeBitmap = () => bitmapFromPixels(
      new Uint8Array([64, 64, 64, 255]),
      1,
      1,
    );
    const renderDocUpTo = vi.fn(async (
      _doc: PhotoDocument,
      _stopNodeId: string,
      _overlay?: RenderOverlay,
    ): Promise<ImageBitmap | null> => makeBitmap());
    const pipeline = {
      ready: true,
      error: null,
      render: vi.fn(async () => makeBitmap()),
      renderDocUpTo,
      getBuilderSource: () => ({
        kind: 'imageBitmap' as const,
        geometry: { width: 1, height: 1, pixelRatio: 1 },
      }),
    };
    const canvas = document.createElement('canvas');
    const canvasRef = { current: canvas };
    const canvasState = {
      pipeline,
      glCanvasRef: canvasRef,
      glCanvasEl: canvas,
      glImageLoaded: true,
      loadedPhotoId: 1,
      sourceLoadGen: 1,
      useWebGL: true,
      setUseWebGL: vi.fn(),
      setNativeImgDims: vi.fn(),
      setImgDims: vi.fn(),
      renderGen: 0,
      setRenderGen: vi.fn(),
    };
    let adjustments = { ...defaultAdjustments, exposure: 10 };
    const staleDocument = adjustmentsToDocument({ ...defaultAdjustments, exposure: -40 });
    let latest: ReturnType<typeof useWebGLRenderer> | null = null;

    function Probe() {
      const renderer = useWebGLRenderer({
        canvas: canvasState,
        adjustments,
        document: staleDocument,
        activeLayerId: null,
        viewSelectedRange: null,
        customHslSectors: [],
        softProofEnabled: false,
        softProofProfile: 'srgb',
        compareActive: false,
      });
      useEffect(() => { latest = renderer; }, [renderer]);
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
    expect(idle).not.toBeNull();
    expect(latest!.preCurveGen).toBe(0);

    await act(async () => {
      idle!({ didTimeout: false, timeRemaining: () => 10 });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderDocUpTo).toHaveBeenCalledWith(
      expect.anything(),
      'default:toneCurve',
      undefined,
    );
    expect(documentToAdjustments(renderDocUpTo.mock.calls[0][0]).exposure).toBe(10);
    expect(latest!.preCurveCanvas).toBeInstanceOf(HTMLCanvasElement);
    expect(latest!.preCurveGen).toBe(1);

    // A current null result invalidates both published state and the backing
    // ref, rather than leaving pixels from the previous adjustment behind.
    renderDocUpTo.mockResolvedValueOnce(null);
    adjustments = { ...defaultAdjustments, exposure: 11 };
    await act(async () => {
      root!.render(createElement(Probe));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      idle!({ didTimeout: false, timeRemaining: () => 10 });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest!.preCurveCanvas).toBeNull();
    expect(latest!.preCurveGen).toBe(1);

    // The cleared ref forces a new canvas. Even when that canvas cannot
    // provide a context, the returned ImageBitmap is closed in finally and
    // no blank snapshot is published.
    const contextlessBitmap = await makeBitmap();
    const closeBitmap = vi.spyOn(contextlessBitmap, 'close');
    renderDocUpTo.mockResolvedValueOnce(contextlessBitmap);
    const createCanvas = vi.spyOn(document, 'createElement');
    const noContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    adjustments = { ...defaultAdjustments, exposure: 12 };
    await act(async () => {
      root!.render(createElement(Probe));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      idle!({ didTimeout: false, timeRemaining: () => 10 });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(createCanvas).toHaveBeenCalledWith('canvas');
    expect(closeBitmap).toHaveBeenCalledOnce();
    expect(latest!.preCurveCanvas).toBeNull();
    noContext.mockRestore();
    createCanvas.mockRestore();

    // A newer render schedules a fresh idle tap. Unmounting before it runs
    // must cancel that callback rather than letting it retain editor state.
    adjustments = { ...defaultAdjustments, exposure: 13 };
    await act(async () => {
      root!.render(createElement(Probe));
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => root!.unmount());
    root = null;
    expect(cancelIdle).toHaveBeenCalledWith(17);
  });

  it('renders comparison before from default adjustments while after stays on the GL canvas', async () => {
    const adjusted = { ...defaultAdjustments, exposure: 25 };
    let holdNextBefore = false;
    let releaseBefore: ((bitmap: ImageBitmap) => void) | null = null;
    const render = vi.fn(async (value: typeof defaultAdjustments) => {
      if (value.exposure === 0 && holdNextBefore) {
        return new Promise<ImageBitmap>((resolve) => { releaseBefore = resolve; });
      }
      return bitmapFromPixels(
        value.exposure === 0
          ? new Uint8Array([190, 20, 30, 255])
          : new Uint8Array([20, 190, 30, 255]),
        1,
        1,
      );
    });
    const pipeline = { ready: true, error: null, render };
    const after = document.createElement('canvas');
    const canvasState = {
      pipeline,
      glCanvasRef: { current: after },
      glCanvasEl: after,
      glImageLoaded: true,
      loadedPhotoId: 42,
      sourceLoadGen: 1,
      useWebGL: true,
      setUseWebGL: vi.fn(),
      setNativeImgDims: vi.fn(),
      setImgDims: vi.fn(),
      renderGen: 1,
      setRenderGen: vi.fn(),
    };
    let latest: ReturnType<typeof useWebGLRenderer> | null = null;

    function Probe() {
      const renderer = useWebGLRenderer({
        canvas: canvasState,
        adjustments: adjusted,
        document: adjustmentsToDocument(adjusted),
        activeLayerId: null,
        viewSelectedRange: null,
        customHslSectors: [],
        softProofEnabled: false,
        softProofProfile: 'srgb',
        compareActive: true,
      });
      useEffect(() => { latest = renderer; }, [renderer]);
      return null;
    }

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(Probe));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(render).toHaveBeenCalledWith(adjusted, undefined);
    expect(render).toHaveBeenCalledWith(defaultAdjustments);
    expect(Array.from(after.getContext('2d')!.getImageData(0, 0, 1, 1).data)).toEqual([20, 190, 30, 255]);
    expect(latest!.beforeGen).toBe(1);
    expect(Array.from(latest!.beforeCanvas!.getContext('2d')!.getImageData(0, 0, 1, 1).data)).toEqual([190, 20, 30, 255]);

    // A successfully rebound source for the same photo must invalidate the old
    // before surface immediately. This is the normal preview -> RAW16 upgrade
    // path, where the photo id deliberately does not change.
    holdNextBefore = true;
    canvasState.sourceLoadGen = 2;
    await act(async () => {
      root!.render(createElement(Probe));
      await Promise.resolve();
    });
    expect(latest!.beforeCanvas).toBeNull();
    await act(async () => {
      releaseBefore!(await bitmapFromPixels(new Uint8Array([80, 90, 100, 255]), 1, 1));
      await Promise.resolve();
    });
    expect(Array.from(latest!.beforeCanvas!.getContext('2d')!.getImageData(0, 0, 1, 1).data)).toEqual([80, 90, 100, 255]);
  });
});
