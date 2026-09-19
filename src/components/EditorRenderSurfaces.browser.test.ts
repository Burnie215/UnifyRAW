import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ClippingOverlay } from './ClippingOverlay';
import { EditorCompareOverlay, EditorImageStage, EditorModeSurface } from './EditorCompareOverlay';
import { EditorRenderFailure } from './EditorRenderFailure';
import type { CompareMode } from './BeforeAfter';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

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

function mount(element: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(element));
}

function sourceCanvas(colors: Array<[number, number, number, number]>) {
  const canvas = document.createElement('canvas');
  canvas.width = colors.length;
  canvas.height = 1;
  const context = canvas.getContext('2d')!;
  const pixels = context.createImageData(colors.length, 1);
  colors.forEach((color, index) => pixels.data.set(color, index * 4));
  context.putImageData(pixels, 0, 0);
  return canvas;
}

function pixel(canvas: HTMLCanvasElement, x = 0) {
  return Array.from(canvas.getContext('2d')!.getImageData(x, 0, 1, 1).data);
}

describe('editor engine render surfaces', () => {
  it('copies the engine before/after canvases and refreshes after pixels by render generation', () => {
    const before = sourceCanvas([[210, 10, 20, 255]]);
    const after = sourceCanvas([[10, 210, 20, 255]]);
    mount(createElement(EditorCompareOverlay, {
      before, after, beforeGeneration: 1, renderGeneration: 1,
      proofFilter: 'contrast(0.9)', mode: 'side-by-side', onModeChange: vi.fn(), zoom: 1,
      displayWidth: 320, displayHeight: 180, panX: 12, panY: -8,
    }));

    const overlay = host!.querySelector<HTMLElement>('.editor-compare-overlay')!;
    expect(overlay.dataset.coordinateSpace).toBe('screen');
    expect(overlay.style.width).toBe('320px');
    expect(overlay.style.height).toBe('180px');
    expect(overlay.style.left).toBe('calc(50% + 12px)');
    expect(overlay.style.top).toBe('calc(50% - 8px)');
    expect(overlay.style.transform).toBe('translate(-50%, -50%)');
    expect(overlay.querySelector('.ba-mode-bar')!.closest('.editor-image-wrapper')).toBeNull();

    const beforeSurface = host!.querySelector<HTMLCanvasElement>('[data-compare-surface="before"]')!;
    const afterSurface = host!.querySelector<HTMLCanvasElement>('[data-compare-surface="after"]')!;
    expect(pixel(beforeSurface)).toEqual([210, 10, 20, 255]);
    expect(pixel(afterSurface)).toEqual([10, 210, 20, 255]);
    expect(afterSurface.style.filter).toBe('contrast(0.9)');
    expect(beforeSurface.style.filter).toBe('');

    after.getContext('2d')!.fillStyle = 'rgb(10, 20, 210)';
    after.getContext('2d')!.fillRect(0, 0, 1, 1);
    act(() => root!.render(createElement(EditorCompareOverlay, {
      before, after, beforeGeneration: 1, renderGeneration: 2,
      proofFilter: 'contrast(0.9)', mode: 'side-by-side', onModeChange: vi.fn(), zoom: 1,
      displayWidth: 320, displayHeight: 180, panX: 12, panY: -8,
    })));
    expect(pixel(host!.querySelector<HTMLCanvasElement>('[data-compare-surface="after"]')!)).toEqual([10, 20, 210, 255]);
  });

  it('keeps compare chrome outside the transformed production image layer', () => {
    mount(createElement(EditorImageStage, {
      width: 800,
      height: 600,
      transform: 'scale(0.5) translate(20px, 10px)',
      compare: createElement('div', { 'data-testid': 'compare-chrome' }),
      children: createElement('canvas', { 'data-testid': 'current-image' }),
    }));

    const imageLayer = host!.querySelector<HTMLElement>('.editor-image-wrapper')!;
    const chrome = host!.querySelector<HTMLElement>('[data-testid="compare-chrome"]')!;
    expect(imageLayer.style.transform).toContain('scale(0.5)');
    expect(imageLayer.contains(chrome)).toBe(false);
    expect(imageLayer.parentElement).toBe(chrome.parentElement);
  });

  it('temporarily replaces a graph-led editor with generated compare surfaces and returns to its graph', () => {
    const before = sourceCanvas([[210, 10, 20, 255]]);
    const after = sourceCanvas([[10, 210, 20, 255]]);

    function StatefulGraphProbe() {
      const [selected, setSelected] = useState(false);
      return createElement('div', {
        'data-testid': 'graph-editor',
        'data-graph-id': 'stored-graph',
        'data-selected': selected,
        style: { transform: 'translate(40px, 25px) scale(1.4)' },
      }, createElement('button', { 'data-action': 'select-node', onClick: () => setSelected(true) }, 'select'));
    }

    function GraphCompareProbe() {
      const [mode, setMode] = useState<CompareMode>('off');
      const [afterGeneration, setAfterGeneration] = useState(31);
      return createElement('div', null,
        createElement('button', { 'data-action': 'enter-compare', onClick: () => setMode('split') }, 'compare'),
        createElement('button', {
          'data-action': 'refresh-after',
          onClick: () => {
            after.getContext('2d')!.fillStyle = 'rgb(10, 20, 210)';
            after.getContext('2d')!.fillRect(0, 0, 1, 1);
            setAfterGeneration((generation) => generation + 1);
          },
        }, 'refresh'),
        createElement(EditorModeSurface, {
          renderMode: 'graph',
          compareMode: mode,
          graphAvailable: true,
          cropActive: false,
          graphEditor: createElement(StatefulGraphProbe),
          children: createElement(EditorImageStage, {
            width: 1,
            height: 1,
            transform: 'scale(1)',
            compare: mode !== 'off' ? createElement(EditorCompareOverlay, {
              before,
              after,
              beforeGeneration: 17,
              renderGeneration: afterGeneration,
              proofFilter: '',
              mode,
              onModeChange: setMode,
              zoom: 1,
              displayWidth: 1,
              displayHeight: 1,
              panX: 0,
              panY: 0,
            }) : null,
            children: createElement('canvas', { 'data-editor-render': 'current' }),
          }),
        }),
      );
    }

    mount(createElement(GraphCompareProbe));
    act(() => host!.querySelector<HTMLButtonElement>('[data-action="select-node"]')!.click());
    const graphEditor = host!.querySelector<HTMLElement>('[data-testid="graph-editor"]')!;
    expect(graphEditor.getAttribute('data-graph-id')).toBe('stored-graph');
    expect(graphEditor.dataset.selected).toBe('true');
    expect(graphEditor.style.transform).toBe('translate(40px, 25px) scale(1.4)');
    expect(host!.querySelector('[data-editor-render="current"]')).toBeNull();

    act(() => host!.querySelector<HTMLButtonElement>('[data-action="enter-compare"]')!.click());
    expect(host!.querySelector('[data-testid="graph-editor"]')).toBe(graphEditor);
    expect(host!.querySelector<HTMLElement>('[data-editor-mode-surface="graph"]')!.style.display).toBe('none');
    expect(host!.querySelector('[data-editor-render="current"]')).not.toBeNull();
    const beforeSurface = host!.querySelector<HTMLCanvasElement>('[data-compare-surface="before"]')!;
    const afterSurface = host!.querySelector<HTMLCanvasElement>('[data-compare-surface="after"]')!;
    expect(pixel(beforeSurface)).toEqual([210, 10, 20, 255]);
    expect(pixel(afterSurface)).toEqual([10, 210, 20, 255]);
    expect(beforeSurface.dataset.compareGeneration).toBe('17');
    expect(afterSurface.dataset.compareGeneration).toBe('31');

    act(() => host!.querySelector<HTMLButtonElement>('[data-action="refresh-after"]')!.click());
    const refreshedAfter = host!.querySelector<HTMLCanvasElement>('[data-compare-surface="after"]')!;
    expect(pixel(refreshedAfter)).toEqual([10, 20, 210, 255]);
    expect(refreshedAfter.dataset.compareGeneration).toBe('32');

    act(() => host!.querySelectorAll<HTMLButtonElement>('.ba-mode-btn')[3].click());
    expect(host!.querySelector('[data-compare-surface="before"]')).toBeNull();
    expect(host!.querySelector('[data-editor-render="current"]')).toBeNull();
    expect(host!.querySelector('[data-testid="graph-editor"]')).toBe(graphEditor);
    expect(graphEditor.dataset.selected).toBe('true');
    expect(graphEditor.style.transform).toBe('translate(40px, 25px) scale(1.4)');
    expect(host!.querySelector<HTMLElement>('[data-editor-mode-surface="graph"]')!.style.display).toBe('contents');
  });

  it.each([
    ['side-by-side', 158, 160, 2],
    ['split', 320, 160, 2],
    ['toggle', 320, 160, 1],
  ] as const)('fills the zoomed screen-space area in %s mode', (mode, expectedWidth, expectedHeight, expectedSurfaces) => {
    const before = sourceCanvas([[210, 10, 20, 255], [210, 10, 20, 255]]);
    const after = sourceCanvas([[10, 210, 20, 255], [10, 210, 20, 255]]);
    mount(createElement(EditorCompareOverlay, {
      before, after, beforeGeneration: 1, renderGeneration: 1,
      proofFilter: '', mode: mode as CompareMode, onModeChange: vi.fn(), zoom: 8,
      displayWidth: 320, displayHeight: 160, panX: 0, panY: 0,
    }));

    const surfaces = [...host!.querySelectorAll<HTMLCanvasElement>('.ba-canvas')];
    expect(surfaces).toHaveLength(expectedSurfaces);
    for (const surface of surfaces) {
      const rect = surface.getBoundingClientRect();
      expect(rect.width).toBe(expectedWidth);
      expect(rect.height).toBe(expectedHeight);
      expect(rect.width).toBeGreaterThan(surface.width);
      expect(rect.height).toBeGreaterThan(surface.height);
    }
  });

  it('captures a touch divider drag without bubbling it into editor pan', () => {
    const parentPointerDown = vi.fn();
    const parentPointerMove = vi.fn();
    const parentPointerUp = vi.fn();
    const before = sourceCanvas([[210, 10, 20, 255]]);
    const after = sourceCanvas([[10, 210, 20, 255]]);
    mount(createElement('div', {
      onPointerDown: parentPointerDown,
      onPointerMove: parentPointerMove,
      onPointerUp: parentPointerUp,
    }, createElement(EditorCompareOverlay, {
      before, after, beforeGeneration: 1, renderGeneration: 1,
      proofFilter: '', mode: 'split', onModeChange: vi.fn(), zoom: 4,
      displayWidth: 320, displayHeight: 160, panX: 0, panY: 0,
    })));

    const divider = host!.querySelector<HTMLElement>('.ba-divider')!;
    const capture = vi.spyOn(divider, 'setPointerCapture').mockImplementation(() => {});
    const hasCapture = vi.spyOn(divider, 'hasPointerCapture').mockReturnValue(true);
    const release = vi.spyOn(divider, 'releasePointerCapture').mockImplementation(() => {});
    const splitRect = divider.parentElement!.getBoundingClientRect();
    const targetX = splitRect.left + splitRect.width * 0.75;
    act(() => {
      divider.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, pointerId: 7, pointerType: 'touch', clientX: splitRect.left + splitRect.width / 2,
      }));
      divider.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, pointerId: 7, pointerType: 'touch', clientX: targetX,
      }));
      divider.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, pointerId: 7, pointerType: 'touch', clientX: targetX,
      }));
    });

    expect(divider.style.left).toBe('75%');
    expect(capture).toHaveBeenCalledWith(7);
    expect(hasCapture).toHaveBeenCalledWith(7);
    expect(release).toHaveBeenCalledWith(7);
    expect(parentPointerDown).not.toHaveBeenCalled();
    expect(parentPointerMove).not.toHaveBeenCalled();
    expect(parentPointerUp).not.toHaveBeenCalled();
  });

  it('derives clipping from the latest rendered engine generation', () => {
    const rendered = sourceCanvas([[0, 0, 0, 255], [255, 255, 255, 255]]);
    mount(createElement(ClippingOverlay, {
      source: rendered, renderGeneration: 1, showShadows: true, showHighlights: true,
    }));
    const overlay = host!.querySelector<HTMLCanvasElement>('canvas')!;
    const shadow = pixel(overlay, 0);
    const highlight = pixel(overlay, 1);
    expect(shadow[2]).toBeGreaterThan(240);
    expect(shadow[2]).toBeGreaterThan(shadow[1]);
    expect(shadow[1]).toBeGreaterThan(shadow[0]);
    expect(shadow[3]).toBe(180);
    expect(highlight[0]).toBeGreaterThan(240);
    expect(highlight[0]).toBeGreaterThan(highlight[1]);
    expect(highlight[0]).toBeGreaterThan(highlight[2]);
    expect(highlight[3]).toBe(180);

    const context = rendered.getContext('2d')!;
    context.fillStyle = 'rgb(128, 128, 128)';
    context.fillRect(0, 0, 2, 1);
    act(() => root!.render(createElement(ClippingOverlay, {
      source: rendered, renderGeneration: 2, showShadows: true, showHighlights: true,
    })));
    expect(pixel(overlay, 0)[3]).toBe(0);
    expect(pixel(overlay, 1)[3]).toBe(0);
  });

  it('shows the unfiltered original and wires the retry action', () => {
    const retry = vi.fn();
    mount(createElement(EditorRenderFailure, {
      imageUrl: 'failed-render.jpg', imageName: 'original.jpg', onImageLoad: vi.fn(), onRetry: retry,
    }));
    const image = host!.querySelector('img')!;
    expect(image.getAttribute('src')).toContain('failed-render.jpg');
    expect(image.style.filter).toBe('');
    expect(host!.querySelector('[role="alert"]')).not.toBeNull();
    act(() => host!.querySelector('button')!.click());
    expect(retry).toHaveBeenCalledOnce();
  });
});
