/**
 * PhotoDocument — the central data model for non-destructive editing.
 *
 * A document wraps an ordered stack of layers (base + adjustment layers),
 * document-level transform, and final effects. This replaces the flat
 * Adjustments object as the unit of persistence and undo/redo.
 *
 * The base layer (index 0) holds the full develop adjustments.
 * Adjustment layers hold partial overrides applied via mask + blend mode.
 *
 * Rendering: the current WebGL2 pipeline handles the flattened base layer.
 * Layer compositing (Phase 3c) will iterate layers and composite via blend modes.
 */

import type { Adjustments } from '../types';
import { defaultAdjustments } from '../types';
import type { MaskDefinition, SpotRemoval } from './Mask';
import type { CropRect } from './Crop';

// ─── Document ──────────────────────────────────────────────────

export const DOCUMENT_VERSION = 1;

export interface PhotoDocument {
  version: typeof DOCUMENT_VERSION;
  layers: DocLayer[];
  transform: DocTransform;
  finalEffects: DocFinalEffects;
  /**
   * Retouch discs, applied on the developed base image ahead of the user's
   * chain. Optional and omitted while empty: `isPhotoDocument` and every
   * document written before this existed stay valid, and a document without
   * retouch keeps producing byte-identical graphs and export filenames.
   *
   * A document field rather than editor state because that is the only place
   * the canvas, the thumbnail, the export, the sidecar, the sync and undo all
   * read from - the spots used to live in a `useState` inside the editor and
   * reached none of them (F009).
   */
  retouch?: SpotRemoval[];
  /** Phase 4: optional user-edited pipeline graph. When present, the
   *  graph-editor mode uses this instead of rebuilding from `layers` +
   *  `adjustments`. Stored as a JSON-safe serialized form (Maps flattened
   *  to plain objects) so it round-trips through document storage + sync. */
  pipelineGraph?: SerializedGraph;
  /**
   * Who owns this photo's truth. Absent means `'classic'`: adjustments and
   * layers lead and `documentGraph` derives a graph from them. In `'graph'`
   * mode, `documentGraph.isGraphLed` renders the stored `pipelineGraph` on
   * canvas, thumbnails and export. `graphPersistence.ts` sets and reads the
   * ownership mode, `chainRules.ts` decides whether the graph can return to
   * classic mode, and `editStackHash.ts` includes stored graph content.
   */
  pipelineMode?: 'classic' | 'graph';
  /**
   * Where the user arranged the graph's nodes, kept apart from the graph
   * itself so the layout survives a mode switch without the whole graph
   * having to be stored for it. Set only while the document does NOT carry a
   * `pipelineGraph` — see `documentAfterGraphChange`.
   */
  graphLayout?: Record<string, { x: number; y: number }>;
}

/**
 * What a document write takes. Use the updater form: a copy of a rendered
 * document drops whatever another write in the same tick put there.
 */
export type DocumentUpdate = PhotoDocument | ((prev: PhotoDocument) => PhotoDocument);

/** JSON-safe wire format for `RenderGraph`. The hook layer (de)hydrates
 *  to/from the live `RenderGraph` with its Map<id, RenderNode>. */
export interface SerializedGraph {
  id: string;
  nodes: SerializedNode[];
  edges: SerializedEdge[];
  output: string;
  metadata: {
    createdAt: number;
    updatedAt: number;
    revision: number;
    nodePositions?: Record<string, { x: number; y: number }>;
  };
}

export interface SerializedNode {
  id: string;
  kind: string;
  params: unknown;
}

export interface SerializedEdge {
  id: string;
  from: { node: string; port: string };
  to: { node: string; port: string };
}

// ─── Layers ────────────────────────────────────────────────────

export type DocLayerType = 'base' | 'adjustment' | 'image' | 'text';

export type BlendMode =
  | 'normal' | 'multiply' | 'screen' | 'overlay'
  | 'soft-light' | 'hard-light' | 'difference'
  | 'color' | 'luminosity' | 'darken' | 'lighten';

export const BLEND_MODES: { value: BlendMode; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'multiply', label: 'Multiplizieren' },
  { value: 'screen', label: 'Negativ Multiplizieren' },
  { value: 'overlay', label: 'Ineinanderkopieren' },
  { value: 'soft-light', label: 'Weiches Licht' },
  { value: 'hard-light', label: 'Hartes Licht' },
  { value: 'difference', label: 'Differenz' },
  { value: 'darken', label: 'Abdunkeln' },
  { value: 'lighten', label: 'Aufhellen' },
  { value: 'color', label: 'Farbe' },
  { value: 'luminosity', label: 'Luminanz' },
];

export interface DocLayer {
  id: string;
  name: string;
  type: DocLayerType;
  visible: boolean;
  opacity: number;        // 0-1
  blendMode: BlendMode;
  locked: boolean;
  adjustments: Partial<Adjustments>;
  mask: MaskDefinition | null;

  /** Present on the single, replaceable look layer created from a preset. */
  presetSyncId?: string;

  // Image layer
  imageBlob?: Blob;

  // Text layer
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  fontColor?: string;
  fontWeight?: string;
  position?: { x: number; y: number };
}

// ─── Document-level settings ───────────────────────────────────

export interface DocTransform {
  rotation: number;       // degrees
  flipH: boolean;
  flipV: boolean;
  cropAspect: string;
  /** Omitted means the complete frame, preserving every legacy document. */
  crop?: CropRect;
  perspectiveV: number;
  perspectiveH: number;
  distortion: number;
}

export interface DocFinalEffects {
  vignette: number;
  vignetteFeather: number;
  grain: number;
  grainSize: number;

  // Sky Replacement
  skyBlob?: Blob;
  skyOpacity?: number;         // 0-1, default 1
  skyEdgeFeather?: number;     // 0-100, default 15
  skyHorizonOffset?: number;   // -50..50, default 0
  skyFlip?: boolean;           // flip sky horizontally
}

// ─── Factory ───────────────────────────────────────────────────

/** Create a new empty document with a default base layer */
export function createDocument(): PhotoDocument {
  return {
    version: DOCUMENT_VERSION,
    layers: [createBaseLayer()],
    transform: { ...DEFAULT_TRANSFORM },
    finalEffects: { ...DEFAULT_EFFECTS },
  };
}

export function createBaseLayer(adjustments?: Partial<Adjustments>): DocLayer {
  return {
    id: crypto.randomUUID(),
    name: 'Entwicklung',
    type: 'base',
    visible: true,
    opacity: 1,
    blendMode: 'normal',
    locked: false,
    adjustments: adjustments ?? {},
    mask: null,
  };
}

export function createDocLayer(type: DocLayerType, name?: string): DocLayer {
  const names: Record<DocLayerType, string> = {
    base: 'Entwicklung',
    adjustment: 'Anpassung',
    image: 'Bild',
    text: 'Text',
  };
  return {
    id: crypto.randomUUID(),
    name: name ?? names[type],
    type,
    visible: true,
    opacity: 1,
    blendMode: 'normal',
    locked: false,
    adjustments: {},
    mask: null,
  };
}

// ─── Conversion: flat Adjustments ↔ PhotoDocument ──────────────

/** Fields that belong to document-level transform (not per-layer) */
export const TRANSFORM_FIELDS = [
  'rotation', 'flipH', 'flipV', 'cropAspect', 'perspectiveV', 'perspectiveH', 'distortion',
] as const;

/** Fields that belong to document-level final effects (not per-layer) */
export const EFFECTS_FIELDS = [
  'vignette', 'vignetteFeather', 'grain', 'grainSize',
] as const;

/** Union of fields that must never appear in a layer's per-layer adjustments
 *  — they live at the document level (transform / finalEffects). Layer paths
 *  must strip these before storing, otherwise LayerCompositor will re-apply
 *  e.g. flipH on each adjustment layer's pipeline pass, flipping the image
 *  once per layer (regression seen on 2026-05-17). */
export const DOCUMENT_LEVEL_FIELDS: ReadonlySet<string> = new Set<string>([
  ...TRANSFORM_FIELDS,
  ...EFFECTS_FIELDS,
]);

/** What a preset look layer leaves to the document: the geometry only. The
 *  final effects stay on the layer so its opacity blends the complete look. */
const PRESET_LAYER_DOCUMENT_FIELDS: ReadonlySet<string> = new Set<string>(TRANSFORM_FIELDS);

/**
 * The fields the DOCUMENT owns while a layer is selected - the ones that
 * layer's panels must read from and write back to the document, never to the
 * layer itself. One answer for both directions: a field the panel takes from
 * the document has to go back there, or the next render overwrites the edit.
 */
export function documentOwnedFields(presetSyncId?: string): ReadonlySet<string> {
  return presetSyncId ? PRESET_LAYER_DOCUMENT_FIELDS : DOCUMENT_LEVEL_FIELDS;
}

/**
 * What the panels show while `layer` is selected: the layer's own fields over
 * the defaults, and for the fields the document owns the document's REAL
 * values. Showing the defaults there made a document at vignette 40 read 0,
 * and every move of such a slider jumped back on the next render.
 */
export function panelAdjustmentsForLayer(
  layer: Pick<DocLayer, 'adjustments' | 'presetSyncId'>,
  current: Adjustments,
): Adjustments {
  const fromDocument: Partial<Adjustments> = {};
  for (const field of documentOwnedFields(layer.presetSyncId)) {
    const key = field as keyof Adjustments;
    (fromDocument as Record<string, unknown>)[key] = current[key];
  }
  return { ...defaultAdjustments, ...layer.adjustments, ...fromDocument } as Adjustments;
}

export interface PanelChangeSplit {
  /** What the selected adjustment layer stores: its non-default fields. */
  layerDelta: Partial<Adjustments>;
  /** The document write, or null when nothing document-level changed. */
  documentAdjustments: Adjustments | null;
}

/**
 * Split one panel edit made while an adjustment layer is selected.
 *
 * The panel shows the layer's own fields over defaults PLUS the document's
 * real values for the fields the document owns (`panelAdjustmentsForLayer`).
 * So the document write carries exactly those excluded fields whose value
 * differs from the document's own, merged onto what the document already
 * holds - handing the whole panel object to the document write put the
 * layer's values into the base layer and reset the geometry to the panel's
 * defaults instead.
 *
 * Comparing against the document rather than against the default is what
 * makes a reset expressible: with the panel showing 40 and the user dragging
 * to 0, "0 is the default" used to mean the write was dropped and the slider
 * sprang back.
 *
 * `excludedFields` is what the layer must not own - `documentOwnedFields`.
 */
export function splitPanelChange(
  panelAdjustments: Adjustments,
  current: Adjustments,
  excludedFields: ReadonlySet<string>,
): PanelChangeSplit {
  const layerDelta: Partial<Adjustments> = {};
  let documentPatch: Record<string, unknown> | null = null;
  for (const key of Object.keys(panelAdjustments) as (keyof Adjustments)[]) {
    const value = panelAdjustments[key];
    if (excludedFields.has(key)) {
      if (JSON.stringify(value) !== JSON.stringify(current[key])) (documentPatch ??= {})[key] = value;
      continue;
    }
    const isDefault = JSON.stringify(value) === JSON.stringify(defaultAdjustments[key]);
    if (!isDefault) (layerDelta as Record<string, unknown>)[key] = value;
  }
  return {
    layerDelta,
    documentAdjustments: documentPatch ? { ...current, ...documentPatch } : null,
  };
}

export interface DocumentLevelSplit {
  layerAdjustments: Partial<Adjustments>;
  transform: Partial<DocTransform>;
  finalEffects: Partial<DocFinalEffects>;
}

interface CompleteDocumentLevelSplit extends DocumentLevelSplit {
  transform: DocTransform;
  finalEffects: DocFinalEffects;
}

/** Split any flat adjustment write according to the document's ownership. */
export function splitDocumentLevel(adj: Adjustments): CompleteDocumentLevelSplit;
export function splitDocumentLevel(adj: Partial<Adjustments>): DocumentLevelSplit;
export function splitDocumentLevel(adj: Partial<Adjustments>): DocumentLevelSplit {
  const layerAdjustments: Partial<Adjustments> = { ...adj };
  const transform: Partial<DocTransform> = {};
  const finalEffects: Partial<DocFinalEffects> = {};
  for (const field of TRANSFORM_FIELDS) {
    if (Object.hasOwn(adj, field)) {
      (transform as Record<string, unknown>)[field] = adj[field];
    }
    delete (layerAdjustments as Record<string, unknown>)[field];
  }
  for (const field of EFFECTS_FIELDS) {
    if (Object.hasOwn(adj, field)) {
      (finalEffects as Record<string, unknown>)[field] = adj[field];
    }
    delete (layerAdjustments as Record<string, unknown>)[field];
  }
  return { layerAdjustments, transform, finalEffects };
}

/**
 * Apply a complete flat adjustment state without disturbing document-only
 * metadata, non-base layers or their masks.
 */
export function applyAdjustmentsToDocument(doc: PhotoDocument, adj: Adjustments): PhotoDocument {
  const { layerAdjustments, transform, finalEffects } = splitDocumentLevel(adj);
  const baseIdx = doc.layers.findIndex((layer) => layer.type === 'base');
  const layers = baseIdx < 0 ? doc.layers : doc.layers.map((layer, index) =>
    index === baseIdx ? { ...layer, adjustments: layerAdjustments } : layer);
  return {
    ...doc,
    layers,
    transform: Object.keys(transform).length > 0 ? { ...doc.transform, ...transform } : doc.transform,
    finalEffects: Object.keys(finalEffects).length > 0
      ? { ...doc.finalEffects, ...finalEffects }
      : doc.finalEffects,
  };
}

/**
 * Convert a flat Adjustments object to a PhotoDocument.
 * Used for migrating old persisted edits.
 */
export function adjustmentsToDocument(adj: Adjustments): PhotoDocument {
  const { layerAdjustments, transform, finalEffects } = splitDocumentLevel(adj);

  return {
    version: DOCUMENT_VERSION,
    layers: [createBaseLayer(layerAdjustments)],
    transform,
    finalEffects,
  };
}

/**
 * Flatten a PhotoDocument back to a single Adjustments object.
 * Only uses the base layer — adjustment layers are ignored for now
 * (compositing is Phase 3c).
 */
export function documentToAdjustments(doc: PhotoDocument): Adjustments {
  const base = doc.layers.find((l) => l.type === 'base');
  return {
    ...defaultAdjustments,
    ...(base?.adjustments ?? {}),
    // Re-inject document-level settings
    rotation: doc.transform.rotation,
    flipH: doc.transform.flipH,
    flipV: doc.transform.flipV,
    cropAspect: doc.transform.cropAspect as Adjustments['cropAspect'],
    perspectiveV: doc.transform.perspectiveV,
    perspectiveH: doc.transform.perspectiveH,
    distortion: doc.transform.distortion,
    vignette: doc.finalEffects.vignette,
    vignetteFeather: doc.finalEffects.vignetteFeather,
    grain: doc.finalEffects.grain,
    grainSize: doc.finalEffects.grainSize,
  };
}

/**
 * Write a few adjustment keys to their owner (base, transform or final
 * effects) and leave every unrelated document value untouched.
 *
 * Quick Develop needs this: it sets single tone values across a whole
 * selection, and rebuilding those photos' documents from a flat Adjustments
 * object would throw away layer work that the moved slider never touched.
 */
export function patchBaseAdjustments(
  doc: PhotoDocument,
  patch: Partial<Adjustments>,
): PhotoDocument {
  const { layerAdjustments, transform, finalEffects } = splitDocumentLevel(patch);
  const baseIdx = doc.layers.findIndex((l) => l.type === 'base');
  const layers = baseIdx < 0 ? doc.layers : [...doc.layers];
  if (baseIdx >= 0) {
    const nextBaseAdjustments = { ...layers[baseIdx].adjustments, ...layerAdjustments };
    for (const field of DOCUMENT_LEVEL_FIELDS) {
      delete (nextBaseAdjustments as Record<string, unknown>)[field];
    }
    layers[baseIdx] = { ...layers[baseIdx], adjustments: nextBaseAdjustments };
  }
  return {
    ...doc,
    layers,
    transform: Object.keys(transform).length > 0 ? { ...doc.transform, ...transform } : doc.transform,
    finalEffects: Object.keys(finalEffects).length > 0
      ? { ...doc.finalEffects, ...finalEffects }
      : doc.finalEffects,
  };
}

/**
 * Check if a stored object is a PhotoDocument (vs legacy flat Adjustments).
 */
export function isPhotoDocument(obj: unknown): obj is PhotoDocument {
  return typeof obj === 'object' && obj !== null && 'version' in obj && 'layers' in obj;
}

// ─── Defaults ──────────────────────────────────────────────────

const DEFAULT_TRANSFORM: DocTransform = {
  rotation: 0, flipH: false, flipV: false,
  cropAspect: 'free', perspectiveV: 0, perspectiveH: 0, distortion: 0,
};

const DEFAULT_EFFECTS: DocFinalEffects = {
  vignette: 0, vignetteFeather: 50, grain: 0, grainSize: 25,
};
