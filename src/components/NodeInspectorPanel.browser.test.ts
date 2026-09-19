/**
 * The generic schema form, mounted.
 *
 * F018: a number the schema gave no range for used to become a ±100 slider in
 * steps of two. The lens node has eight such coefficients and a strength, and
 * it sits in the DEFAULT chain, so one arrow key on `strength` moved it from 1
 * to 2 or 0 and a measured `k1` of 0.03 was not reachable at all. The rule now
 * is: bounds or no slider.
 *
 * F074: the custom-LUT node had no way to get a file. A dropped one carried
 * `samples: []` and rendered black.
 *
 * The browser project, for the same reason as the tailored inspectors next
 * door: a range input's `step`, `min` and `max` are only really enforced by a
 * real one, and a `FileList` is not something jsdom hands out either.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import '../ui/CompactSlider.css';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}));

import { NodeInspectorPanel } from './NodeInspectorPanel';
import {
  getMainThreadNodeRegistry, KIND_CUSTOM_LUT, KIND_LENS_CORRECTION, parseCubeFile,
} from '../engine/graph';
import type { NodeKindSpec } from '../engine/graph';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TINY_CUBE = `LUT_3D_SIZE 2
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;

interface Mounted {
  host: HTMLDivElement;
  emitted(): Record<string, unknown> | null;
  unmount(): void;
}

let mounted: Mounted | null = null;
afterEach(() => { mounted?.unmount(); mounted = null; });

function mount(kind: string, params: unknown): Mounted {
  const changes: unknown[] = [];
  const host = document.createElement('div');
  host.style.cssText = 'width:320px;position:fixed;top:0;left:0;';
  document.body.appendChild(host);
  let root: Root;
  act(() => {
    root = createRoot(host);
    root.render(createElement(NodeInspectorPanel, {
      node: { id: `n:${kind}`, kind, params },
      onParamsChange: (next: unknown) => changes.push(next),
    }));
  });
  const result: Mounted = {
    host,
    emitted: () => (changes.length ? changes[changes.length - 1] as Record<string, unknown> : null),
    unmount() { act(() => root.unmount()); host.remove(); },
  };
  mounted = result;
  return result;
}

function ranges(m: Mounted): HTMLInputElement[] {
  return [...m.host.querySelectorAll<HTMLInputElement>('input[type=range]')];
}

/** The slider whose label the form took from the schema property name. */
function sliderFor(m: Mounted, label: string): HTMLInputElement {
  const row = [...m.host.querySelectorAll<HTMLElement>('.cs')]
    .find((el) => el.querySelector('.cs-label')?.textContent === label);
  if (!row) throw new Error(`no slider labelled ${label} (have ${[...m.host.querySelectorAll('.cs-label')].map((l) => l.textContent).join(', ')})`);
  return row.querySelector<HTMLInputElement>('input[type=range]')!;
}

describe('the schema form needs a scale before it draws a slider', () => {
  it('gives the lens node sliders that reach its real values', () => {
    const view = mount(KIND_LENS_CORRECTION, {
      enabled: true, k1: 0.03, k2: 0, k3: 0, v1: 0, v2: 0, v3: 0, caR: 0, caB: 0, strength: 1,
    });
    const strength = sliderFor(view, 'strength');
    expect(strength.min).toBe('0');
    expect(strength.max).toBe('1');
    // 1/200 of the range. The old fallback stepped by two, on a 0..1 param.
    expect(Number(strength.step)).toBe(0.005);
    expect(Number(strength.value)).toBe(1);

    const k1 = sliderFor(view, 'k1');
    expect([k1.min, k1.max]).toEqual(['-1', '1']);
    expect(Number(k1.step)).toBe(0.01);
    // The value a measured profile actually has, and the old ±100/step-2
    // slider could not hold it.
    expect(Number(k1.value)).toBe(0.03);

    const caR = sliderFor(view, 'caR');
    expect([caR.min, caR.max]).toEqual(['-0.05', '0.05']);
  });

  it('shows as many decimals as the step can reach', () => {
    const view = mount(KIND_LENS_CORRECTION, {
      enabled: true, k1: 0, k2: 0, k3: 0, v1: 0, v2: 0, v3: 0, caR: 0, caB: 0, strength: 0.625,
    });
    const row = [...view.host.querySelectorAll<HTMLElement>('.cs')]
      .find((el) => el.querySelector('.cs-label')?.textContent === 'strength')!;
    // step 0.005 -> three decimals. One decimal, as before, printed the same
    // "0.6" for three different slider positions.
    expect(row.querySelector('.cs-value')?.textContent).toBe('0.625');
  });

  it('gives a number without bounds a field, not a slider', () => {
    const registry = getMainThreadNodeRegistry();
    const kind = 'test:unbounded';
    registry.replace({
      kind,
      category: 'adjustment',
      inputPorts: [{ id: 'in', type: 'color', space: 'either' }],
      outputPorts: [{ id: 'out', type: 'color', space: 'either' }],
      paramSchema: {
        type: 'object',
        properties: {
          free: { type: 'number', default: 0 },
          bounded: { type: 'number', minimum: -1, maximum: 1, default: 0 },
        },
      },
      inputSpace: 'either', outputSpace: 'either',
      requiresFloat: false, samplesNeighbors: false,
      isIdentity: () => false, isAsync: false,
    } as NodeKindSpec);
    try {
      const view = mount(kind, { free: 7, bounded: 0.5 });
      expect(ranges(view)).toHaveLength(1);
      expect(sliderFor(view, 'bounded')).toBeTruthy();
      const numbers = [...view.host.querySelectorAll<HTMLInputElement>('input[type=number]')];
      expect(numbers).toHaveLength(1);
      expect(numbers[0].step).toBe('any');
      expect(numbers[0].value).toBe('7');
    } finally {
      registry.unregister(kind);
    }
  });
});

describe('the custom LUT can be given a file', () => {
  const emptyParams = { size: 33, samples: [] as number[], amount: 1 };

  it('says so when there is none', () => {
    const view = mount(KIND_CUSTOM_LUT, emptyParams);
    expect(view.host.textContent).toContain('graphEditor.inspector.lut.none');
    expect(view.host.textContent).toContain('graphEditor.inspector.lut.inDocument');
  });

  it('parses a dropped .cube into the node params', async () => {
    const view = mount(KIND_CUSTOM_LUT, emptyParams);
    const input = view.host.querySelector<HTMLInputElement>('input[type=file]')!;
    expect(input.accept).toBe('.cube');

    await pickFile(input, new File([TINY_CUBE], 'tiny.cube', { type: 'text/plain' }));

    const emitted = view.emitted()!;
    expect(emitted.size).toBe(2);
    // A plain array, not a Float32Array: the graph is stored as JSON, and a
    // typed array comes back out of it as an object with numeric keys.
    expect(Array.isArray(emitted.samples)).toBe(true);
    expect(emitted.samples).toEqual(Array.from(parseCubeFile(TINY_CUBE).samples));
    expect(emitted.amount).toBe(1);
  });

  it('says what is wrong with a file it cannot read', async () => {
    const view = mount(KIND_CUSTOM_LUT, emptyParams);
    const input = view.host.querySelector<HTMLInputElement>('input[type=file]')!;
    await pickFile(input, new File(['0 0 0\n1 1 1\n'], 'broken.cube'));
    expect(view.emitted()).toBeNull();
    expect(view.host.textContent).toContain('LUT_3D_SIZE');
  });

  it('refuses a cube too large to live in the edit', async () => {
    const view = mount(KIND_CUSTOM_LUT, emptyParams);
    const input = view.host.querySelector<HTMLInputElement>('input[type=file]')!;
    await pickFile(input, new File([cubeOfSize(65)], 'huge.cube'));
    expect(view.emitted()).toBeNull();
    expect(view.host.textContent).toContain('graphEditor.inspector.lut.tooLarge');
  });
});

/** Hand the file input a real FileList and let the async read settle. */
async function pickFile(input: HTMLInputElement, file: File): Promise<void> {
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await file.text();
    await Promise.resolve();
  });
}

function cubeOfSize(size: number): string {
  const lines = [`LUT_3D_SIZE ${size}`];
  for (let i = 0; i < size ** 3; i++) lines.push('0 0 0');
  return lines.join('\n') + '\n';
}
