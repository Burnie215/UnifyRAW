/**
 * Step 2 of the single-source-of-truth plan, first half of the missing
 * direction: recognise the shape of a graph so it can be written back as a
 * document. Pure — no GL, no registry, no React.
 *
 * The form a document can describe is exactly this:
 *
 *   source ─┬─ chain(base) ───────────────┬─ composite(L1) ─ … ─ output
 *           ├─ chain(L1) ─────────────────┘        │
 *           ├─ chain(L2) ──────────────────────────┘
 *           └─ maskSource(L1) ─────────────────────┘
 *
 * This module answers "is the graph shaped like that, and which node is
 * what" and nothing else. Whether the nodes INSIDE a chain are admissible
 * (unknown kinds, order, duplicates) belongs to the chain rules, and turning
 * their params back into adjustments belongs to the parameter inversion —
 * both build on the shape found here.
 *
 * Every rejection carries a reason meant for the person looking at a locked
 * button. Without one, marking a node is an accusation rather than an
 * explanation.
 */
import type { Edge, RenderGraph } from '../types';
import { KIND_COMPOSITE } from '../compositorKinds';
import { KIND_CROP } from '../passKinds';
import { KIND_IMAGE_BITMAP_SOURCE, KIND_RAW16_SOURCE, KIND_RASTERIZED_MASK_SOURCE } from '../sources';
import { blockReasonId, type BlockReason } from './blockReasons';

/** A node that stands in the way, with the reason shown to the user. */
export interface BlockedNode {
  nodeId: string;
  reason: BlockReason;
}

/** One adjustment chain rooted at the source. */
export interface ScannedChain {
  /** Nodes in flow order, source excluded. Empty when nothing sits between
   *  the source and the consumer — a document with no edits at all. */
  nodeIds: string[];
  /** Node whose output leaves the chain (the source itself if empty). */
  terminalId: string;
}

/** One layer: its compositor, its chain, and the mask feeding the compositor. */
export interface ScannedLayer {
  compositorId: string;
  chain: ScannedChain;
  /** Mask source bound to the compositor's `mask` port, or null. */
  maskNodeId: string | null;
}

export interface GraphShape {
  sourceNodeId: string;
  base: ScannedChain;
  /**
   * Layers in stacking order, bottom first — the order the compositor cascade
   * applies them, which is the order `DocLayer[]` holds them. Taken from the
   * cascade itself, never guessed from node ids: a user may have renamed
   * nodes or built the stack by hand.
   */
  layers: ScannedLayer[];
  /** Document-wide nodes after the completed layer stack. Currently crop. */
  post: ScannedChain;
}

export type ShapeScanResult =
  | { ok: true; shape: GraphShape }
  | { ok: false; blocked: BlockedNode[] };

const IMAGE_SOURCE_KINDS = new Set([KIND_IMAGE_BITMAP_SOURCE, KIND_RAW16_SOURCE]);

/** The structural findings, by key. The sentences live in the locale files
 *  under `gate.reasons.shape.*`; the tests assert on these keys. */
export const SHAPE_REASONS = {
  /** Plan: "Zweig, der nicht an der Quelle beginnt". */
  branchOffIntermediate: { key: 'shape.branchOffIntermediate' },
  /** Plan: "Verzweigung außerhalb des Ebenenmusters". */
  notAStack: { key: 'shape.notAStack' },
  noImageSource: { key: 'shape.noImageSource' },
  severalImageSources: { key: 'shape.severalImageSources' },
  maskNotASource: { key: 'shape.maskNotASource' },
  missingInput: { key: 'shape.missingInput' },
  cycle: { key: 'shape.cycle' },
} as const satisfies Record<string, BlockReason>;

export function scanGraphShape(graph: RenderGraph): ShapeScanResult {
  const blocked: BlockedNode[] = [];
  const add = (nodeId: string, reason: BlockReason) => {
    const id = blockReasonId(reason);
    if (!blocked.some((b) => b.nodeId === nodeId && blockReasonId(b.reason) === id)) {
      blocked.push({ nodeId, reason });
    }
  };

  const imageSources: string[] = [];
  for (const [id, node] of graph.nodes) {
    if (IMAGE_SOURCE_KINDS.has(node.kind)) imageSources.push(id);
  }
  if (imageSources.length === 0) {
    return { ok: false, blocked: [{ nodeId: graph.output, reason: SHAPE_REASONS.noImageSource }] };
  }
  if (imageSources.length > 1) {
    // Every one of them is equally responsible, so mark them all — the user
    // has to decide which to remove.
    return {
      ok: false,
      blocked: imageSources.map((id) => ({ nodeId: id, reason: SHAPE_REASONS.severalImageSources })),
    };
  }
  const sourceNodeId = imageSources[0];

  const inboundByNode = groupInboundEdges(graph.edges);
  const consumerCount = countConsumers(graph.edges);
  const isComposite = (id: string) => graph.nodes.get(id)?.kind === KIND_COMPOSITE;

  // A document-wide crop sits behind the completed layer stack. Peel that
  // terminal tail first; otherwise a crop after a compositor looks like a
  // branch rooted at an intermediate result and the graph cannot project
  // back to the classic document that created it.
  const postReversed: string[] = [];
  const postSeen = new Set<string>();
  let cursor = graph.output;
  while (graph.nodes.get(cursor)?.kind === KIND_CROP) {
    if (postSeen.has(cursor)) {
      add(cursor, SHAPE_REASONS.cycle);
      return { ok: false, blocked };
    }
    postSeen.add(cursor);
    postReversed.push(cursor);
    const input = inboundByNode.get(cursor)?.get('in');
    if (!input) {
      add(cursor, SHAPE_REASONS.missingInput);
      return { ok: false, blocked };
    }
    cursor = input;
  }
  const postNodeIds = postReversed.reverse();
  const post: ScannedChain = { nodeIds: postNodeIds, terminalId: graph.output };

  // The cascade, walked backwards from the post-crop input along `in`.
  // Anything that is not a compositor ends it and is the base chain's terminal.
  const cascade: string[] = [];
  const seen = new Set<string>();
  while (isComposite(cursor)) {
    if (seen.has(cursor)) {
      add(cursor, SHAPE_REASONS.cycle);
      return { ok: false, blocked };
    }
    seen.add(cursor);
    cascade.push(cursor);
    const stackInput = inboundByNode.get(cursor)?.get('in');
    if (!stackInput) {
      add(cursor, SHAPE_REASONS.missingInput);
      return { ok: false, blocked };
    }
    cursor = stackInput;
  }
  cascade.reverse(); // bottom of the stack first
  const baseTerminalId = cursor;

  // Base chain and one chain per layer, each walked back to the source.
  const base = walkChainToSource(graph, baseTerminalId, sourceNodeId, inboundByNode, add);
  const layers: ScannedLayer[] = [];
  for (const compositorId of cascade) {
    const ports = inboundByNode.get(compositorId);
    const layerInput = ports?.get('layer');
    if (!layerInput) {
      add(compositorId, SHAPE_REASONS.missingInput);
      continue;
    }
    if (isComposite(layerInput)) {
      // Explicitly called out in the plan: a composite feeding another
      // composite's layer port is a tree, not a stack.
      add(layerInput, SHAPE_REASONS.notAStack);
      continue;
    }
    const chain = walkChainToSource(graph, layerInput, sourceNodeId, inboundByNode, add);

    const maskInput = ports?.get('mask') ?? null;
    let maskNodeId: string | null = null;
    if (maskInput !== null) {
      if (graph.nodes.get(maskInput)?.kind === KIND_RASTERIZED_MASK_SOURCE) {
        maskNodeId = maskInput;
      } else {
        add(maskInput, SHAPE_REASONS.maskNotASource);
      }
    }
    layers.push({ compositorId, chain: chain ?? { nodeIds: [], terminalId: layerInput }, maskNodeId });
  }

  // Fan-out: only the source may feed several consumers (base + branches).
  // A mask source feeds exactly its compositor. Everything else is a chain
  // link and has to have a single consumer, or the graph is not a stack.
  for (const [id, count] of consumerCount) {
    if (count <= 1 || id === sourceNodeId) continue;
    add(id, SHAPE_REASONS.notAStack);
  }

  if (blocked.length > 0 || !base) return { ok: false, blocked };
  return { ok: true, shape: { sourceNodeId, base, layers, post } };
}

/**
 * Walk back from `terminalId` along `in` edges and return the chain in flow
 * order. The walk has to end at `sourceNodeId`; ending anywhere else means
 * the branch hangs off an intermediate result, which a layer cannot express.
 */
function walkChainToSource(
  graph: RenderGraph,
  terminalId: string,
  sourceNodeId: string,
  inboundByNode: Map<string, Map<string, string>>,
  add: (nodeId: string, reason: BlockReason) => void,
): ScannedChain | null {
  if (terminalId === sourceNodeId) return { nodeIds: [], terminalId: sourceNodeId };

  const reversed: string[] = [];
  const visited = new Set<string>();
  let cursor = terminalId;
  for (;;) {
    if (visited.has(cursor)) {
      add(cursor, SHAPE_REASONS.cycle);
      return null;
    }
    visited.add(cursor);
    reversed.push(cursor);

    const previous = inboundByNode.get(cursor)?.get('in');
    if (previous === undefined) {
      add(cursor, SHAPE_REASONS.missingInput);
      return null;
    }
    if (previous === sourceNodeId) break;
    if (graph.nodes.get(previous)?.kind === KIND_COMPOSITE) {
      add(terminalId, SHAPE_REASONS.branchOffIntermediate);
      return null;
    }
    cursor = previous;
  }
  reversed.reverse();
  return { nodeIds: reversed, terminalId };
}

/** node -> (port -> producing node). Only the first edge per port counts;
 *  a second one on the same port is a wiring error the compiler rejects. */
function groupInboundEdges(edges: Edge[]): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const edge of edges) {
    let ports = out.get(edge.to.node);
    if (!ports) { ports = new Map(); out.set(edge.to.node, ports); }
    if (!ports.has(edge.to.port)) ports.set(edge.to.port, edge.from.node);
  }
  return out;
}

/** How many distinct edges leave each node. */
function countConsumers(edges: Edge[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const edge of edges) {
    out.set(edge.from.node, (out.get(edge.from.node) ?? 0) + 1);
  }
  return out;
}
