import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, memo } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { AdjustmentsProvider, useAdjustments } from '../contexts/AdjustmentsContext';
import { createDocLayer, type DocLayer } from '../engine/DocumentModel';
import { defaultAdjustments, type Adjustments } from '../types';
import { usePanelAdjustments } from './usePanelAdjustments';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ignoreChange = () => {};
let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

interface ConsumerProps {
  onRender: (adjustments: Adjustments) => void;
}

const CountingConsumer = memo(function CountingConsumer({ onRender }: ConsumerProps) {
  const { adjustments } = useAdjustments();
  onRender(adjustments);
  return null;
});

interface HarnessProps {
  layer: DocLayer;
  panX: number;
  zoom: number;
  onConsumerRender: (adjustments: Adjustments) => void;
}

function Harness({ layer, panX, zoom, onConsumerRender }: HarnessProps) {
  const panelAdjustments = usePanelAdjustments(true, layer, defaultAdjustments);
  return createElement('div', { 'data-pan-x': panX, 'data-zoom': zoom },
    createElement(AdjustmentsProvider, {
      adjustments: panelAdjustments,
      onChange: ignoreChange,
      children: createElement(CountingConsumer, { onRender: onConsumerRender }),
    }));
}

describe('usePanelAdjustments', () => {
  it('does not invalidate adjustment consumers for pan/zoom renders but does for an edit', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const onConsumerRender = vi.fn<(adjustments: Adjustments) => void>();
    const layer = { ...createDocLayer('adjustment'), adjustments: { exposure: 15 } };

    act(() => root!.render(createElement(Harness, {
      layer, panX: 0, zoom: 1, onConsumerRender,
    })));
    expect(onConsumerRender).toHaveBeenCalledTimes(1);
    expect(onConsumerRender.mock.lastCall?.[0].exposure).toBe(15);

    const pannedLayer = { ...layer, opacity: 0.5 };
    act(() => root!.render(createElement(Harness, {
      layer: pannedLayer, panX: 48, zoom: 2, onConsumerRender,
    })));
    expect(onConsumerRender).toHaveBeenCalledTimes(1);

    const editedLayer = {
      ...pannedLayer,
      adjustments: { ...pannedLayer.adjustments, exposure: 35 },
    };
    act(() => root!.render(createElement(Harness, {
      layer: editedLayer, panX: 48, zoom: 2, onConsumerRender,
    })));
    expect(onConsumerRender).toHaveBeenCalledTimes(2);
    expect(onConsumerRender.mock.lastCall?.[0].exposure).toBe(35);
  });
});
