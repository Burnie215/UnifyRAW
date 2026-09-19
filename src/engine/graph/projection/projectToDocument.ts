/**
 * Step 2 of the single-source-of-truth plan, the public entry point: turn a
 * graph back into the document the classic view owns. Pure — no GL, no
 * registry, no React.
 *
 * Everything before this file answers one question each:
 *   - [shapeScan.ts](./shapeScan.ts)          is the graph a source, a base
 *                                             chain and a compositor cascade?
 *   - [chainRules.ts](./chainRules.ts)        are the nodes inside the chains
 *                                             ones the classic view has?
 *   - [paramsToAdjustments.ts](./paramsToAdjustments.ts)
 *                                             what do their params say in
 *                                             editor units?
 *
 * This file assembles the answers into a `PhotoDocument`: base adjustments,
 * document-level transform and effects, one `DocLayer` per compositor with
 * opacity, blend mode, mask and preset identity — or the list of nodes that
 * stand in the way, each with the reason the user gets to read.
 *
 * ## Why there is a third argument
 *
 * The plan writes the function as `projectToDocument(graph, source)`. A graph
 * does not carry everything a document holds, though, and the difference is
 * not cosmetic:
 *
 *   - mask SHAPES (`MaskDefinition`: brush strokes, gradient geometry). The
 *     graph has a `rasterizedMaskSource` node whose texture the caller binds
 *     from the document; the strokes are nowhere in it.
 *   - layer names, ids, `locked`, and layers the graph never depicts —
 *     hidden ones, ones at zero opacity, image and text layers. The forward
 *     path filters those out ([PhotoEditor.tsx:780](../../../components/PhotoEditor.tsx)),
 *     so a projection that only knew the graph would DELETE them.
 *   - adjustment fields no wrapped kind owns (`sharpenRadius`,
 *     `colorEditorMode`, the AI-denoise trio, `cropAspect`, …). Skin-tone
 *     uniformity is not among them: its three values live in HSLDetail params.
 *     The crop rectangle itself is carried by the terminal crop node.
 *
 * So the current document is passed in and everything the graph cannot speak
 * about is carried over from it. It decides representation, never values: a
 * field the graph does describe is always taken from the graph, and a node
 * deleted in the graph resets its field to the default. Where graph and
 * document agree, the document's own spelling is kept — that is what makes
 * `document → graph → document` byte-identical instead of merely equivalent
 * (a sparse `{}` layer must not come back as forty explicit defaults).
 *
 * Without the argument the function still works and returns a document built
 * from defaults; that path is what the round-trip tests use to prove the
 * values are read from the graph and not copied out of the previous document.
 * Because that graph carries no provenance for the three classic custom-HSL
 * lists, its non-default sectors are represented as deterministic Advanced
 * sectors while the document-wide default skin sector stays at its default.
 */
import type { RenderGraph } from '../types';
import type { BuilderAdjustments, BuilderSourceSpec } from '../DefaultGraphBuilder';
import { adjustmentsToBuilderAdjustments, spotsFromRetouchParams } from '../DefaultGraphBuilder';
import { KIND_RETOUCH, type CustomHslSector } from '../passKinds';
import { BLEND_MODE_NAMES, type BlendMode as CompositorBlendMode } from '../compositorKinds';
import type { Adjustments } from '../../../types';
import { defaultAdjustments } from '../../../types';
import {
  DOCUMENT_LEVEL_FIELDS,
  DOCUMENT_VERSION,
  TRANSFORM_FIELDS,
  documentToAdjustments,
  type DocFinalEffects,
  type DocLayer,
  type DocTransform,
  type PhotoDocument,
} from '../../DocumentModel';
import { layerAdjustmentsForRendering } from '../../PresetLayer';
import type { ColorEditorSector } from '../../../types';
import { scanGraphShape, type BlockedNode, type GraphShape, type ScannedLayer } from './shapeScan';
import { blockReasonId, type BlockReason } from './blockReasons';
import { checkChainRules } from './chainRules';
import { deepEqual, paramsToAdjustments, type ProjectedParams } from './paramsToAdjustments';
import { persistedCropRect } from '../../Crop';

export type ProjectToDocumentResult =
  | { ok: true; document: PhotoDocument }
  | { ok: false; blocked: BlockedNode[] };

/** The findings this file raises itself, by key. The structural, chain and
 *  parameter reasons live next to the rule that finds them; the sentences for
 *  all of them live in the locale files. */
export const DOCUMENT_REASONS = {
  /**
   * A mask input with no mask shape to go with it. Only reachable by hand:
   * the forward path emits the mask source node exactly when the layer has a
   * `MaskDefinition`, so a document-less mask means someone wired one in the
   * graph. Brush strokes cannot be invented from a texture slot.
   */
  maskWithoutShape: { key: 'document.maskWithoutShape' },
  /**
   * INVERSION LOSS #2 made concrete. Going forward, `advancedSectors`,
   * `skinToneSectors` and `skinToneSector` are concatenated into one list,
   * and the node keeps only the six shader fields plus activation per sector.
   * As long as the list still has the length the previous document's three
   * lists add up to,
   * each sector goes back where it came from. A sector added or removed
   * inside a graph that still has that document leaves no way to say which
   * of the three lists it belongs to — and guessing would silently move the
   * user's color ranges between the Color-Editor tabs. With no previous
   * document at all, Advanced is the documented deterministic fallback.
   */
  customHslSplit: { key: 'document.customHslSplit' },
} as const satisfies Record<string, BlockReason>;

/**
 * The `Adjustments` fields the graph speaks for. Exactly the keys
 * `adjustmentsToBuilderAdjustments` reads — the vocabulary that survives the
 * trip into node params and back. For these, absence in the projection means
 * "identity", so they are reset to the default; everything else is carried
 * over from the previous document untouched, because the graph has nothing
 * to say about it.
 *
 * The custom-HSL fields and skin-tone uniformity are handled apart: the three
 * sector fields map to ONE builder field (`customHslSectors`), while
 * uniformity is derived into `hslSkinTone`.
 *
 * A test proves the list is complete and minimal by probing
 * `adjustmentsToBuilderAdjustments` field by field, rather than trusting that
 * this copy stayed in sync.
 */
export const BUILDER_OWNED_ADJUSTMENT_FIELDS: readonly (keyof Adjustments)[] = [
  'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks',
  'temperature', 'tint', 'vibrance', 'saturation',
  'clarity', 'dehaze', 'texture',
  'sharpness', 'noiseReduction', 'denoiseLuma', 'denoiseChroma', 'denoiseDetail',
  'toneCurve', 'levels', 'hsl', 'colorGrading', 'bwEnabled', 'bwMix',
  'advancedSectors', 'skinToneSectors', 'skinToneSector', 'skinToneUniformity',
  'vignette', 'vignetteFeather', 'grain', 'grainSize',
  'lensCorrection', 'lensCorrectionProfile', 'lensCorrectionStrength',
  'rotation', 'perspectiveH', 'perspectiveV', 'distortion', 'flipH', 'flipV',
  'toneCurveSpace', 'colorGradingSpace', 'hslSpace',
];

/** Fields whose builder spelling differs from their document spelling. */
const DERIVED_HSL_FIELDS: ReadonlySet<string> = new Set([
  'advancedSectors', 'skinToneSectors', 'skinToneSector', 'skinToneUniformity',
]);

/**
 * The document a projection without a previous one is measured against.
 * Written out instead of `createDocument()` because that mints a layer id
 * with `crypto.randomUUID()`, which is neither pure nor available in every
 * context this code runs in.
 */
const EMPTY_DOCUMENT: PhotoDocument = {
  version: DOCUMENT_VERSION,
  layers: [{
    id: 'base',
    name: 'Entwicklung',
    type: 'base',
    visible: true,
    opacity: 1,
    blendMode: 'normal',
    locked: false,
    adjustments: {},
    mask: null,
  }],
  transform: {
    rotation: defaultAdjustments.rotation,
    flipH: defaultAdjustments.flipH,
    flipV: defaultAdjustments.flipV,
    cropAspect: defaultAdjustments.cropAspect,
    perspectiveV: defaultAdjustments.perspectiveV,
    perspectiveH: defaultAdjustments.perspectiveH,
    distortion: defaultAdjustments.distortion,
  },
  finalEffects: {
    vignette: defaultAdjustments.vignette,
    vignetteFeather: defaultAdjustments.vignetteFeather,
    grain: defaultAdjustments.grain,
    grainSize: defaultAdjustments.grainSize,
  },
};

/**
 * Graph → document. `{ ok: true, document }` or `{ ok: false, blocked }` with
 * every node that stands in the way and why.
 *
 * `source` has to be the spec the graph was built for — it decides the chain
 * the graph is measured against (a raw source runs WhiteBalanceRaw and
 * ColorMatrix and drops the SDR white balance node).
 */
export function projectToDocument(
  graph: RenderGraph,
  source: BuilderSourceSpec,
  previous?: PhotoDocument,
): ProjectToDocumentResult {
  const scan = scanGraphShape(graph);
  // Without a shape there is nothing to read params from — the later rules
  // all take the shape as their input, so this one finding stands alone.
  if (!scan.ok) return { ok: false, blocked: scan.blocked };

  const blocked: BlockedNode[] = [];
  const add = (nodeId: string, reason: BlockReason) => {
    const id = blockReasonId(reason);
    if (!blocked.some((b) => b.nodeId === nodeId && blockReasonId(b.reason) === id)) {
      blocked.push({ nodeId, reason });
    }
  };
  const addAll = (found: BlockedNode[]) => { for (const b of found) add(b.nodeId, b.reason); };

  // Chain rules and parameter rules are independent, so both run and the
  // user sees the full list rather than one finding per attempt.
  addAll(checkChainRules(graph, scan.shape, source));
  const params = paramsToAdjustments(graph, scan.shape, source);
  if (!params.ok) {
    addAll(params.blocked);
    return { ok: false, blocked };
  }

  const document = assembleDocument(
    graph,
    scan.shape,
    params.projected,
    previous ?? EMPTY_DOCUMENT,
    previous !== undefined,
    add,
  );
  if (blocked.length > 0) return { ok: false, blocked };
  return { ok: true, document };
}

/** One node with everything that stands in the way of it, in the order the
 *  rules found them. */
export interface BlockedNodeGroup {
  nodeId: string;
  reasons: BlockReason[];
}

/**
 * Group findings by node for the "what is in the way" list.
 *
 * A single node can carry several: a duplicate inserted far down the chain is
 * a duplicate AND an order violation, and a hand-built branch can break the
 * shape and the parameters at once. Listing the node once per finding would
 * make the same node look like several problems, so the list asks for it
 * grouped — while the halo in the graph still gets every reason for its
 * tooltip.
 */
export function groupBlockedByNode(blocked: readonly BlockedNode[]): BlockedNodeGroup[] {
  const byNode = new Map<string, BlockReason[]>();
  for (const { nodeId, reason } of blocked) {
    const reasons = byNode.get(nodeId);
    if (reasons) {
      const id = blockReasonId(reason);
      if (!reasons.some((r) => blockReasonId(r) === id)) reasons.push(reason);
    } else {
      byNode.set(nodeId, [reason]);
    }
  }
  return [...byNode].map(([nodeId, reasons]) => ({ nodeId, reasons }));
}

// ─── Assembly ─────────────────────────────────────────────────────

function assembleDocument(
  graph: RenderGraph,
  shape: GraphShape,
  projected: ProjectedParams,
  previous: PhotoDocument,
  hasPreviousDocument: boolean,
  add: (nodeId: string, reason: BlockReason) => void,
): PhotoDocument {
  const previousBase = previous.layers.find((l) => l.type === 'base');
  // What the forward path saw when it built the graph from this document —
  // the yardstick for "did the graph change this field at all".
  const previousBaseBuilder = adjustmentsToBuilderAdjustments(documentToAdjustments(previous));

  const baseLayer: DocLayer = {
    ...(previousBase ?? EMPTY_DOCUMENT.layers[0]),
    type: 'base',
    adjustments: writeAdjustments({
      stored: previousBase?.adjustments ?? {},
      previousBuilder: previousBaseBuilder,
      projectedBuilder: projected.base,
      // Document-level truth lives in `transform` / `finalEffects` below.
      // The base layer's copies are ignored by `documentToAdjustments`
      // anyway; they are left exactly as they were rather than stripped, so
      // a projection never silently rewrites a field it does not own.
      skip: DOCUMENT_LEVEL_FIELDS,
      // A missing field means the classic default here: the base chain
      // describes the whole picture, so a deleted node is identity.
      fallbackToDefault: true,
      hasPreviousDocument,
      nodeIdForBlame: shape.base.terminalId,
      add,
    }),
  };

  const layers = assembleLayers(
    graph, shape, projected, previous, previousBaseBuilder, hasPreviousDocument, add,
  );

  return withRetouch({
    // Spread first so fields this projection has no opinion about survive —
    // `pipelineGraph` above all. Whether a document keeps its graph is the
    // mode flag's business (step 3), not the projection's.
    ...previous,
    version: DOCUMENT_VERSION,
    layers: [baseLayer, ...layers],
    transform: documentTransform(projected.base, previous.transform),
    finalEffects: documentEffects(projected.base, previous.finalEffects),
  }, graph, shape, previous);
}

/**
 * The retouch spots the graph carries, written back onto the document — the
 * document-wide counterpart of `transform` and `finalEffects`.
 *
 * Read from the BASE chain: a layered graph splices the same node into every
 * branch, and the base chain is the one that speaks for the document. A graph
 * without the node means the user deleted it, so the field goes away entirely
 * rather than staying at `[]` — an empty list is not the same document as no
 * list, and the export filename would move for a spot nobody has.
 */
function withRetouch(
  doc: PhotoDocument,
  graph: RenderGraph,
  shape: GraphShape,
  previous: PhotoDocument,
): PhotoDocument {
  const node = shape.base.nodeIds
    .map((id) => graph.nodes.get(id))
    .find((n) => n?.kind === KIND_RETOUCH);
  if (!node) {
    if (doc.retouch === undefined) return doc;
    const { retouch: _gone, ...rest } = doc;
    return rest as PhotoDocument;
  }
  return { ...doc, retouch: spotsFromRetouchParams(node.params, previous.retouch) };
}

/**
 * Transform is document-level, and the plan's rule is that every branch
 * carries the SAME transform — the base chain therefore speaks for the whole
 * document (a branch that disagrees has already blocked in
 * `checkSharedGeometry`). `cropAspect` is UI intent and is carried over; the
 * terminal crop node supplies the actual rectangle.
 */
function documentTransform(base: BuilderAdjustments, previous: DocTransform): DocTransform {
  const transform: DocTransform = {
    rotation: numberOr(base.rotation, defaultAdjustments.rotation),
    flipH: boolOr(base.flipH, defaultAdjustments.flipH),
    flipV: boolOr(base.flipV, defaultAdjustments.flipV),
    cropAspect: previous.cropAspect,
    perspectiveV: numberOr(base.perspectiveV, defaultAdjustments.perspectiveV),
    perspectiveH: numberOr(base.perspectiveH, defaultAdjustments.perspectiveH),
    distortion: numberOr(base.distortion, defaultAdjustments.distortion),
  };
  const crop = persistedCropRect(base.crop);
  if (crop) transform.crop = crop;
  return transform;
}

/** Same for the final effects. The sky-replacement fields have no node and
 *  are carried over unchanged. */
function documentEffects(base: BuilderAdjustments, previous: DocFinalEffects): DocFinalEffects {
  return {
    ...previous,
    vignette: numberOr(base.vignette, defaultAdjustments.vignette),
    vignetteFeather: numberOr(base.vignetteFeather, defaultAdjustments.vignetteFeather),
    grain: numberOr(base.grain, defaultAdjustments.grain),
    grainSize: numberOr(base.grainSize, defaultAdjustments.grainSize),
  };
}

function assembleLayers(
  graph: RenderGraph,
  shape: GraphShape,
  projected: ProjectedParams,
  previous: PhotoDocument,
  previousBaseBuilder: BuilderAdjustments,
  hasPreviousDocument: boolean,
  add: (nodeId: string, reason: BlockReason) => void,
): DocLayer[] {
  // The layers the forward path would depict, in document order — the list
  // the cascade is matched against. Same filter as `PhotoEditor.graphLayers`
  // and `useRenderPipeline.renderDoc`.
  const depictable = previous.layers.filter(
    (l) => l.visible && l.type === 'adjustment' && l.opacity > 0,
  );
  const claimed = new Set<string>();

  const built: DocLayer[] = shape.layers.map((scanned, index) => {
    const match = matchPreviousLayer(scanned, depictable, index, claimed);
    if (match) claimed.add(match.id);
    return buildLayer(
      graph,
      scanned,
      projected.layers[index],
      match,
      previousBaseBuilder,
      hasPreviousDocument,
      add,
    );
  });

  return spliceUndepicted(built, previous.layers, claimed);
}

/**
 * Which document layer a compositor stands for. The node id carries it
 * (`comp:<layerId>`), but only as a hint: a user may rename nodes, and the
 * plan says renaming is not semantics. So the id is tried first, and the
 * position in the cascade decides when it leads nowhere — the cascade order
 * IS the layer order, which is what `shapeScan` guarantees.
 */
function matchPreviousLayer(
  scanned: ScannedLayer,
  depictable: DocLayer[],
  index: number,
  claimed: Set<string>,
): DocLayer | null {
  const fromId = scanned.compositorId.startsWith('comp:')
    ? scanned.compositorId.slice('comp:'.length)
    : null;
  const byId = fromId ? depictable.find((l) => l.id === fromId && !claimed.has(l.id)) : undefined;
  if (byId) return byId;
  const byPosition = depictable[index];
  return byPosition && !claimed.has(byPosition.id) ? byPosition : null;
}

function buildLayer(
  graph: RenderGraph,
  scanned: ScannedLayer,
  projected: ProjectedParams['layers'][number] | undefined,
  previous: DocLayer | null,
  previousBaseBuilder: BuilderAdjustments,
  hasPreviousDocument: boolean,
  add: (nodeId: string, reason: BlockReason) => void,
): DocLayer {
  const compositor = graph.nodes.get(scanned.compositorId);
  const p = (compositor?.params && typeof compositor.params === 'object')
    ? compositor.params as Record<string, unknown>
    : {};

  // The preset marker travels in the compositor params (decision of
  // 2026-09-03), so a projected preset layer keeps its identity and the next
  // preset REPLACES it instead of stacking a second look on top.
  const presetSyncId = typeof p.presetSyncId === 'string' && p.presetSyncId.length > 0
    ? p.presetSyncId
    : undefined;

  // The shader ignores the mask input unless `useMask` says so, so both have
  // to agree before the layer counts as masked.
  const masked = scanned.maskNodeId !== null && p.useMask !== false;
  let mask = previous?.mask ?? null;
  if (masked && !mask) {
    add(scanned.maskNodeId ?? scanned.compositorId, DOCUMENT_REASONS.maskWithoutShape);
  } else if (!masked) {
    mask = null;
  }

  const previousBuilder = previous
    ? adjustmentsToBuilderAdjustments(layerAdjustmentsForRendering(previous))
    : {};

  const layer: DocLayer = {
    // A compositor with no document layer behind it is one the user added in
    // the graph. Its id comes from the node so the result stays pure and the
    // same graph always projects to the same document.
    id: previous?.id ?? scanned.compositorId,
    name: previous?.name ?? 'Anpassung',
    type: 'adjustment',
    visible: true,
    opacity: clamp01(numberOr(p.opacity as number | undefined, 1)),
    blendMode: readBlendMode(p.blendMode),
    locked: previous?.locked ?? false,
    adjustments: writeAdjustments({
      stored: previous?.adjustments ?? {},
      previousBuilder,
      projectedBuilder: projected?.delta ?? {},
      // Mirrors `layerAdjustmentsForRendering`: a preset layer keeps its own
      // look effects (grain, vignette) so the Amount slider can fade them,
      // an ordinary layer keeps neither those nor the transform. Whatever is
      // stripped there is invisible to the graph, so the projection must not
      // write it — and must not delete what the document already holds.
      skip: presetSyncId ? new Set<string>(TRANSFORM_FIELDS) : DOCUMENT_LEVEL_FIELDS,
      // A layer's adjustments are a sparse delta: no entry means no override,
      // which is not the same as "the default".
      fallbackToDefault: false,
      baseBuilder: previousBaseBuilder,
      hasPreviousDocument,
      nodeIdForBlame: scanned.compositorId,
      add,
    }),
    mask,
  };
  if (presetSyncId) layer.presetSyncId = presetSyncId;
  return layer;
}

/**
 * Put the layers the graph never depicted back where they were. Hidden
 * layers, layers at zero opacity and image/text layers are filtered out
 * before the graph is built, so the cascade cannot mention them — dropping
 * them would delete the user's work on a mere mode switch.
 *
 * Each of them keeps its neighbour: it goes back directly above the nearest
 * layer below it that the graph DID depict, and several in a row keep their
 * order among themselves. That is the strongest statement the graph allows,
 * since the depicted layers may have been reordered in the cascade.
 */
function spliceUndepicted(
  built: DocLayer[],
  previousLayers: DocLayer[],
  claimed: Set<string>,
): DocLayer[] {
  const out = [...built];
  const insertedPerAnchor = new Map<string, number>();
  let anchor: string | null = null;

  for (const layer of previousLayers) {
    if (layer.type === 'base') continue;
    if (claimed.has(layer.id)) { anchor = layer.id; continue; }

    const key = anchor ?? '';
    const already = insertedPerAnchor.get(key) ?? 0;
    const anchorIndex = anchor === null ? -1 : out.findIndex((l) => l.id === anchor);
    out.splice(anchorIndex + 1 + already, 0, layer);
    insertedPerAnchor.set(key, already + 1);
  }
  return out;
}

// ─── Field-by-field write-back ────────────────────────────────────

interface WriteArgs {
  /** The layer's stored adjustments as the document holds them today. */
  stored: Partial<Adjustments>;
  /** What the forward path made of `stored` — the yardstick for "unchanged". */
  previousBuilder: BuilderAdjustments;
  /** What the graph says now. */
  projectedBuilder: BuilderAdjustments;
  /** Fields this caller does not own; left exactly as stored. */
  skip: ReadonlySet<string>;
  /** Does a missing field mean "the default" (base) or "no override" (layer)? */
  fallbackToDefault: boolean;
  /** Whether the caller supplied the document whose three sector lists define the split. */
  hasPreviousDocument: boolean;
  /** Layers only: the base the layer was merged onto when the graph was built. */
  baseBuilder?: BuilderAdjustments;
  nodeIdForBlame: string;
  add: (nodeId: string, reason: BlockReason) => void;
}

/**
 * Write the graph's answer into one layer's adjustments.
 *
 * The rule per field is: if the graph says what the document already said,
 * the stored spelling stays — present or absent, sparse or explicit. Only a
 * field the graph says DIFFERENTLY is written, and a field the graph no
 * longer carries at all (its node was deleted) is removed, which is the
 * classic view's way of spelling identity.
 *
 * That is what keeps `document → graph → document` byte-identical: an
 * untouched graph produces no writes at all. It also means the function
 * decides representation and never values — the values are the projection's.
 */
function writeAdjustments(args: WriteArgs): Partial<Adjustments> {
  const { stored, previousBuilder, projectedBuilder, skip, fallbackToDefault } = args;
  const out: Record<string, unknown> = { ...stored };
  const previous = previousBuilder as Record<string, unknown>;
  const projectedRecord = projectedBuilder as Record<string, unknown>;

  for (const field of BUILDER_OWNED_ADJUSTMENT_FIELDS) {
    if (skip.has(field)) continue;
    if (DERIVED_HSL_FIELDS.has(field)) continue;

    const now = projectedRecord[field];
    if (deepEqual(now, previous[field])) continue;
    if (now === undefined) {
      delete out[field];
      continue;
    }
    out[field] = now;
  }

  writeCustomHslSectors(out, previousBuilder, projectedBuilder, fallbackToDefault, args);
  writeSkinToneUniformity(out, previousBuilder, projectedBuilder, args);
  return out as Partial<Adjustments>;
}

/** `hslSkinTone` also carries a reference point derived from the sector. The
 * sector write-back above owns that shape; only the three uniformity values
 * have an independent document representation. */
function writeSkinToneUniformity(
  out: Record<string, unknown>,
  previousBuilder: BuilderAdjustments,
  projectedBuilder: BuilderAdjustments,
  args: WriteArgs,
): void {
  const previousSource = args.baseBuilder
    ? forwardDeltaSkinTone(previousBuilder, args.baseBuilder)
    : previousBuilder;
  const before = uniformityFrom(previousSource.hslSkinTone);
  const now = uniformityFrom(projectedBuilder.hslSkinTone);
  const beforePresent = hasOwn(previousSource, 'hslSkinTone');
  const nowPresent = hasOwn(projectedBuilder, 'hslSkinTone');
  if (deepEqual(now, before) && (!args.baseBuilder || beforePresent === nowPresent)) return;
  if (args.baseBuilder && nowPresent && !now) {
    out.skinToneUniformity = { hue: 0, saturation: 0, luminance: 0 };
    return;
  }
  if (!now) {
    delete out.skinToneUniformity;
    return;
  }
  out.skinToneUniformity = now;
}

function uniformityFrom(
  params: BuilderAdjustments['hslSkinTone'],
): Adjustments['skinToneUniformity'] | undefined {
  if (!params || (params.uniHue === 0 && params.uniSat === 0 && params.uniLum === 0)) {
    return undefined;
  }
  return {
    hue: params.uniHue * 100,
    saturation: params.uniSat * 100,
    luminance: params.uniLum * 100,
  };
}

function forwardDeltaSkinTone(
  layer: BuilderAdjustments,
  base: BuilderAdjustments,
): BuilderAdjustments {
  if (!hasOwn(layer, 'hslSkinTone')) return {};
  const own = layer.hslSkinTone;
  return deepEqual(own, base.hslSkinTone) ? {} : { hslSkinTone: own };
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * The one field that is three fields. See `DOCUMENT_REASONS.customHslSplit`
 * for why the split cannot be recomputed and has to be recognised.
 */
function writeCustomHslSectors(
  out: Record<string, unknown>,
  previousBuilder: BuilderAdjustments,
  projectedBuilder: BuilderAdjustments,
  fallbackToDefault: boolean,
  args: WriteArgs,
): void {
  const now = projectedBuilder.customHslSectors;
  // A layer reaches the graph as a delta against the base, and ranges equal
  // to the base's leave none (every preset layer stores the default skin-tone
  // sector). "Unchanged" is therefore measured against the delta the forward
  // path made of the stored layer, not against the layer itself.
  const before = args.baseBuilder
    ? forwardDeltaSectors(previousBuilder, args.baseBuilder)
    : previousBuilder.customHslSectors;
  if (sameCustomHslSectors(now, before)) return;

  const advanced = asSectorArray(out.advancedSectors);
  const skinList = asSectorArray(out.skinToneSectors);
  const skinSingle = asSector(out.skinToneSector)
    ?? (fallbackToDefault ? defaultAdjustments.skinToneSector : null);
  const storedCount = advanced.length + skinList.length + (skinSingle ? 1 : 0);
  const projectedSectors = now ?? [];

  // A graph imported without its document has no evidence for the original
  // advanced/skin-list/skin-single split. The public API still supports that
  // path deliberately, so choose the one lossless, deterministic classic
  // representation available: graph-authored ranges become advanced ranges.
  // The builder's canonical default skin range is recognised and left as the
  // document-wide default instead of being duplicated in Advanced. Fields the
  // graph never carried get stable neutral values; all shader-visible fields
  // remain exactly the graph's values.
  if (!args.hasPreviousDocument) {
    const customSectors = withoutDefaultSkinTone(projectedSectors);
    if (customSectors.length > 0) {
      out.advancedSectors = customSectors.map((sector, index) =>
        freshAdvancedSector(sector, args.nodeIdForBlame, index));
    } else {
      delete out.advancedSectors;
    }
    delete out.skinToneSectors;
    delete out.skinToneSector;
    return;
  }

  if (projectedSectors.length !== storedCount) {
    args.add(args.nodeIdForBlame, DOCUMENT_REASONS.customHslSplit);
    return;
  }

  // Same length, so the concatenation is still readable position by
  // position. The six shader fields and activation come from the graph;
  // everything else (id, saturation range, picker state) comes from the
  // sector that was there — the node never saw those fields.
  let cursor = 0;
  const take = (stored: ColorEditorSector): ColorEditorSector => {
    const projected = projectedSectors[cursor++];
    const sector = { ...stored, ...projected };
    // Old documents may predate the activation field. Missing and true have
    // the same graph meaning, so an unrelated graph edit must not make that
    // legacy spelling explicit. A stored false still becomes explicit true
    // when the graph removes the flag, because that is a semantic edit.
    if (!hasOwn(stored, 'enabled') && projected.enabled === true) {
      delete (sector as Partial<ColorEditorSector>).enabled;
    }
    return sector;
  };
  const rebuilt = {
    advancedSectors: advanced.map(take),
    skinToneSectors: skinList.map(take),
    skinToneSector: skinSingle ? take(skinSingle) : null,
  };

  // The semantic comparison above catches unchanged render state even though
  // the node strips the editor-only fields. Once a render field did move,
  // rebuild and compare the three stored lists: a field the document did not
  // spell out stays unspelled.
  assignIfChanged(out, 'advancedSectors', rebuilt.advancedSectors,
    fallbackToDefault ? defaultAdjustments.advancedSectors : undefined);
  assignIfChanged(out, 'skinToneSectors', rebuilt.skinToneSectors,
    fallbackToDefault ? defaultAdjustments.skinToneSectors : undefined);
  if (rebuilt.skinToneSector) {
    assignIfChanged(out, 'skinToneSector', rebuilt.skinToneSector,
      fallbackToDefault ? defaultAdjustments.skinToneSector : undefined);
  }
}

/** Remove the one sector the forward path always appends for the document's
 * default skin tone. It is zero-effect and remains represented by the
 * document default; every other graph sector is user-authored and belongs in
 * the deterministic Advanced fallback. */
function withoutDefaultSkinTone(sectors: readonly CustomHslSector[]): CustomHslSector[] {
  let defaultIndex = -1;
  for (let index = sectors.length - 1; index >= 0; index -= 1) {
    if (isDefaultSkinTone(sectors[index])) {
      defaultIndex = index;
      break;
    }
  }
  return defaultIndex < 0
    ? [...sectors]
    : sectors.filter((_sector, index) => index !== defaultIndex);
}

function isDefaultSkinTone(sector: CustomHslSector): boolean {
  const standard = defaultAdjustments.skinToneSector;
  return sector.hueCenter === standard.hueCenter
    && sector.hueHalfWidth === standard.hueHalfWidth
    && sector.feather === standard.feather
    && sector.dH === standard.dH
    && sector.dS === standard.dS
    && sector.dL === standard.dL
    && sector.enabled !== false;
}

/** Fill the editor-only sector metadata that a graph does not store. The id
 * is scoped to the owning chain so repeated projections of the same graph are
 * byte-identical without randomness. */
function freshAdvancedSector(
  sector: CustomHslSector,
  ownerId: string,
  index: number,
): ColorEditorSector {
  return {
    id: `graph:${ownerId}:custom-hsl:${index}`,
    hueCenter: sector.hueCenter,
    hueHalfWidth: sector.hueHalfWidth,
    satMin: 0,
    satMax: 100,
    feather: sector.feather,
    pickRelHue: 0.5,
    pickRelSat: 0.5,
    selLightness: 0,
    dH: sector.dH,
    dS: sector.dS,
    dL: sector.dL,
    enabled: sector.enabled !== false,
  };
}

/** Compare exactly what the CustomHSL node renders. Editor-only metadata is
 * absent from graph params, and its optional enabled flag defaults to true. */
function sameCustomHslSectors(
  left: readonly CustomHslSector[] | undefined,
  right: readonly CustomHslSector[] | undefined,
): boolean {
  const a = left ?? [];
  const b = right ?? [];
  if (a.length !== b.length) return false;
  return a.every((sector, index) => {
    const other = b[index];
    return sector.hueCenter === other.hueCenter
      && sector.hueHalfWidth === other.hueHalfWidth
      && sector.feather === other.feather
      && sector.dH === other.dH
      && sector.dS === other.dS
      && sector.dL === other.dL
      && (sector.enabled !== false) === (other.enabled !== false);
  });
}

/** What `mergeAdjustments` + `layerDeltaFromMerged` make of a layer's color
 *  ranges: lists override, so the layer's own list survives only where it
 *  differs from the base's. */
function forwardDeltaSectors(layer: BuilderAdjustments, base: BuilderAdjustments): BuilderAdjustments['customHslSectors'] {
  const own = layer.customHslSectors;
  return own === undefined || sameCustomHslSectors(own, base.customHslSectors) ? undefined : own;
}

/** Write `value` only when it says something the object does not say
 *  already — `absentMeans` is what leaving the field out would mean. */
function assignIfChanged(
  out: Record<string, unknown>,
  field: string,
  value: unknown,
  absentMeans: unknown,
): void {
  const current = field in out ? out[field] : absentMeans;
  if (deepEqual(value, current)) return;
  out[field] = value;
}

// ─── Small readers ────────────────────────────────────────────────

function asSectorArray(value: unknown): ColorEditorSector[] {
  return Array.isArray(value) ? value as ColorEditorSector[] : [];
}

function asSector(value: unknown): ColorEditorSector | null {
  return (value && typeof value === 'object' && !Array.isArray(value))
    ? value as ColorEditorSector
    : null;
}

function numberOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function boolOr(value: boolean | undefined, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** The compositor's schema defaults an unreadable blend mode to `normal`;
 *  the projection says the same rather than inventing a mode. */
function readBlendMode(value: unknown): CompositorBlendMode {
  return BLEND_MODE_NAMES.includes(value as CompositorBlendMode)
    ? value as CompositorBlendMode
    : 'normal';
}
