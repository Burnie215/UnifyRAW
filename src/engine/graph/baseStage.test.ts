/**
 * The base development stage: the camera's own rendering, underneath the edits.
 *
 * The promise being checked is a strange-sounding one - a photo can look
 * developed while every slider reads zero - so it is checked directly rather
 * than trusted. If these break, either the profile stops reaching the picture
 * or it starts leaking into the sliders, and both are silent in the UI.
 */
import { describe, expect, it } from 'vitest';
import {
  buildDefaultGraph,
  chainKindsForSource,
  spliceBaseStage,
  type BuilderAdjustments,
  type BuilderSourceSpec,
} from './DefaultGraphBuilder';
import { KIND_RAW16_SOURCE } from './sources';

const CALIBRATION = { asShotNeutral: [2, 1, 1.5] as [number, number, number], colorMatrix: null };

function raw(baseAdjustments: BuilderAdjustments | null): BuilderSourceSpec {
  return {
    kind: 'raw16',
    geometry: { width: 8, height: 4, pixelRatio: 1 },
    channels: 3,
    calibration: CALIBRATION,
    baseAdjustments,
    lensProfile: null,
    outputColorSpaceId: 'srgb',
  };
}

const NEUTRAL: BuilderAdjustments = {};
// Editor units, the way a saved profile stores them: the pluck functions
// divide by 100 on their way into the shader.
const PROFILE: BuilderAdjustments = { exposure: 20, contrast: 10, sharpness: 40 };

describe('base development stage', () => {
  it('changes nothing at all for a photo without a profile', () => {
    const before = buildDefaultGraph(NEUTRAL, raw(null));
    expect([...before.graph.nodes.keys()].some((id) => id.startsWith('base:'))).toBe(false);
    expect(chainKindsForSource(raw(null))).toEqual(chainKindsForSource(raw(null)));
  });

  it('gives the profile its own nodes instead of merging it into the edits', () => {
    const { graph } = buildDefaultGraph(NEUTRAL, raw(PROFILE));
    const baseIds = [...graph.nodes.keys()].filter((id) => id.startsWith('base:'));
    expect(baseIds).toContain('base:tone');
    expect(baseIds).toContain('base:sharpen');
    // The user's own nodes are still there, untouched and neutral.
    expect(graph.nodes.has('default:tone')).toBe(true);
    expect((graph.nodes.get('default:tone')!.params as { exposure: number }).exposure).toBe(0);
    expect((graph.nodes.get('base:tone')!.params as { exposure: number }).exposure).toBeCloseTo(0.2, 10);
  });

  it('runs the profile before the edits, not after', () => {
    const { graph } = buildDefaultGraph(NEUTRAL, raw(PROFILE));
    const order = [...graph.nodes.keys()];
    expect(order.indexOf('base:tone')).toBeLessThan(order.indexOf('default:tone'));
    expect(order.indexOf('base:sharpen')).toBeLessThan(order.indexOf('default:sharpen'));
  });

  it('keeps the profile out of the passes that must not carry one', () => {
    const { graph } = buildDefaultGraph(NEUTRAL, raw(PROFILE));
    const baseIds = [...graph.nodes.keys()].filter((id) => id.startsWith('base:'));
    // Transform twice flips the image twice; effects and lens belong elsewhere.
    expect(baseIds).not.toContain('base:transform');
    expect(baseIds).not.toContain('base:effects');
    expect(baseIds).not.toContain('base:lensCorrection');
    // Vibrance and saturation ride on hsl and belong in a profile; the sector
    // editors and black-and-white are a look and do not.
    expect(baseIds).toContain('base:hsl');
    expect(baseIds).not.toContain('base:hslDetail');
    expect(baseIds).not.toContain('base:customHsl');
    expect(baseIds).not.toContain('base:bw');
    // White balance is folded into the existing raw node, never duplicated.
    expect(baseIds).not.toContain('base:whiteBalanceRaw');
    expect(baseIds).not.toContain('base:whiteBalance');
  });

  it('folds the profile white balance into the camera gains, multiplicatively', () => {
    const neutral = buildDefaultGraph(NEUTRAL, raw(null));
    const warmed = buildDefaultGraph(NEUTRAL, raw({ temperature: 50 }));
    const before = (neutral.graph.nodes.get('default:whiteBalanceRaw')!.params as { wb: number[] }).wb;
    const after = (warmed.graph.nodes.get('default:whiteBalanceRaw')!.params as { wb: number[] }).wb;

    // Red up, blue down, and the camera's own as-shot gains applied once - a
    // second application would show as red exactly doubling its base of 2.
    expect(after[0]).toBeGreaterThan(before[0]);
    expect(after[2]).toBeLessThan(before[2]);
    expect(after[0] / before[0]).toBeCloseTo(before[2] / after[2], 6);
  });

  it('never adds a base stage to a JPEG', () => {
    const sdr: BuilderSourceSpec = {
      kind: 'imageBitmap', geometry: { width: 8, height: 4, pixelRatio: 1 },
    };
    const { graph } = buildDefaultGraph(NEUTRAL, sdr);
    expect([...graph.nodes.keys()].some((id) => id.startsWith('base:'))).toBe(false);
  });

  it('keeps a profiled graph out of the cache slot of an unprofiled one', () => {
    // graph.id is the compile-cache key; sharing one would mean the first
    // photo compiled decides the topology for every photo after it.
    expect(buildDefaultGraph(NEUTRAL, raw(PROFILE)).graph.id)
      .not.toBe(buildDefaultGraph(NEUTRAL, raw(null)).graph.id);
  });
});

describe('spliceBaseStage', () => {
  it('adds the stage to a stored graph that was frozen without one', () => {
    const stored = buildDefaultGraph(NEUTRAL, raw(null)).graph;
    const { graph, applied } = spliceBaseStage(stored, raw(PROFILE));
    expect(applied).toBe(true);
    expect(graph.nodes.has('base:tone')).toBe(true);
    // Spliced in after ColorMatrix, so the profile runs on linear samples and
    // not on camera-RGB.
    const intoBase = graph.edges.filter((e) => e.to.node === 'base:tone');
    expect(intoBase).toHaveLength(1);
    expect(intoBase[0].from.node).toBe('default:colorMatrix');
  });

  it('leaves one unbroken chain, ending at the output', () => {
    const stored = buildDefaultGraph(NEUTRAL, raw(null)).graph;
    const { graph } = spliceBaseStage(stored, raw(PROFILE));
    const fed = new Set(graph.edges.map((e) => e.to.node));
    const feeds = new Set(graph.edges.map((e) => e.from.node));
    const sourceId = [...graph.nodes.values()].find((n) => n.kind === KIND_RAW16_SOURCE)!.id;

    // Every node except the source is fed by something - a spliced-in node
    // that lost its input would render nothing and raise no error.
    for (const id of graph.nodes.keys()) {
      if (id !== sourceId) expect(fed.has(id), `${id} has no input`).toBe(true);
    }
    // Exactly one node feeds nothing, and it is the declared output.
    const terminals = [...graph.nodes.keys()].filter((id) => !feeds.has(id));
    expect(terminals).toEqual([graph.output]);
  });

  it('is idempotent - a graph already carrying the stage is not spliced twice', () => {
    const once = spliceBaseStage(buildDefaultGraph(NEUTRAL, raw(null)).graph, raw(PROFILE)).graph;
    const twice = spliceBaseStage(once, raw(PROFILE)).graph;
    expect(twice.nodes.size).toBe(once.nodes.size);
    expect(twice.edges.length).toBe(once.edges.length);
  });

  it('leaves a hand-rewired graph with no colour anchors alone', () => {
    const stored = buildDefaultGraph(NEUTRAL, raw(null)).graph;
    const stripped = {
      ...stored,
      nodes: new Map([...stored.nodes].filter(
        ([, n]) => n.kind !== 'colorMatrix' && n.kind !== 'outputColorSpace',
      )),
    };
    const { applied } = spliceBaseStage(stripped, raw(PROFILE));
    expect(applied).toBe(false);
  });
});
