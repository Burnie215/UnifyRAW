/**
 * Step 2 of the single-source-of-truth plan, second half of the missing
 * direction: are the nodes INSIDE a recognised chain admissible for the
 * classic view? Pure — no GL, no registry, no React.
 *
 * The shape scan ([shapeScan.ts](./shapeScan.ts)) has already decided that the
 * graph is a source, a base chain, and one chain per layer. This module judges
 * the contents of those chains against the three chain rules from the plan:
 *
 *   1. a kind the classic view has no node for at all,
 *   2. a chain whose order deviates from the fixed classic order,
 *   3. the same kind more than once in one chain.
 *
 * All three are derived from `chainKindsForSource` — the builder's single
 * statement of what the classic pipeline runs, in which order, for this
 * source. Keeping a second list here would drift the moment a pass is added,
 * moved, or made source-dependent (raw16 puts WhiteBalanceRaw and ColorMatrix
 * in front and drops the SDR WhiteBalance node), so the list is asked for,
 * never restated.
 *
 * With a camera profile the chain runs some kinds twice: once in the
 * profile's base stage (`base:<kind>`) and once for the edits. Order and
 * duplicates are therefore judged per step - stage and kind together, as
 * `chainStepsForSource` lists them - so `base:tone` ahead of `default:tone`
 * is the classic chain, not a duplicate. A base node of a kind the profile
 * never occupies has no place in that list and says so.
 *
 * Explicitly NOT blocking, and covered by tests:
 *   - a deleted chain node — a missing node is identity parameters, which the
 *     compiler skips anyway (`identitySkips`); same picture,
 *   - changed node positions — layout is not semantics,
 *   - nodes outside every chain — they do not reach the output, so they
 *     cannot change the picture either.
 *
 * Every finding carries a reason meant for the person looking at a locked
 * button. Without one, marking a node is an accusation rather than an
 * explanation.
 */
import type { RenderGraph } from '../types';
import {
  chainKindsForSource,
  chainStepsForSource,
  retouchStepIndex,
  stageOfNodeId,
  type BuilderSourceSpec,
} from '../DefaultGraphBuilder';
import { KIND_CROP, KIND_RETOUCH } from '../passKinds';
import type { BlockedNode, GraphShape, ScannedChain } from './shapeScan';
import { blockReasonId, type BlockReason } from './blockReasons';
import { KIND_CUSTOM_LUT } from '../lutKinds';
import { KIND_PREVIEW } from '../previewKind';
import { KIND_TAP } from '../builtins';
import { KIND_MULTI_OUTPUT_ENCODER } from '../encoderKinds';
import { KIND_AB_SWAP, KIND_SIDE_BY_SIDE, KIND_DIFFERENCE } from '../compositorKinds';
import { KIND_EDGE_MASK, KIND_RANGE_MASK, KIND_MASK_COMBINATOR } from '../maskKinds';

/**
 * The graph-only kinds the plan names by hand. They are NOT what the check
 * consults — rule 1 asks `chainKindsForSource` and blocks everything the
 * classic chain does not contain, which covers these ten plus any kind added
 * later (a compiler-emitted convert node that somehow ended up in a stored
 * graph, a third-party kind). The list exists so the plan's enumeration is
 * traceable in code and so the tests can prove each of the ten blocks.
 */
export const KINDS_WITHOUT_CLASSIC_EQUIVALENT: readonly string[] = [
  KIND_CUSTOM_LUT,
  KIND_PREVIEW,
  KIND_TAP,
  KIND_MULTI_OUTPUT_ENCODER,
  KIND_AB_SWAP,
  KIND_SIDE_BY_SIDE,
  KIND_DIFFERENCE,
  KIND_EDGE_MASK,
  KIND_RANGE_MASK,
  KIND_MASK_COMBINATOR,
];

/**
 * The node name every editor surface shows. The node body, the inspector
 * header, the library row, the output rail and the blocking reasons all call
 * this one function, so a kind reads the same wherever it appears; four
 * private copies of it used to drift in two spellings (F094).
 */
export function nodeKindLabel(kind: string): string {
  return kind
    .replace(/^__/, '')
    .replace(/\./g, ' · ')
    .replace(/([A-Z])/g, ' $1')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

/**
 * The chain findings, by key. Every one of them names a node kind, and it
 * travels as the raw kind id: the surface runs it through `nodeKindLabel`
 * when it writes the sentence, so the spelling of a node stays in one place.
 * The sentences live in the locale files under `gate.reasons.chain.*`.
 */
export const CHAIN_REASONS = {
  /** Plan: "Knotenart ohne klassische Entsprechung". */
  noClassicEquivalent: (kind: string): BlockReason =>
    ({ key: 'chain.noClassicEquivalent', params: { kind } }),
  /** Plan: "Kettenreihenfolge weicht von chainForSource ab". `earlierKind`
   *  sits ahead of `laterKind` in the graph but behind it in the classic
   *  pipeline. */
  wrongOrder: (earlierKind: string, laterKind: string): BlockReason =>
    ({ key: 'chain.wrongOrder', params: { earlierKind, laterKind } }),
  /** Plan: "Dieselbe Knotenart zweimal in einer Kette". */
  duplicateKind: (kind: string): BlockReason =>
    ({ key: 'chain.duplicateKind', params: { kind } }),
  /** A `base:` node whose kind the camera profile does not run. */
  baseStageKind: (kind: string): BlockReason =>
    ({ key: 'chain.baseStageKind', params: { kind } }),
} as const;

/**
 * Judge the contents of every chain in `shape`. Returns one finding per
 * blocking node, empty when all chains are writable as a document.
 *
 * `source` decides which chain the graph is measured against, so it has to be
 * the same spec the graph was built for.
 */
export function checkChainRules(
  graph: RenderGraph,
  shape: GraphShape,
  source: BuilderSourceSpec,
): BlockedNode[] {
  // stage:kind -> its position in the classic pipeline. Absent = rule 1.
  // Every step occurs once, so a second node on the same key is rule 3.
  const positionOfStep = new Map<string, number>();
  classicSteps(source).forEach((step, index) => {
    positionOfStep.set(stepKey(step.stage, step.kind), index);
  });
  const classicKinds = new Set(chainKindsForSource(source));

  const found: BlockedNode[] = [];
  const add = (nodeId: string, reason: BlockReason) => {
    const id = blockReasonId(reason);
    if (!found.some((f) => f.nodeId === nodeId && blockReasonId(f.reason) === id)) {
      found.push({ nodeId, reason });
    }
  };

  checkOneChain(graph, shape.base, positionOfStep, classicKinds, add);
  for (const layer of shape.layers) {
    checkOneChain(graph, layer.chain, positionOfStep, classicKinds, add);
  }
  checkOneChain(
    graph,
    shape.post,
    new Map([[stepKey('user', KIND_CROP), 0]]),
    new Set([KIND_CROP]),
    add,
  );
  return found;
}

function stepKey(stage: 'base' | 'user', kind: string): string {
  return `${stage}:${kind}`;
}

/**
 * The builder's chain plus the retouch node, at the place `spliceRetouch`
 * puts it: behind the base stage, ahead of the user's first pass.
 *
 * It is not in the builder's own list because it is spliced in from the
 * document rather than built from the adjustments - but it is part of what
 * the classic view renders, and a rule that did not know it would report
 * "no classic equivalent" for every retouched photo and lock the document in
 * graph mode over an edit the classic view can express perfectly well (the
 * F011 pattern).
 */
function classicSteps(source: BuilderSourceSpec): Array<{ kind: string; stage: 'base' | 'user' }> {
  const steps: Array<{ kind: string; stage: 'base' | 'user' }> =
    chainStepsForSource(source).map((step) => ({ ...step }));
  steps.splice(retouchStepIndex(source), 0, { kind: KIND_RETOUCH, stage: 'user' });
  return steps;
}

function checkOneChain(
  graph: RenderGraph,
  chain: ScannedChain,
  positionOfStep: Map<string, number>,
  classicKinds: Set<string>,
  add: (nodeId: string, reason: BlockReason) => void,
): void {
  const seen = new Set<string>();
  let previous: { kind: string; position: number } | null = null;

  for (const nodeId of chain.nodeIds) {
    const node = graph.nodes.get(nodeId);
    if (!node) continue; // an id without a node cannot survive the shape scan

    const stage = stageOfNodeId(nodeId);
    const key = stepKey(stage, node.kind);
    const position = positionOfStep.get(key);
    if (position === undefined) {
      add(nodeId, stage === 'base' && classicKinds.has(node.kind)
        ? CHAIN_REASONS.baseStageKind(node.kind)
        : CHAIN_REASONS.noClassicEquivalent(node.kind));
      // No place in the classic order, so it can neither be out of order nor
      // a duplicate of something — and it must not shift the order cursor,
      // which would turn one unsupported node into a second complaint.
      continue;
    }

    if (seen.has(key)) add(nodeId, CHAIN_REASONS.duplicateKind(node.kind));
    seen.add(key);

    // Sortedness is exactly "every consecutive pair ascends", so comparing
    // against the previous node reports one finding per inversion rather than
    // smearing a single swap over the whole tail. The node behind the
    // inversion is the one marked; the reason names both ends, because either
    // of the two can be the one the user wants to move.
    if (previous && position < previous.position) {
      add(nodeId, CHAIN_REASONS.wrongOrder(previous.kind, node.kind));
    }
    previous = { kind: node.kind, position };
  }
}
