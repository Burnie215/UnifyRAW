/**
 * Where a blocking finding becomes a sentence.
 *
 * The projection names its findings (`BlockReason`: a key plus raw
 * placeholder values) and stops there — it is engine code and has no language.
 * This is the other half: the surface side that looks the key up in the
 * active locale. Pure, no React, so the locale gate can run it in node.
 *
 * Two things are deliberate here:
 *  - the i18n prefix lives HERE, not in the engine, so the engine never has to
 *    know how the locale tree is laid out;
 *  - node kinds arrive raw (`__customLut`) and are spelled by `nodeKindLabel`,
 *    the same function the node body, the inspector header and the library row
 *    use, so a kind reads the same wherever it appears.
 */
import { nodeKindLabel } from '../engine/graph/projection/chainRules';
import { BLOCK_REASON_PARAMS, type BlockReason, type BlockReasonKey } from '../engine/graph/projection/blockReasons';

/** Where the sentences live: `src/i18n/locales/<lang>/gate.json`. */
export const GATE_REASON_PREFIX = 'gate.reasons.';

/**
 * Params that carry a node kind id rather than a plain value. They are the
 * ones the sentences want as a node NAME, so they go through `nodeKindLabel`
 * before interpolation. `field` is not in here on purpose: it quotes the
 * param name verbatim.
 */
const KIND_PARAMS: ReadonlySet<string> = new Set(['kind', 'earlierKind', 'laterKind']);

/** Minimal shape of i18next's `t`, so callers can pass it without the app. */
export type TranslateFn = (key: string, params?: Record<string, string>) => string;

export function gateReasonKey(key: BlockReasonKey): string {
  return `${GATE_REASON_PREFIX}${key}`;
}

/** Every key the projection can raise, in declaration order. */
export function allGateReasonKeys(): BlockReasonKey[] {
  return Object.keys(BLOCK_REASON_PARAMS) as BlockReasonKey[];
}

/** One finding as the sentence the user reads. */
export function formatBlockReason(reason: BlockReason, t: TranslateFn): string {
  const raw = reason.params ?? {};
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    params[name] = KIND_PARAMS.has(name) ? nodeKindLabel(value) : value;
  }
  // The key is spelled out as a template rather than composed from
  // `gateReasonKey`, so the locale tooling — locales.test.ts and
  // `npm run i18n:unused`, both of which read `t(...)` textually — sees
  // `gate.reasons.*` as referenced. A test pins the two spellings together.
  return t(`gate.reasons.${reason.key}`, params);
}

/** A node's findings as one block of text, one sentence per line. */
export function formatBlockReasons(reasons: readonly BlockReason[], t: TranslateFn): string {
  return reasons.map((reason) => formatBlockReason(reason, t)).join('\n');
}
