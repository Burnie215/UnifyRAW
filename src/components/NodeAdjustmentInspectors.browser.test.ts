/**
 * What a graph-mode slider writes, and what it shows — measured on the real
 * inspectors, in a real browser, on ABSOLUTE numbers.
 *
 * The 100x regression arose exactly here and no test saw it: the inspectors
 * convert between the editor's ±100 scale and the ±1 the shader reads, and
 * nothing checked that conversion against the two other spellings of the same
 * factor (`DefaultGraphBuilder.div100` on the way in, `paramsToAdjustments`'s
 * `mul100` on the way out). A round trip alone would not have caught it either:
 * both directions read the same constant and move together (F139).
 *
 * So every row below names three numbers: the editor value the seeded document
 * carries, the param the node must hold for it, and the editor value the
 * projection reads back after the slider was moved. A factor that changes on
 * one side of that chain breaks the equality with a literal.
 *
 * Why the browser project and not a jsdom pragma: the thing under test is a
 * scale, and an `<input type="range">` snaps its value to its own `step` — in
 * a real browser, not in jsdom. A harness without that snapping would report a
 * value the user can never actually dial in, which is the same class of
 * measurement error the card is about. It also costs no new devDependency
 * (`jsdom`, `@testing-library/react`) in a tree five agents are installing in
 * parallel; `createRoot` + `act` is what `useGraphEditor.browser.test.ts`
 * already does here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import '../ui/CompactSlider.css';

// Labels are not what this measures, and `useTranslation` without an
// initialised i18next instance throws.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// The two inspectors that delegate to a bigger panel are measured at that
// seam: the stub records the props it was handed and hands back a control the
// test can drive. The wrapping — and only the wrapping — is this file's
// business; the wheel and the curve editor have their own.
const gradingStub: { grading: unknown; onChange: ((next: unknown) => void) | null } = {
  grading: null, onChange: null,
};
vi.mock('./ColorGradingPanel', () => ({
  ColorGradingPanel: (props: { grading: unknown; onChange: (next: unknown) => void }) => {
    gradingStub.grading = props.grading;
    gradingStub.onChange = props.onChange;
    return null;
  },
}));

const curveStub: { curve: unknown; onChange: ((next: unknown) => void) | null } = {
  curve: null, onChange: null,
};
vi.mock('./ToneCurve', () => ({
  ToneCurve: (props: { curve: unknown; onChange: (next: unknown) => void }) => {
    curveStub.curve = props.curve;
    curveStub.onChange = props.onChange;
    return null;
  },
}));

vi.mock('../contexts/EditorContext', () => ({
  useEditor: () => ({ displayUrl: null, preCurveCanvas: null, preCurveGen: 0, glCanvasEl: null, renderGen: 0 }),
}));
vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => ({ histogramStyle: 'luma' }),
}));

import { NodeAdjustmentInspector, hasTailoredInspector } from './NodeAdjustmentInspectors';
import {
  BASE_ADJUSTMENTS, DOC_EFFECTS, DOC_TRANSFORM, SDR,
  documentWith, findLayer, graphFor, nodeParams, patchParams,
} from '../engine/graph/projection/projectionFixtures';
import { projectToDocument } from '../engine/graph/projection/projectToDocument';
import { paramsByNodeFromAdjustments } from '../engine/graph/DefaultGraphBuilder';
import {
  KIND_BW, KIND_CLARITY, KIND_COLOR_GRADING, KIND_DENOISE, KIND_EFFECTS, KIND_HSL,
  KIND_HSL_DETAIL, KIND_SHARPEN, KIND_TEXTURE, KIND_TONE, KIND_TONE_CURVE, KIND_TRANSFORM,
  KIND_WHITE_BALANCE, KIND_WHITE_BALANCE_RAW,
} from '../engine/graph';
import type { PhotoDocument } from '../engine/DocumentModel';
import type { RenderGraph } from '../engine/graph';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SEEDED_DOC = documentWith([]);
const SEEDED_GRAPH = graphFor(SEEDED_DOC, SDR);

interface Mounted {
  ranges: HTMLInputElement[];
  /** The params the inspector emitted on the last change. */
  emitted(): Record<string, unknown>;
  setRange(index: number, value: number): void;
  unmount(): void;
}

let mounted: Mounted | null = null;
afterEach(() => { mounted?.unmount(); mounted = null; });

const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;

function mountInspector(kind: string, params: unknown): Mounted {
  const changes: unknown[] = [];
  const host = document.createElement('div');
  // The vitest page viewport is only a few hundred pixels wide; the rail has
  // a fixed width of its own, so the host gets one too rather than `window`.
  host.style.cssText = 'width:280px;position:fixed;top:0;left:0;';
  document.body.appendChild(host);
  let root: Root;
  act(() => {
    root = createRoot(host);
    root.render(createElement(NodeAdjustmentInspector, {
      node: { id: `default:${kind}`, kind, params },
      onParamsChange: (next: unknown) => changes.push(next),
    }));
  });
  const result: Mounted = {
    ranges: [...host.querySelectorAll<HTMLInputElement>('input[type=range]')],
    emitted() {
      if (changes.length === 0) throw new Error(`${kind}: inspector emitted nothing`);
      return changes[changes.length - 1] as Record<string, unknown>;
    },
    setRange(index, value) {
      const input = result.ranges[index];
      if (!input) throw new Error(`${kind}: no range #${index} (found ${result.ranges.length})`);
      act(() => {
        nativeValueSetter.call(input, String(value));
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    },
    unmount() { act(() => root.unmount()); host.remove(); },
  };
  mounted = result;
  return result;
}

function project(graph: RenderGraph): PhotoDocument {
  const result = projectToDocument(graph, SDR, SEEDED_DOC);
  if (!result.ok) throw new Error('projection blocked: ' + JSON.stringify(result.blocked));
  return result.document;
}

/** The document the graph turns back into once `kind`'s params are replaced. */
function projectWith(kind: string, params: Record<string, unknown>): PhotoDocument {
  return project(patchParams(SEEDED_GRAPH, `default:${kind}`, params));
}

function num(value: unknown): number {
  if (typeof value !== 'number') throw new Error(`expected a number, got ${JSON.stringify(value)}`);
  return value;
}

interface Row {
  kind: string;
  /** Which `input[type=range]` inside the inspector, in document order. */
  range: number;
  /** What the seeded document says this slider stands at. */
  shows: number;
  /** Where the test drags it. */
  dragTo: number;
  /** The param that value has to become — the number on the wire. */
  param: number;
  /** That param, read out of the emitted params object. */
  readParam(emitted: Record<string, unknown>): number;
  /** The editor value the projection reads back out of the patched graph. */
  readBack(doc: PhotoDocument): number;
}

const base = (doc: PhotoDocument) => findLayer(doc, 'base').adjustments as Record<string, unknown>;

const ROWS: Row[] = [
  {
    kind: KIND_TONE, range: 0, shows: BASE_ADJUSTMENTS.exposure!, dragTo: 52, param: 0.52,
    readParam: (e) => num(e.exposure), readBack: (d) => num(base(d).exposure),
  },
  {
    kind: KIND_WHITE_BALANCE, range: 0, shows: BASE_ADJUSTMENTS.temperature!, dragTo: -44, param: -0.44,
    readParam: (e) => num(e.temperature), readBack: (d) => num(base(d).temperature),
  },
  {
    kind: KIND_HSL, range: 0, shows: BASE_ADJUSTMENTS.vibrance!, dragTo: 66, param: 0.66,
    readParam: (e) => num(e.vibrance), readBack: (d) => num(base(d).vibrance),
  },
  {
    // The channel sliders are already on the editor scale; asserting -25 in
    // the params is what proves no factor sneaks in here.
    kind: KIND_HSL_DETAIL, range: 0, shows: BASE_ADJUSTMENTS.hsl!.red.hue, dragTo: -25, param: -25,
    readParam: (e) => num((e.channels as Record<string, { hue: number }>).red.hue),
    readBack: (d) => num((base(d).hsl as Record<string, { hue: number }>).red.hue),
  },
  {
    kind: KIND_BW, range: 0, shows: BASE_ADJUSTMENTS.bwMix!.red, dragTo: 40, param: 40,
    readParam: (e) => num((e.mix as Record<string, number>).red),
    readBack: (d) => num((base(d).bwMix as Record<string, number>).red),
  },
  {
    kind: KIND_CLARITY, range: 0, shows: BASE_ADJUSTMENTS.clarity!, dragTo: -9, param: -0.09,
    readParam: (e) => num(e.clarity), readBack: (d) => num(base(d).clarity),
  },
  {
    kind: KIND_TEXTURE, range: 0, shows: BASE_ADJUSTMENTS.texture!, dragTo: 71, param: 0.71,
    readParam: (e) => num(e.amount), readBack: (d) => num(base(d).texture),
  },
  {
    kind: KIND_SHARPEN, range: 0, shows: BASE_ADJUSTMENTS.sharpness!, dragTo: 120, param: 1.2,
    readParam: (e) => num(e.sharpness), readBack: (d) => num(base(d).sharpness),
  },
  {
    kind: KIND_DENOISE, range: 0, shows: BASE_ADJUSTMENTS.denoiseLuma!, dragTo: 63, param: 0.63,
    readParam: (e) => num(e.luma), readBack: (d) => num(base(d).denoiseLuma),
  },
  {
    // Vignette lives at document level, not in the base layer.
    kind: KIND_EFFECTS, range: 0, shows: DOC_EFFECTS.vignette, dragTo: 28, param: 0.28,
    readParam: (e) => num(e.vignette), readBack: (d) => num(d.finalEffects.vignette),
  },
  {
    kind: KIND_TRANSFORM, range: 1, shows: DOC_TRANSFORM.perspectiveH, dragTo: 35, param: 0.35,
    readParam: (e) => num(e.perspectiveH), readBack: (d) => num(d.transform.perspectiveH),
  },
];

describe('tailored inspectors, scale round trip', () => {
  it.each(ROWS)('$kind shows the seeded value on the editor scale', (row) => {
    const params = nodeParams(SEEDED_GRAPH, `default:${row.kind}`);
    const view = mountInspector(row.kind, params);
    expect(Number(view.ranges[row.range].value)).toBe(row.shows);
  });

  it.each(ROWS)('$kind writes the param the shader reads', (row) => {
    const params = nodeParams(SEEDED_GRAPH, `default:${row.kind}`);
    const view = mountInspector(row.kind, params);
    view.setRange(row.range, row.dragTo);
    expect(row.readParam(view.emitted())).toBeCloseTo(row.param, 10);
  });

  it.each(ROWS)('$kind comes back off the graph as the value that was dialled', (row) => {
    const params = nodeParams(SEEDED_GRAPH, `default:${row.kind}`);
    const view = mountInspector(row.kind, params);
    view.setRange(row.range, row.dragTo);
    const doc = projectWith(row.kind, view.emitted());
    expect(row.readBack(doc)).toBeCloseTo(row.dragTo, 6);
  });
});

describe('tailored inspectors, the rest of the fourteen', () => {
  it('every handled kind has an inspector that renders', () => {
    const kinds = [...ROWS.map((r) => r.kind), KIND_COLOR_GRADING, KIND_TONE_CURVE, KIND_WHITE_BALANCE_RAW];
    for (const kind of kinds) expect(hasTailoredInspector(kind)).toBe(true);
    expect(kinds).toHaveLength(14);
  });

  it('transform turns degrees into radians and back', () => {
    // The same factor was missing once already and made every rotation
    // 180/pi times too strong, so it gets a literal of its own.
    const params = nodeParams(SEEDED_GRAPH, `default:${KIND_TRANSFORM}`);
    const view = mountInspector(KIND_TRANSFORM, params);
    view.setRange(0, 90);
    expect(num(view.emitted().rotation)).toBeCloseTo(Math.PI / 2, 10);
    expect(num(projectWith(KIND_TRANSFORM, view.emitted()).transform.rotation)).toBeCloseTo(90, 6);
  });

  it('color grading hands the wheel editor-scale numbers and stores param-scale ones', () => {
    const params = nodeParams(SEEDED_GRAPH, `default:${KIND_COLOR_GRADING}`);
    const seeded = BASE_ADJUSTMENTS.colorGrading!;
    mountInspector(KIND_COLOR_GRADING, params);
    const shown = gradingStub.grading as { shadows: { hue: number; satAdj: number; lumAdj: number } };
    expect(shown.shadows.satAdj).toBe(seeded.shadows.satAdj);
    expect(shown.shadows.lumAdj).toBe(seeded.shadows.lumAdj);
    // Untouched by the scale: the hue of the wheel is degrees on both sides.
    expect(shown.shadows.hue).toBe(seeded.shadows.hue);

    let emitted: Record<string, unknown> | null = null;
    act(() => {
      gradingStub.onChange!({ ...shown, shadows: { ...shown.shadows, satAdj: 42 } });
    });
    // The stub's onChange is the inspector's handler, which calls
    // onParamsChange synchronously.
    emitted = lastGradingParams();
    const shadows = emitted.shadows as { satAdj: number };
    expect(shadows.satAdj).toBeCloseTo(0.42, 10);
    const doc = projectWith(KIND_COLOR_GRADING, emitted);
    expect((base(doc).colorGrading as { shadows: { satAdj: number } }).shadows.satAdj).toBeCloseTo(42, 6);
  });

  it('the tone curve passes through untouched — a curve has no ±100 scale', () => {
    const params = nodeParams(SEEDED_GRAPH, `default:${KIND_TONE_CURVE}`);
    mountInspector(KIND_TONE_CURVE, params);
    expect(curveStub.curve).toBe(params);
    const next = { ...(params as object), rgb: [{ x: 0, y: 0 }, { x: 1, y: 0.5 }] };
    act(() => { curveStub.onChange!(next); });
    expect(mounted!.emitted()).toBe(next);
  });

  it('raw white balance multipliers are not on the editor scale', () => {
    // A raw chain carries no `default:whiteBalanceRaw` params under SDR, so
    // the builder is asked for them directly.
    const params = paramsByNodeFromAdjustments({}, {
      kind: 'raw16',
      geometry: { width: 4, height: 4, pixelRatio: 1 },
      channels: 3,
      baseAdjustments: null,
      lensProfile: null,
      calibration: { asShotNeutral: [2, 1, 1.5], colorMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
    }).get(`default:${KIND_WHITE_BALANCE_RAW}`);
    const view = mountInspector(KIND_WHITE_BALANCE_RAW, params);
    expect(view.ranges).toHaveLength(3);
    view.setRange(0, 2.5);
    expect(num((view.emitted().wb as number[])[0])).toBe(2.5);
  });
});

/** The params the color-grading inspector emitted, via the shared mount. */
function lastGradingParams(): Record<string, unknown> {
  return mounted!.emitted();
}
