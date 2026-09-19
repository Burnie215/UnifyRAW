/**
 * Deterministic hash of an edit stack so that two semantically-equal edits
 * produce the same identifier. Used as the filename suffix when pushing
 * edited assets back to a source (`<stem>_edit_<hash8>.<ext>`) — same
 * stack therefore produces the same filename, which the source then sees
 * as "already exists" and skips re-upload (idempotency).
 *
 * Normalization rules (see plans/EXPORT_WRITEBACK_PLAN.md §Edit-Stack-Hash):
 *  1. Layer ORDER is preserved (semantically relevant).
 *  2. Object keys inside a layer are sorted alphabetically.
 *  3. Defaults are explicitly filled before hashing — done by the caller
 *     via `normalizeLayer`; here we only canonicalize the already-normalized
 *     input.
 *  4. Floats round to 6 decimals (kills FP noise without losing slider
 *     precision; UI sliders use 0.01 step or coarser).
 *  5. UI-state keys (`expanded`, `selected`, `lastModifiedAt`, …) are
 *     stripped via the `excludeKeys` option — Whitelist would be safer but
 *     the existing Adjustments type doesn't carry tagging yet.
 *  6. Output is prefixed with `unifyraw-edit-stack-v3\n` so future schema
 *     breaks bump the prefix and produce a different hash space.
 *
 * The v2 bump (2026-09-03): what gets hashed used to be the FLATTENED
 * adjustments, i.e. the base layer alone — the caller passed
 * `documentToAdjustments(doc)`. Since the exporter renders the whole
 * document, two versions differing only in a layer (a preset above all)
 * would otherwise produce the same filename, and the source would skip the
 * second one as "already there". Every photo therefore gets a new filename
 * once, which is the price of the prefix bump and the reason it exists.
 *
 * The v3 bump (2026-09-12): `MaskDefinition` lost its `adjustments` field
 * (F001). A stored mask that still carries it hands the values to its layer on
 * load, so the same edit canonicalizes differently from here on. Same price as
 * v2 — one new filename per photo — and the same reason to pay it openly
 * rather than let the hash jump silently.
 */

import type { PhotoDocument } from '../engine/DocumentModel';
import {
  KIND_IMAGE_BITMAP_SOURCE,
  KIND_RAW16_SOURCE,
  KIND_RASTERIZED_MASK_SOURCE,
} from '../engine/graph/sources';

const VERSION_PREFIX = 'unifyraw-edit-stack-v3\n';

const DEFAULT_EXCLUDE = new Set([
  'expanded', 'selected', 'lastModifiedAt', 'lastModified',
  'createdAt', 'updatedAt', '_ui', '_uiState',
]);

export interface CanonicalizeOptions {
  /** Additional keys to exclude from the hash (added to the defaults). */
  excludeKeys?: Iterable<string>;
  /** Float precision in decimals. Default 6. */
  floatDecimals?: number;
}

/** Stable JSON: keys sorted, floats rounded, excluded keys dropped, arrays kept in order. */
export function canonicalize(value: unknown, opts: CanonicalizeOptions = {}): string {
  const exclude = new Set<string>(DEFAULT_EXCLUDE);
  if (opts.excludeKeys) for (const k of opts.excludeKeys) exclude.add(k);
  const decimals = opts.floatDecimals ?? 6;

  const walk = (v: unknown): unknown => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return null;
      if (Number.isInteger(v)) return v;
      return Number(v.toFixed(decimals));
    }
    if (typeof v === 'string' || typeof v === 'boolean') return v;
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === 'object') {
      const out: Record<string, unknown> = {};
      const keys = Object.keys(v as Record<string, unknown>)
        .filter((k) => !exclude.has(k))
        .sort();
      for (const k of keys) out[k] = walk((v as Record<string, unknown>)[k]);
      return out;
    }
    return null; // functions, symbols → ignored
  };

  return JSON.stringify(walk(value));
}

/**
 * What identifies one rendered version of a photo. Everything that changes
 * the pixels goes in; everything that does not stays out.
 *
 * Three shapes, in the order they are asked for:
 *
 *  - a graph-led document → the graph, since that is what renders. Node
 *    positions and the revision counter are left out on purpose: moving a
 *    node is not an edit (the plan says so in as many words), and the
 *    revision counts undo steps rather than differences. So is the source
 *    node's geometry: a graph is stored at whatever size the preview
 *    happened to be, and `buildDocumentGraph` overwrites it with the size
 *    the caller renders at. Hashing it would give the same edit a new
 *    filename on a device with a different preview size — a re-upload for
 *    nothing, which is the exact thing this hash exists to prevent.
 *  - a document → its layer stack plus the document-level transform, effects
 *    and retouch. Layer ids and names are left out — renaming a layer changes
 *    no pixel — while masks are in, because they very much do.
 *  - nothing but flat adjustments → those, as before.
 */
export function editStackFingerprint(
  document: PhotoDocument | null | undefined,
  adjustments: unknown,
): unknown {
  if (!document) return adjustments;

  if (document.pipelineMode === 'graph' && document.pipelineGraph) {
    const g = document.pipelineGraph;
    return {
      kind: 'graph',
      output: g.output,
      nodes: [...g.nodes]
        .map((n) => ({ id: n.id, kind: n.kind, params: withoutGeometry(n.kind, n.params) }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      edges: [...g.edges]
        .map((e) => ({ from: e.from, to: e.to }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    };
  }

  return {
    kind: 'document',
    transform: document.transform,
    finalEffects: document.finalEffects,
    // Only when there is one, so every document written before retouch
    // existed keeps the filename it already exported under. The ids are left
    // out for the same reason layer ids are: a fresh id changes no pixel, and
    // hashing it would re-upload the same picture under a new name.
    ...(document.retouch?.length
      ? { retouch: document.retouch.map(({ id: _id, ...spot }) => spot) }
      : {}),
    layers: document.layers.map((l) => ({
      type: l.type,
      visible: l.visible,
      opacity: l.opacity,
      blendMode: l.blendMode,
      adjustments: l.adjustments,
      mask: l.mask,
      presetSyncId: l.presetSyncId ?? null,
    })),
  };
}

const GEOMETRY_ONLY_KINDS = new Set<string>([
  KIND_IMAGE_BITMAP_SOURCE, KIND_RAW16_SOURCE, KIND_RASTERIZED_MASK_SOURCE,
]);

/** A source node's params are nothing but the geometry it is rendered at,
 *  and that is the caller's, not the edit's. Every other kind keeps its
 *  params whole — `width` on a pass means something. */
function withoutGeometry(kind: string, params: unknown): unknown {
  if (!GEOMETRY_ONLY_KINDS.has(kind) || !params || typeof params !== 'object') return params;
  const { width: _w, height: _h, pixelRatio: _p, ...rest } = params as Record<string, unknown>;
  return rest;
}

/** Hex-encoded SHA-256 of the canonical form. */
export async function editStackHash(stack: unknown, opts?: CanonicalizeOptions): Promise<string> {
  const canonical = VERSION_PREFIX + canonicalize(stack, opts);
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Short form for filename suffix (8 hex chars, ~32 bit). */
export function shortEditStackHash(fullHash: string): string {
  return fullHash.slice(0, 8);
}
