import { describe, expect, it } from 'vitest';

import { CHAIN_REASONS, KINDS_WITHOUT_CLASSIC_EQUIVALENT, checkChainRules, nodeKindLabel } from './chainRules';
import { scanGraphShape } from './shapeScan';
import {
  buildDefaultGraph,
  buildLayeredGraph,
  chainKindsForSource,
  spliceRetouch,
  type BuilderLayer,
  type BuilderSourceSpec,
} from '../DefaultGraphBuilder';
import type { SpotRemoval } from '../../Mask';
import { KIND_CONVERT_GAMMA_TO_LIN } from '../builtins';
import {
  KIND_BW,
  KIND_CLARITY,
  KIND_LENS_CORRECTION,
  KIND_LEVELS,
  KIND_OUTPUT_COLOR_SPACE,
  KIND_RETOUCH,
  KIND_TONE,
  KIND_TONE_CURVE,
  KIND_TRANSFORM,
  KIND_WHITE_BALANCE,
} from '../passKinds';
import { KIND_CUSTOM_LUT } from '../lutKinds';
import { RAW_PROFILED } from './projectionFixtures';
import type { RenderGraph } from '../types';

const SDR: BuilderSourceSpec = { kind: 'imageBitmap', geometry: { width: 16, height: 8, pixelRatio: 1 } };
const RAW: BuilderSourceSpec = {
  kind: 'raw16', geometry: { width: 16, height: 8, pixelRatio: 1 }, channels: 3,
  baseAdjustments: null, lensProfile: null,
};

const L1: BuilderLayer = { id: 'L1', adjustments: { contrast: 20 }, opacity: 0.8, blendMode: 'normal' };
const L2: BuilderLayer = { id: 'L2', adjustments: { exposure: 15 }, opacity: 0.5, blendMode: 'multiply', useMask: true };

/** Fixtures come from the real builder — a hand-written graph would drift from
 *  what ships, and these rules are measured against exactly that. */
const flat = (source: BuilderSourceSpec = SDR): RenderGraph => buildDefaultGraph({ exposure: 10 }, source).graph;
const layered = (layers: BuilderLayer[], source: BuilderSourceSpec = SDR): RenderGraph =>
  buildLayeredGraph({ exposure: 10 }, layers, source).graph;

/** Run the rules through the seam they sit on: the shape scan has to accept
 *  the fixture first, otherwise the test would be checking a graph that never
 *  reaches these rules in production. */
function rules(graph: RenderGraph, source: BuilderSourceSpec = SDR) {
  const scan = scanGraphShape(graph);
  if (!scan.ok) throw new Error('fixture is not a projectable shape: ' + JSON.stringify(scan.blocked));
  return checkChainRules(graph, scan.shape, source);
}

// ─── Graph surgery helpers ─────────────────────────────────────────

function inboundEdge(graph: RenderGraph, nodeId: string) {
  const edge = graph.edges.find((e) => e.to.node === nodeId && e.to.port === 'in');
  if (!edge) throw new Error(`no inbound edge for ${nodeId}`);
  return edge;
}

function outboundEdge(graph: RenderGraph, nodeId: string) {
  const edge = graph.edges.find((e) => e.from.node === nodeId);
  if (!edge) throw new Error(`no outbound edge for ${nodeId}`);
  return edge;
}

/** Insert a node directly ahead of `beforeId`, taking over its inbound edge. */
function spliceBefore(graph: RenderGraph, beforeId: string, id: string, kind: string): RenderGraph {
  const inbound = inboundEdge(graph, beforeId);
  const nodes = new Map(graph.nodes).set(id, { id, kind, params: {} });
  const edges = graph.edges.filter((e) => e !== inbound).concat([
    { id: `e:spliced-in:${id}`, from: inbound.from, to: { node: id, port: 'in' } },
    { id: `e:spliced-out:${id}`, from: { node: id, port: 'out' }, to: { node: beforeId, port: 'in' } },
  ]);
  return { ...graph, nodes, edges };
}

/** Swap two nodes that sit next to each other in a chain. */
function swapAdjacent(graph: RenderGraph, firstId: string, secondId: string): RenderGraph {
  const inbound = inboundEdge(graph, firstId);
  const link = graph.edges.find((e) => e.from.node === firstId && e.to.node === secondId);
  if (!link) throw new Error(`${firstId} does not feed ${secondId}`);
  const outbound = outboundEdge(graph, secondId);
  const edges = graph.edges
    .filter((e) => e !== inbound && e !== link && e !== outbound)
    .concat([
      { id: 'e:swap-head', from: inbound.from, to: { node: secondId, port: 'in' } },
      { id: 'e:swap-mid', from: { node: secondId, port: 'out' }, to: { node: firstId, port: 'in' } },
      { id: 'e:swap-tail', from: { node: firstId, port: 'out' }, to: outbound.to },
    ]);
  return { ...graph, edges };
}

/** Delete a node and heal the chain across it, the way the editor's delete does. */
function dropNode(graph: RenderGraph, nodeId: string): RenderGraph {
  const before = inboundEdge(graph, nodeId).from;
  const after = outboundEdge(graph, nodeId).to;
  const nodes = new Map(graph.nodes);
  nodes.delete(nodeId);
  const edges = graph.edges
    .filter((e) => e.from.node !== nodeId && e.to.node !== nodeId)
    .concat([{ id: `e:healed:${nodeId}`, from: before, to: after }]);
  return { ...graph, nodes, edges };
}

// ─── Silence on correct graphs ─────────────────────────────────────

describe('checkChainRules on graphs the builder produced', () => {
  it('says nothing about a flat SDR graph', () => {
    expect(rules(flat())).toEqual([]);
  });

  it('says nothing about a base chain plus two layers, one of them masked', () => {
    expect(rules(layered([L1, L2]))).toEqual([]);
  });

  it('says nothing about a RAW graph, whose chain has a different order', () => {
    expect(rules(flat(RAW), RAW)).toEqual([]);
    expect(rules(layered([L1, L2], RAW), RAW)).toEqual([]);
  });

  it('ignores a node that hangs outside every chain', () => {
    const graph = layered([L1]);
    const nodes = new Map(graph.nodes)
      .set('user:orphan', { id: 'user:orphan', kind: KIND_CUSTOM_LUT, params: {} });
    expect(rules({ ...graph, nodes })).toEqual([]);
  });
});

describe('checkChainRules on a RAW with a camera profile', () => {
  it('says nothing about the graph the builder built for it', () => {
    expect(rules(flat(RAW_PROFILED), RAW_PROFILED)).toEqual([]);
    expect(rules(layered([L1, L2], RAW_PROFILED), RAW_PROFILED)).toEqual([]);
  });

  it('blocks a base node of a kind the profile never occupies', () => {
    const graph = spliceBefore(flat(RAW_PROFILED), `base:${KIND_TONE}`, `base:${KIND_BW}`, KIND_BW);
    expect(rules(graph, RAW_PROFILED)).toEqual([
      { nodeId: `base:${KIND_BW}`, reason: CHAIN_REASONS.baseStageKind(KIND_BW) },
    ]);
  });

  it('does not call a user tone behind base:tone a duplicate, but still a second user tone', () => {
    const moved = spliceBefore(
      dropNode(flat(RAW_PROFILED), `default:${KIND_TONE}`),
      `default:${KIND_TONE_CURVE}`, 'user:tone', KIND_TONE,
    );
    expect(rules(moved, RAW_PROFILED)).toEqual([]);

    const twice = spliceBefore(flat(RAW_PROFILED), `default:${KIND_TONE_CURVE}`, 'user:tone', KIND_TONE);
    expect(rules(twice, RAW_PROFILED)).toEqual([
      { nodeId: 'user:tone', reason: CHAIN_REASONS.duplicateKind(KIND_TONE) },
    ]);
  });
});

// ─── Rule 1: no classic equivalent ─────────────────────────────────

describe('rule 1 — a kind the classic view has no node for', () => {
  it.each([...KINDS_WITHOUT_CLASSIC_EQUIVALENT])('blocks %s with one finding', (kind) => {
    const graph = spliceBefore(layered([L1]), `default:${KIND_TONE}`, 'user:extra', kind);
    expect(rules(graph)).toEqual([
      { nodeId: 'user:extra', reason: CHAIN_REASONS.noClassicEquivalent(kind) },
    ]);
  });

  it('covers all ten kinds the plan enumerates', () => {
    expect(KINDS_WITHOUT_CLASSIC_EQUIVALENT).toHaveLength(10);
    // None of them may be part of the classic chain, for either source.
    for (const source of [SDR, RAW]) {
      const classic = new Set(chainKindsForSource(source));
      for (const kind of KINDS_WITHOUT_CLASSIC_EQUIVALENT) expect(classic.has(kind)).toBe(false);
    }
  });

  it('blocks a compiler-emitted convert node that ended up in a stored graph', () => {
    const graph = spliceBefore(layered([L1]), `default:${KIND_TONE}`, 'user:convert', KIND_CONVERT_GAMMA_TO_LIN);
    expect(rules(graph)).toEqual([
      { nodeId: 'user:convert', reason: CHAIN_REASONS.noClassicEquivalent(KIND_CONVERT_GAMMA_TO_LIN) },
    ]);
  });

  it('reads the vocabulary from the source: whiteBalance is classic for SDR, graph-only for RAW', () => {
    // The very same kind, judged against the two chains. The SDR fixture
    // already carries a whiteBalance node and stays silent.
    expect(rules(flat())).toEqual([]);
    expect(chainKindsForSource(SDR)).toContain(KIND_WHITE_BALANCE);

    const rawGraph = spliceBefore(flat(RAW), `default:${KIND_LEVELS}`, 'user:wb', KIND_WHITE_BALANCE);
    expect(rules(rawGraph, RAW)).toEqual([
      { nodeId: 'user:wb', reason: CHAIN_REASONS.noClassicEquivalent(KIND_WHITE_BALANCE) },
    ]);
  });

  it('finds it in a layer chain and names that node, not the base one', () => {
    const graph = spliceBefore(layered([L1, L2]), `layer:L2:default:${KIND_TONE}`, 'user:lut', KIND_CUSTOM_LUT);
    expect(rules(graph)).toEqual([
      { nodeId: 'user:lut', reason: CHAIN_REASONS.noClassicEquivalent(KIND_CUSTOM_LUT) },
    ]);
  });
});

// ─── Rule 2: order ─────────────────────────────────────────────────

describe('rule 2 — chain order deviating from the classic pipeline', () => {
  it('blocks two swapped neighbours and stays silent before the swap', () => {
    const clean = layered([L1]);
    expect(rules(clean)).toEqual([]);

    const swapped = swapAdjacent(clean, `default:${KIND_TONE}`, `default:${KIND_WHITE_BALANCE}`);
    expect(rules(swapped)).toEqual([
      {
        nodeId: `default:${KIND_TONE}`,
        reason: CHAIN_REASONS.wrongOrder(KIND_WHITE_BALANCE, KIND_TONE),
      },
    ]);
  });

  it('reports one finding for one node moved to the head, not one per node behind it', () => {
    // Transform is the last classic step; put it first without duplicating it.
    const moved = spliceBefore(
      dropNode(layered([L1]), `default:${KIND_TRANSFORM}`),
      `default:${KIND_LENS_CORRECTION}`,
      `default:${KIND_TRANSFORM}`,
      KIND_TRANSFORM,
    );
    expect(rules(moved)).toEqual([
      {
        nodeId: `default:${KIND_LENS_CORRECTION}`,
        reason: CHAIN_REASONS.wrongOrder(KIND_TRANSFORM, KIND_LENS_CORRECTION),
      },
    ]);
  });

  it('checks layer chains too', () => {
    const swapped = swapAdjacent(
      layered([L1, L2]),
      `layer:L1:default:${KIND_TONE}`,
      `layer:L1:default:${KIND_WHITE_BALANCE}`,
    );
    expect(rules(swapped)).toEqual([
      {
        nodeId: `layer:L1:default:${KIND_TONE}`,
        reason: CHAIN_REASONS.wrongOrder(KIND_WHITE_BALANCE, KIND_TONE),
      },
    ]);
  });

  it('does not let an unsupported kind fake an order violation', () => {
    // A node with no classic position must not shift the order cursor, or the
    // single custom LUT below would drag a second complaint along.
    const graph = spliceBefore(layered([L1]), `default:${KIND_LEVELS}`, 'user:lut', KIND_CUSTOM_LUT);
    const found = rules(graph);
    expect(found).toHaveLength(1);
    expect(found[0].reason).toEqual(CHAIN_REASONS.noClassicEquivalent(KIND_CUSTOM_LUT));
  });
});

// ─── Rule 3: duplicates ────────────────────────────────────────────

describe('rule 3 — the same kind twice in one chain', () => {
  it('blocks a second node of the same kind next to the first', () => {
    const graph = spliceBefore(layered([L1]), `default:${KIND_WHITE_BALANCE}`, 'user:tone2', KIND_TONE);
    expect(rules(graph)).toEqual([
      { nodeId: 'user:tone2', reason: CHAIN_REASONS.duplicateKind(KIND_TONE) },
    ]);
  });

  it('blocks a second node of the same kind further down, and the order with it', () => {
    // Tone belongs near the front; a copy behind Clarity is both a duplicate
    // and out of order, and both findings are worth telling.
    const graph = spliceBefore(layered([L1]), `default:${KIND_OUTPUT_COLOR_SPACE}`, 'user:tone2', KIND_TONE);
    expect(rules(graph)).toEqual(expect.arrayContaining([
      { nodeId: 'user:tone2', reason: CHAIN_REASONS.duplicateKind(KIND_TONE) },
      { nodeId: 'user:tone2', reason: CHAIN_REASONS.wrongOrder(KIND_CLARITY, KIND_TONE) },
    ]));
  });

  it('does not call a re-inserted node a duplicate after the original was deleted', () => {
    const graph = spliceBefore(
      dropNode(layered([L1]), `default:${KIND_TONE}`),
      `default:${KIND_WHITE_BALANCE}`,
      'user:tone-again',
      KIND_TONE,
    );
    expect(rules(graph)).toEqual([]);
  });

  it('keeps the count per chain — the same kind in base and layer is normal', () => {
    // Every branch runs the full chain, so kinds repeat across chains by
    // design. Only a repeat INSIDE one chain is a finding.
    const graph = layered([L1, L2]);
    expect(rules(graph)).toEqual([]);
    expect(graph.nodes.has(`default:${KIND_TONE}`)).toBe(true);
    expect(graph.nodes.has(`layer:L1:default:${KIND_TONE}`)).toBe(true);
  });
});

// ─── Explicitly not blocking ───────────────────────────────────────

describe('what the plan rules out as blocking', () => {
  it('a deleted node is fine — it stands for identity parameters', () => {
    const base = dropNode(layered([L1, L2]), `default:${KIND_LEVELS}`);
    expect(rules(base)).toEqual([]);

    const inLayer = dropNode(base, `layer:L1:default:${KIND_CLARITY}`);
    expect(rules(inLayer)).toEqual([]);

    // Even an empty chain: strip the whole base chain node by node.
    let stripped = layered([L1]);
    for (const kind of chainKindsForSource(SDR)) stripped = dropNode(stripped, `default:${kind}`);
    expect(rules(stripped)).toEqual([]);
  });

  it('moved nodes are fine — layout is not semantics', () => {
    const graph = layered([L1, L2]);
    const nodePositions: Record<string, { x: number; y: number }> = {};
    let i = 0;
    for (const id of graph.nodes.keys()) {
      nodePositions[id] = { x: (i % 5) * 137 - 400, y: Math.floor(i / 5) * -211 };
      i += 1;
    }
    const moved: RenderGraph = { ...graph, metadata: { ...graph.metadata, nodePositions } };
    expect(rules(moved)).toEqual([]);
  });
});

// ─── Retouch ───────────────────────────────────────────────────────

describe('the retouch node', () => {
  const SPOTS: SpotRemoval[] = [{
    id: 's1', mode: 'heal',
    target: { x: 0.5, y: 0.5, radius: 0.1 },
    source: { x: 0.2, y: 0.5 }, feather: 0.5, opacity: 1,
  }];
  const retouched = (source: BuilderSourceSpec) =>
    spliceRetouch(flat(source), SPOTS).graph;

  it.each([['SDR', SDR], ['RAW', RAW], ['RAW+Profil', RAW_PROFILED]] as const)(
    'passes on a %s chain instead of locking the document', (_name, source) => {
      // Without the rule knowing this kind, every retouched photo reports
      // "no classic equivalent" and is frozen in graph mode (the F011
      // pattern) over an edit the classic view expresses fine.
      expect(rules(retouched(source), source)).toEqual([]);
    });

  it('is out of order when it sits behind the user chain', () => {
    // It belongs on the developed picture, under the edits. A node moved
    // behind them is a different picture and the classic view has no way to
    // say so.
    const moved = spliceBefore(
      dropNode(retouched(SDR), 'default:retouch'),
      `default:${KIND_OUTPUT_COLOR_SPACE}`,
      'default:retouch',
      KIND_RETOUCH,
    );
    expect(rules(moved)).toEqual([
      { nodeId: 'default:retouch', reason: CHAIN_REASONS.wrongOrder(KIND_CLARITY, KIND_RETOUCH) },
    ]);
  });
});

// ─── Naming ────────────────────────────────────────────────────────

describe('reason naming', () => {
  // The sentences are not here any more: the rule names the finding and the
  // surface writes it out (src/i18n/gateReasons.test.ts checks that both
  // locales carry every key). What stays engine business is WHICH key is
  // raised and that the node kind rides along raw, so the surface can spell
  // it the same way the rest of the editor does.
  it('names the finding and carries the node kinds untranslated', () => {
    expect(CHAIN_REASONS.noClassicEquivalent(KIND_CUSTOM_LUT))
      .toEqual({ key: 'chain.noClassicEquivalent', params: { kind: KIND_CUSTOM_LUT } });
    expect(CHAIN_REASONS.wrongOrder(KIND_TRANSFORM, KIND_TONE)).toEqual({
      key: 'chain.wrongOrder',
      params: { earlierKind: KIND_TRANSFORM, laterKind: KIND_TONE },
    });
    expect(CHAIN_REASONS.duplicateKind(KIND_TONE))
      .toEqual({ key: 'chain.duplicateKind', params: { kind: KIND_TONE } });
    expect(CHAIN_REASONS.baseStageKind(KIND_BW))
      .toEqual({ key: 'chain.baseStageKind', params: { kind: KIND_BW } });
  });

  it('reads a machine kind as a node name', () => {
    expect(nodeKindLabel(KIND_WHITE_BALANCE)).toBe('White Balance');
    expect(nodeKindLabel('__encoder.multiOutput')).toBe('Encoder · multi Output');
  });
});
