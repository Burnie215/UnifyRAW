/**
 * Step 2 of the single-source-of-truth plan, second half of the missing
 * direction: turn the params of an already-recognised graph shape back into
 * the adjustments the classic view owns. Pure — no GL, no registry, no React.
 *
 * The forward direction is `DefaultGraphBuilder`'s `pluck*` family: it pours
 * editor-native adjustment values into per-node params, mostly dividing by
 * 100 because the shaders work on a -1..1 scale. Every function here is the
 * inverse of exactly one of them, and the round-trip tests next door go
 * through the builder's own exports rather than a second copy of the maths.
 *
 * Two rules only become visible when several branches are compared, and both
 * are cross-branch by nature rather than per-node:
 *
 *   - Transform and effect params have to be IDENTICAL across all branches.
 *     Not "exactly one node at the end" — every layer branch runs the full
 *     chain and inherits the base's geometry through `mergeAdjustments`. If
 *     the branches drifted apart geometrically the compositing would slide
 *     (regression of 2026-05-17, see the comment at DocumentModel.ts:172).
 *   - `colorMatrix`, `whiteBalanceRaw` and `outputColorSpace` may not deviate
 *     from the source-derived values, because classically they are not editable.
 *
 * What the graph does NOT carry, and what is therefore reported rather than
 * invented, is listed at INVERSION LOSSES at the bottom of this file.
 */
import { readColorSpaceOverride, type RenderGraph, type RenderNode } from '../types';
import {
  KIND_LENS_CORRECTION,
  KIND_TONE,
  KIND_WHITE_BALANCE,
  KIND_TONE_CURVE,
  KIND_HSL,
  KIND_HSL_DETAIL,
  KIND_CUSTOM_HSL,
  KIND_LEVELS,
  KIND_BW,
  KIND_COLOR_GRADING,
  KIND_CLARITY,
  KIND_TEXTURE,
  KIND_DENOISE,
  KIND_SHARPEN,
  KIND_EFFECTS,
  KIND_TRANSFORM,
  KIND_CROP,
  KIND_WHITE_BALANCE_RAW,
  KIND_COLOR_MATRIX,
  KIND_OUTPUT_COLOR_SPACE,
  IDENTITY_COLOR_MATRIX_3X3,
  type BwMix,
  type ColorGradingZone,
  type CurvePoint,
  type CustomHslSector,
  type HslChannel,
  type HslChannels,
  type HslDetailParams,
} from '../passKinds';
import {
  ABSOLUTE_FIELDS,
  chainKindsForSource,
  paramsByNodeFromAdjustments,
  stageOfNodeId,
  type BuilderAdjustments,
  type BuilderSourceSpec,
} from '../DefaultGraphBuilder';
import type { BlockedNode, GraphShape, ScannedChain, ScannedLayer } from './shapeScan';
import { blockReasonId, type BlockReason } from './blockReasons';
import { LENS_PROFILES } from '../../LensCorrection';
import type { LensCoefficients } from '../../lensProfile';
import { rawWhiteBalanceGains } from '../../raw/whiteBalance';
import { normalizeCropRect } from '../../Crop';

// ─── Result shapes ────────────────────────────────────────────────

/** One layer branch, read back. */
export interface ProjectedLayerParams {
  compositorId: string;
  /**
   * The absolute adjustments this branch renders with. The builder feeds
   * every branch `mergeAdjustments(base, layerDelta)`, so this is that merge
   * result, not the layer's stored delta.
   */
  merged: BuilderAdjustments;
  /** The stored delta, i.e. `merged` measured against `base`. */
  delta: BuilderAdjustments;
}

export interface ProjectedParams {
  base: BuilderAdjustments;
  /** Same order as `GraphShape.layers` — bottom of the stack first. */
  layers: ProjectedLayerParams[];
}

export type ParamsToAdjustmentsResult =
  | { ok: true; projected: ProjectedParams }
  | { ok: false; blocked: BlockedNode[] };

/**
 * The parameter findings, by key. `field` travels raw — the name the params
 * carry, not a translated label — because the sentence quotes it verbatim.
 * The German sentences (quoted from the plan's table) and their English
 * counterparts live in the locale files under `gate.reasons.param.*`.
 */
export const PARAM_REASONS = {
  branchDiffers: (field: string): BlockReason =>
    ({ key: 'param.branchDiffers', params: { field } }),
  cameraMetadata: (field: string): BlockReason =>
    ({ key: 'param.cameraMetadata', params: { field } }),
  lensProfileUnknown: { key: 'param.lensProfileUnknown' },
  baseStageEdited: { key: 'param.baseStageEdited' },
  spaceOverrideAsymmetric: { key: 'param.spaceOverrideAsymmetric' },
  spaceOverrideConflict: { key: 'param.spaceOverrideConflict' },
} as const;

// ─── Public entry points ──────────────────────────────────────────

/**
 * Read one chain's node params back into adjustments.
 *
 * Sparse on purpose: a field appears only when the chain actually carries the
 * node that owns it. A deleted node is explicitly not a blocking finding —
 * absent params mean identity, and identity is exactly what an absent
 * `BuilderAdjustments` field produces on the way forward.
 */
export function adjustmentsFromChainParams(
  graph: RenderGraph,
  chain: ScannedChain,
  source: BuilderSourceSpec,
): { adjustments: BuilderAdjustments; blocked: BlockedNode[] } {
  const blocked: BlockedNode[] = [];
  const add = (nodeId: string, reason: BlockReason) => {
    const id = blockReasonId(reason);
    if (!blocked.some((b) => b.nodeId === nodeId && blockReasonId(b.reason) === id)) {
      blocked.push({ nodeId, reason });
    }
  };
  const out: BuilderAdjustments = {};
  const hslSpaces: Array<{ nodeId: string; space: 'linear' | 'gamma' }> = [];
  const chainKinds = new Set(chainKindsForSource(source));
  // What the camera profile's nodes have to hold. They are checked against
  // it and never read into `out`: a base value is the RAW converter's, not a
  // slider's, and reading it would hand the profile's exposure to the
  // exposure slider the moment the user's own tone node is gone.
  const expectedBase = paramsByNodeFromAdjustments({}, source);

  for (const nodeId of chain.nodeIds) {
    const node = graph.nodes.get(nodeId);
    if (!node) continue;
    const p = paramsRecord(node);

    if (stageOfNodeId(nodeId) === 'base') {
      if (!deepEqual(p, expectedBase.get(baseStageId(nodeId)))) {
        add(nodeId, PARAM_REASONS.baseStageEdited);
      }
      continue;
    }

    switch (node.kind) {
      case KIND_LENS_CORRECTION:
        readLensCorrection(p, node.id, out, add, source);
        break;

      case KIND_TONE:
        out.exposure = mul100(p.exposure);
        out.contrast = mul100(p.contrast);
        out.highlights = mul100(p.highlights);
        out.shadows = mul100(p.shadows);
        out.whites = mul100(p.whites);
        out.blacks = mul100(p.blacks);
        break;

      case KIND_WHITE_BALANCE:
        // For raw sources the builder drops this kind and routes
        // temperature/tint through whiteBalanceRaw instead, so a whiteBalance
        // node sitting in a raw chain is not the builder's and must not
        // overwrite what the raw node says. Its presence is a chain-order
        // finding, which is not this module's rule to raise.
        if (!chainKinds.has(KIND_WHITE_BALANCE_RAW)) {
          out.temperature = mul100(p.temperature);
          out.tint = mul100(p.tint);
        }
        break;

      case KIND_TONE_CURVE:
        out.toneCurve = {
          rgb: readCurve(p.rgb),
          luma: readCurve(p.luma),
          red: readCurve(p.red),
          green: readCurve(p.green),
          blue: readCurve(p.blue),
        };
        assignSpace(node, out, 'toneCurveSpace', add);
        break;

      case KIND_LEVELS:
        out.levels = {
          rgb: readLevelsChannel(p.rgb),
          red: readLevelsChannel(p.red),
          green: readLevelsChannel(p.green),
          blue: readLevelsChannel(p.blue),
        };
        break;

      case KIND_HSL:
        out.vibrance = mul100(p.vibrance);
        out.saturation = mul100(p.saturation);
        collectHslSpace(node, hslSpaces, add);
        break;

      case KIND_HSL_DETAIL: {
        out.hsl = readHslChannels(p.channels);
        const view = p.viewSelected as HslDetailParams['viewSelected'];
        const skin = p.skinTone as HslDetailParams['skinTone'];
        if (view) out.hslViewSelected = { ...view };
        if (skin) out.hslSkinTone = { ...skin };
        collectHslSpace(node, hslSpaces, add);
        break;
      }

      case KIND_CUSTOM_HSL: {
        const sectors = readCustomHslSectors(p.sectors);
        // An empty sector list is what an absent field produces going
        // forward; keeping the field absent stays closer to "no edit".
        if (sectors.length > 0) out.customHslSectors = sectors;
        collectHslSpace(node, hslSpaces, add);
        break;
      }

      case KIND_BW:
        out.bwEnabled = bool(p.enabled);
        out.bwMix = readBwMix(p.mix);
        break;

      case KIND_COLOR_GRADING:
        out.colorGrading = {
          shadows: readGradingZone(p.shadows),
          midtones: readGradingZone(p.midtones),
          highlights: readGradingZone(p.highlights),
          balance: num(p.balance, 0),
          blending: num(p.blending, 50),
        };
        assignSpace(node, out, 'colorGradingSpace', add);
        break;

      case KIND_CLARITY:
        out.clarity = mul100(p.clarity);
        out.dehaze = mul100(p.dehaze);
        break;

      case KIND_TEXTURE:
        out.texture = mul100(p.amount);
        break;

      case KIND_DENOISE:
        out.denoiseLuma = mul100(p.luma);
        out.denoiseChroma = mul100(p.chroma);
        out.denoiseDetail = mul100(num(p.detail, 0.5));
        break;

      case KIND_SHARPEN:
        out.sharpness = mul100(p.sharpness);
        break;

      case KIND_EFFECTS:
        out.vignette = mul100(p.vignette);
        out.vignetteFeather = mul100(num(p.vignetteFeather, 0.5));
        out.grain = mul100(p.grain);
        out.grainSize = num(p.grainSize, 25);
        out.noiseReduction = mul100(p.noiseReduction);
        break;

      case KIND_TRANSFORM:
        // Degrees back out of radians. The same factor was missing in the
        // forward direction on 2026-09-02 and made every rotation 180/pi
        // times too strong.
        out.rotation = roundQuiet(num(p.rotation) * 180 / Math.PI);
        out.flipH = bool(p.flipH);
        out.flipV = bool(p.flipV);
        out.perspectiveH = mul100(p.perspectiveH);
        out.perspectiveV = mul100(p.perspectiveV);
        out.distortion = mul100(p.distortion);
        break;

      case KIND_CROP:
        out.crop = normalizeCropRect(p);
        break;

      case KIND_WHITE_BALANCE_RAW: {
        const wb = readRawWhiteBalance(p.wb, source);
        if (!wb) {
          add(node.id, PARAM_REASONS.cameraMetadata(KIND_WHITE_BALANCE_RAW));
          break;
        }
        out.temperature = wb.temperature;
        out.tint = wb.tint;
        break;
      }

      case KIND_COLOR_MATRIX:
        // Nothing to read back: the matrix is camera metadata the builder
        // copies out of the source spec. All that is left to do is verify it
        // was not edited.
        if (!sameNumbers(readNumbers(p.matrix, 9), expectedColorMatrix(source))) {
          add(node.id, PARAM_REASONS.cameraMetadata(KIND_COLOR_MATRIX));
        }
        break;

      case KIND_OUTPUT_COLOR_SPACE:
        if (!deepEqual(p, expectedBase.get(`default:${KIND_OUTPUT_COLOR_SPACE}`))) {
          add(node.id, PARAM_REASONS.cameraMetadata(KIND_OUTPUT_COLOR_SPACE));
        }
        break;

      default:
        // Unknown kinds, wrong order and duplicates are the chain rules'
        // business.
        break;
    }
  }

  if (hslSpaces.length > 0) {
    const first = hslSpaces[0];
    const conflict = hslSpaces.find((s) => s.space !== first.space);
    if (conflict) add(conflict.nodeId, PARAM_REASONS.spaceOverrideConflict);
    else out.hslSpace = first.space;
  }

  return { adjustments: out, blocked };
}

/**
 * Read a whole recognised graph back: base adjustments, every layer branch's
 * absolute adjustments and its delta against the base, plus the two rules
 * that only a comparison of branches can check.
 */
export function paramsToAdjustments(
  graph: RenderGraph,
  shape: GraphShape,
  source: BuilderSourceSpec,
): ParamsToAdjustmentsResult {
  const blocked: BlockedNode[] = [];
  const addAll = (found: BlockedNode[]) => {
    for (const b of found) {
      if (!blocked.some((x) => x.nodeId === b.nodeId && x.reason === b.reason)) blocked.push(b);
    }
  };

  const baseRead = adjustmentsFromChainParams(graph, shape.base, source);
  addAll(baseRead.blocked);
  const postRead = adjustmentsFromChainParams(graph, shape.post, source);
  addAll(postRead.blocked);
  const base = { ...baseRead.adjustments, ...postRead.adjustments };

  const layers: ProjectedLayerParams[] = [];
  for (const layer of shape.layers) {
    const read = adjustmentsFromChainParams(graph, layer.chain, source);
    addAll(read.blocked);
    layers.push({
      compositorId: layer.compositorId,
      merged: read.adjustments,
      delta: layerDeltaFromMerged(base, read.adjustments),
    });
  }

  addAll(checkSharedGeometry(graph, shape, source));

  if (blocked.length > 0) return { ok: false, blocked };
  return { ok: true, projected: { base, layers } };
}

/**
 * Inverse of the builder's `mergeAdjustments`: what delta, laid on `base`,
 * yields `merged`. Numbers with a zero point are additive there, so they
 * subtract here; `ABSOLUTE_FIELDS` and everything else override, so they are
 * carried over verbatim when they differ.
 *
 * Fields equal to the base are left out — a delta is meant to be the small
 * part, and that is also what the classic layer path stores.
 */
export function layerDeltaFromMerged(
  base: BuilderAdjustments,
  merged: BuilderAdjustments,
): BuilderAdjustments {
  const b = base as Record<string, unknown>;
  const m = merged as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const key of Object.keys(m)) {
    const mv = m[key];
    const bv = b[key];
    if (typeof mv === 'number' && typeof bv === 'number' && isAdditive(key)) {
      const diff = roundQuiet(mv - bv);
      if (diff !== 0) out[key] = diff;
      continue;
    }
    if (!deepEqual(mv, bv)) out[key] = mv;
  }
  // A field the base carries and the branch does not means the branch is
  // missing a node the base has. Additive numbers can express that (subtract
  // the base back out). Skin-tone uniformity has a real off value, represented
  // by an own `hslSkinTone: undefined`; other overriding fields cannot be
  // un-set through a delta. The geometry rule below catches the cases where
  // that would change the picture.
  for (const key of Object.keys(b)) {
    if (key in m) continue;
    const bv = b[key];
    if (typeof bv === 'number' && bv !== 0 && isAdditive(key)) out[key] = roundQuiet(-bv);
    else if (key === 'hslSkinTone') out[key] = undefined;
  }
  return out as BuilderAdjustments;
}

function isAdditive(key: string): boolean {
  return !ABSOLUTE_FIELDS.has(key as keyof BuilderAdjustments);
}

// ─── Cross-branch rule: shared geometry and look ──────────────────

/**
 * Fields of the effects node that live at document level. `noiseReduction`
 * is deliberately not among them: DocumentModel's `EFFECTS_FIELDS` does not
 * list it, so an adjustment layer may legitimately carry its own value and
 * the branches are allowed to differ there.
 */
const SHARED_EFFECTS_FIELDS = ['vignette', 'vignetteFeather', 'grain', 'grainSize'] as const;

const SHARED_TRANSFORM_FIELDS = [
  'rotation', 'flipH', 'flipV', 'perspectiveH', 'perspectiveV', 'distortion',
] as const;

/**
 * The lens correction bends the picture as much as a transform does, so two
 * branches that correct differently composite with ghost edges. It is a fact
 * about the glass rather than a look, which is why no layer may hold its own.
 */
const SHARED_LENS_FIELDS = [
  'enabled', 'k1', 'k2', 'k3', 'v1', 'v2', 'v3', 'caR', 'caB', 'strength',
] as const;

/**
 * Every branch has to carry the same transform, the same lens correction and
 * the same document-level effects. A branch without the node counts as
 * identity, which is what the builder emits for an untouched document — so a
 * base that rotates and a branch that does not still differ, and rightly
 * blocks.
 *
 * One exemption, decided by the user on 2026-09-03: a preset layer may hold
 * its own grain and vignette. `layerAdjustmentsForRendering` strips only the
 * transform fields from a preset layer, deliberately, so the Amount slider
 * fades the look's grain along with the rest (comment at PresetLayer.ts:20).
 * Requiring effect equality there would lock the way back on an ordinary
 * document that merely has a look preset applied — a warning where nothing
 * is wrong. The exemption is narrow on purpose: transform stays strict for
 * preset layers too, because those fields are stripped from them anyway, so
 * a difference means someone edited the graph by hand.
 */
function checkSharedGeometry(
  graph: RenderGraph,
  shape: GraphShape,
  source: BuilderSourceSpec,
): BlockedNode[] {
  if (shape.layers.length === 0) return [];
  const blocked: BlockedNode[] = [];
  const identity = paramsByNodeFromAdjustments({}, source);

  for (const [kind, fields] of [
    [KIND_TRANSFORM, SHARED_TRANSFORM_FIELDS] as const,
    [KIND_EFFECTS, SHARED_EFFECTS_FIELDS] as const,
    [KIND_LENS_CORRECTION, SHARED_LENS_FIELDS] as const,
  ]) {
    const fallback = paramsRecordOf(identity.get(`default:${kind}`));
    const baseParams = effectiveChainParams(graph, shape.base, kind, fallback);
    for (const layer of shape.layers) {
      if (kind === KIND_EFFECTS && isPresetLayer(graph, layer)) continue;
      const found = findChainNode(graph, layer.chain, kind);
      const branchParams = found ? paramsRecord(found) : fallback;
      for (const field of fields) {
        if (deepEqual(branchParams[field], baseParams[field])) continue;
        blocked.push({
          nodeId: found?.id ?? layer.compositorId,
          reason: PARAM_REASONS.branchDiffers(field),
        });
      }
    }
  }
  return blocked;
}

/** Does this layer's compositor carry a preset marker? Read from the params,
 *  not from the node id — a hand-built graph names nodes however it likes. */
function isPresetLayer(graph: RenderGraph, layer: ScannedLayer): boolean {
  const compositor = graph.nodes.get(layer.compositorId);
  if (!compositor) return false;
  const presetSyncId = paramsRecord(compositor).presetSyncId;
  return typeof presetSyncId === 'string' && presetSyncId.length > 0;
}

function findChainNode(graph: RenderGraph, chain: ScannedChain, kind: string): RenderNode | null {
  // Last one wins: a chain with the same kind twice is a chain-rules finding,
  // and until it is raised the downstream node is the one that has the say.
  let found: RenderNode | null = null;
  for (const id of chain.nodeIds) {
    const node = graph.nodes.get(id);
    if (node?.kind === kind) found = node;
  }
  return found;
}

function effectiveChainParams(
  graph: RenderGraph,
  chain: ScannedChain,
  kind: string,
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  const node = findChainNode(graph, chain, kind);
  return node ? paramsRecord(node) : fallback;
}

// ─── Per-plucker inverses ─────────────────────────────────────────

/** `layer:<id>:base:<kind>` and `base:<kind>` both name the profile's
 *  `base:<kind>`; kinds carry no `base:` of their own. */
function baseStageId(nodeId: string): string {
  return nodeId.slice(nodeId.lastIndexOf('base:'));
}

/** Inverse of `pluckLensCorrection`. */
function readLensCorrection(
  p: Record<string, unknown>,
  nodeId: string,
  out: BuilderAdjustments,
  add: (nodeId: string, reason: BlockReason) => void,
  source: BuilderSourceSpec,
): void {
  out.lensCorrectionStrength = mul100(num(p.strength, 1));
  if (!bool(p.enabled)) {
    // The forward direction collapses "switched off" and "no profile chosen"
    // into the same all-zero params, so which of the two it was is gone.
    out.lensCorrection = false;
    out.lensCorrectionProfile = null;
    return;
  }
  // The profile resolved for this lens wins in the forward direction without
  // anyone switching it on, the same way the camera's white balance gains
  // do. It is not a choice the classic view offers, so reading it back as one
  // would be wrong - and a measured profile is in no list to be found in.
  const resolved = source.kind === 'raw16' ? source.lensProfile : null;
  if (resolved && sameLens(p, resolved)) {
    out.lensCorrection = false;
    out.lensCorrectionProfile = null;
    return;
  }
  const profile = LENS_PROFILES.find((candidate) => sameLens(p, candidate));
  if (!profile) {
    add(nodeId, PARAM_REASONS.lensProfileUnknown);
    return;
  }
  out.lensCorrection = true;
  out.lensCorrectionProfile = profile.id;
}

function sameLens(p: Record<string, unknown>, lens: LensCoefficients): boolean {
  return num(p.k1) === lens.k1 && num(p.k2) === lens.k2 && num(p.k3) === lens.k3 &&
    num(p.v1) === lens.v1 && num(p.v2) === lens.v2 && num(p.v3) === lens.v3 &&
    num(p.caR) === lens.caR && num(p.caB) === lens.caB;
}

/** Inverse of `pluckLevelsChannel` — endpoints 0..1 back to the editor's 0..255. */
function readLevelsChannel(value: unknown): {
  inBlack: number; inWhite: number; gamma: number; outBlack: number; outWhite: number;
} {
  const c = paramsRecordOf(value);
  return {
    inBlack: mul255(num(c.inBlack, 0)),
    inWhite: mul255(num(c.inWhite, 1)),
    gamma: num(c.gamma, 1),
    outBlack: mul255(num(c.outBlack, 0)),
    outWhite: mul255(num(c.outWhite, 1)),
  };
}

/** Inverse of `pluckToneCurve` — points are 0..1 on both sides. */
function readCurve(value: unknown): CurvePoint[] {
  if (!Array.isArray(value)) return [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  return value.map((pt) => {
    const rec = paramsRecordOf(pt);
    return { x: num(rec.x), y: num(rec.y) };
  });
}

/** Inverse of `pluckHslDetail`'s channel merge — -100..100 on both sides. */
function readHslChannels(value: unknown): HslChannels {
  const src = paramsRecordOf(value);
  const out: Record<string, HslChannel> = {};
  for (const name of ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta']) {
    const c = paramsRecordOf(src[name]);
    out[name] = { hue: num(c.hue), saturation: num(c.saturation), luminance: num(c.luminance) };
  }
  return out as HslChannels;
}

/** Inverse of `pluckBw`'s mix merge — no scaling in either direction. */
function readBwMix(value: unknown): BwMix {
  const src = paramsRecordOf(value);
  const out: Record<string, number> = {};
  for (const name of ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta']) {
    out[name] = num(src[name]);
  }
  return out as unknown as BwMix;
}

/** Inverse of `pluckCustomHsl` — sectors pass through unscaled. The schema
 * and renderer both define an omitted activation flag as enabled. */
function readCustomHslSectors(value: unknown): CustomHslSector[] {
  if (!Array.isArray(value)) return [];
  return value.map((sector) => {
    const s = paramsRecordOf(sector);
    return {
      hueCenter: num(s.hueCenter),
      hueHalfWidth: num(s.hueHalfWidth),
      feather: num(s.feather),
      dH: num(s.dH), dS: num(s.dS), dL: num(s.dL),
      enabled: typeof s.enabled === 'boolean' ? s.enabled : true,
    };
  });
}

/** Inverse of `pluckColorGradingZone` — hue/saturation pass through, the two
 *  arc adjustments go back from -1..1 to the editor's -100..100. */
function readGradingZone(value: unknown): ColorGradingZone {
  const z = paramsRecordOf(value);
  return {
    hue: num(z.hue),
    saturation: num(z.saturation),
    satAdj: mul100(z.satAdj),
    lumAdj: mul100(z.lumAdj),
  };
}

/**
 * Inverse of `pluckWhiteBalanceRaw`. The node's gains are the camera's
 * as-shot multipliers times the user's relative correction:
 *
 *   r = 2^( T + S/4),  g = 2^(-S/2),  b = 2^(-T + S/4)
 *   with T = temperature/100 * 0.75 and S = tint/100 * 0.6
 *
 * so the sliders come back out of g alone and out of the r/b ratio. Dividing
 * the camera part out first is what makes the recovery possible at all —
 * which is also why the result is verified against the forward function:
 * anything that does not reproduce exactly is a gain the camera metadata and
 * the two sliders cannot make together.
 */
function readRawWhiteBalance(
  value: unknown,
  source: BuilderSourceSpec,
): { temperature: number; tint: number } | null {
  const wb = readNumbers(value, 3);
  const asShot = source.kind === 'raw16' ? source.calibration?.asShotNeutral : null;
  // rawWhiteBalanceGains with neutral sliders is the camera part alone,
  // including its guard against non-positive metadata.
  const base = rawWhiteBalanceGains(asShot, 0, 0);
  const r = wb[0] / base[0];
  const g = wb[1] / base[1];
  const b = wb[2] / base[2];
  if (!(r > 0) || !(g > 0) || !(b > 0)) return null;

  const tintSpread = -2 * Math.log2(g);
  const temperatureStops = Math.log2(r / b) / 2;
  const temperature = roundQuiet(temperatureStops / 0.75 * 100);
  const tint = roundQuiet(tintSpread / 0.6 * 100);

  const forward = rawWhiteBalanceGains(asShot, temperature, tint);
  for (let i = 0; i < 3; i++) {
    if (Math.abs(forward[i] - wb[i]) > 1e-9 * Math.max(1, Math.abs(wb[i]))) return null;
  }
  return { temperature, tint };
}

/** Mirrors `pluckColorMatrix`: the matrix the source spec dictates. */
function expectedColorMatrix(source: BuilderSourceSpec): number[] {
  if (source.kind !== 'raw16') return [...IDENTITY_COLOR_MATRIX_3X3];
  const m = source.calibration?.colorMatrix;
  if (!m || m.length < 9) return [...IDENTITY_COLOR_MATRIX_3X3];
  return m.slice(0, 9);
}

// ─── Phase-3 color-space override ─────────────────────────────────

/**
 * Inverse of `applyPhase3Override`. The forward direction writes the same
 * space into both ports, so anything else is a hand-made node that no single
 * classic switch can describe.
 */
function readSpaceOverride(
  node: RenderNode,
  add: (nodeId: string, reason: BlockReason) => void,
): 'linear' | 'gamma' | undefined {
  const override = readColorSpaceOverride(node.params);
  if (!override) return undefined;
  if (!override.inputSpace || override.inputSpace !== override.outputSpace) {
    add(node.id, PARAM_REASONS.spaceOverrideAsymmetric);
    return undefined;
  }
  return override.inputSpace;
}

function assignSpace(
  node: RenderNode,
  out: BuilderAdjustments,
  field: 'toneCurveSpace' | 'colorGradingSpace' | 'hslSpace',
  add: (nodeId: string, reason: BlockReason) => void,
): void {
  const space = readSpaceOverride(node, add);
  if (space) out[field] = space;
}

/** hsl, hslDetail and customHSL all carry the single `hslSpace` switch, so
 *  they are collected and only agreed values are written back. */
function collectHslSpace(
  node: RenderNode,
  into: Array<{ nodeId: string; space: 'linear' | 'gamma' }>,
  add: (nodeId: string, reason: BlockReason) => void,
): void {
  const space = readSpaceOverride(node, add);
  if (space) into.push({ nodeId: node.id, space });
}

// ─── Scalar helpers ───────────────────────────────────────────────

function paramsRecord(node: RenderNode): Record<string, unknown> {
  return paramsRecordOf(node.params);
}

function paramsRecordOf(value: unknown): Record<string, unknown> {
  return (value && typeof value === 'object') ? value as Record<string, unknown> : {};
}

function num(value: unknown, fallback = 0): number {
  return (typeof value === 'number' && Number.isFinite(value)) ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readNumbers(value: unknown, count: number): number[] {
  const out: number[] = [];
  const arr = Array.isArray(value) ? value : [];
  for (let i = 0; i < count; i++) out.push(num(arr[i]));
  return out;
}

function sameNumbers(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Node params are on the shader scale; most editor sliders are 100x that. */
function mul100(value: unknown): number {
  return roundQuiet(num(value) * 100);
}

/** Levels endpoints are 0..1 in the node and 0..255 in the editor. */
function mul255(value: number): number {
  return roundQuiet(value * 255);
}

/**
 * Undo the float noise the forward scaling leaves behind: 37.5 degrees stored
 * as radians comes back as 37.50000000000001, and a round-trip that compares
 * exactly would fail on a difference no slider can produce. Six decimals is
 * far finer than any control in the editor.
 */
function roundQuiet(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Structural equality for params and adjustment values. Exported for the
 *  document assembly next door, which asks the same question about the same
 *  values — a second copy would be one more thing to keep in step. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (!a || !b || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  for (const key of keys) {
    if (!deepEqual(ra[key], rb[key])) return false;
  }
  return true;
}

// ─── INVERSION LOSSES ─────────────────────────────────────────────
//
// Places where the forward direction throws information away, so no inverse
// can be exact. None of them is invented here; all are reported.
//
// 1. Lens correction, switched off. `pluckLensCorrection` writes all-zero
//    coefficients both for `lensCorrection: false` and for
//    `lensCorrectionProfile: null`. Read back as
//    `{ lensCorrection: false, lensCorrectionProfile: null }`; a profile that
//    was selected but inactive is gone.
// 2. Custom HSL sectors. `adjustmentsToBuilderAdjustments` concatenates
//    `advancedSectors`, `skinToneSectors` and `skinToneSector` into one list.
//    Which sector came from which of the three cannot be recovered, so the
//    result carries the single `customHslSectors` list and the split has to
//    be decided by whoever writes the Adjustments object.
// 3. Raw white balance beyond the slider range. `sliderUnit` clamps
//    temperature/tint to +-100, so gains built from a larger value read back
//    as the clamped one. Such a node does not reproduce and is therefore
//    reported as deviating from the camera values rather than silently
//    clamped.
// 4. Identity vs. absent. A node with identity params and a deleted node are
//    the same picture (the compiler skips identity passes), so the sparse
//    result cannot say which of the two the graph held. This is the plan's
//    explicit non-finding, not a defect.
// 5. Fields no wrapped kind owns. `colorEditorMode`, `cropAspect`,
//    `sharpenRadius`, `sharpenMasking` and the AI-denoise trio have no node in
//    the chain, hence no params to read. `skinToneUniformity` is reconstructable
//    from `hslSkinTone.uniHue`, `uniSat` and `uniLum` by the document projection.
//    That is why this module returns `BuilderAdjustments`: it is exactly the
//    vocabulary the builder consumes, so the result can be fed straight back
//    through `paramsByNodeFromAdjustments` and compared. Widening it to
//    `Partial<Adjustments>` would mean inventing values for controls the
//    graph never saw.
// 6. Lens correction under a resolved profile. On a RAW whose lens has a
//    measured or built-in profile, `pluckLensCorrection` lets that profile
//    win over `lensCorrection`/`lensCorrectionProfile`, so a manual choice
//    underneath it never reaches the node. Read back as
//    `{ lensCorrection: false, lensCorrectionProfile: null }`.
