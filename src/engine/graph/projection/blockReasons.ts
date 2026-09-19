/**
 * What the projection says when it refuses a graph — as a key, not a
 * sentence.
 *
 * The rules that raise these findings are pure engine code: no React, no
 * i18next, no locale. They used to carry finished German sentences, so an
 * English surface showed an English button with a German explanation behind
 * it. Since the engine cannot translate and must not import the surface, it
 * names the finding instead: a stable key plus the values the sentence
 * interpolates. The surface looks the key up (`src/i18n/gateReasons.ts`) and
 * writes it out in the user's language.
 *
 * The key is part of the engine's contract, the wording is not: tests assert
 * on keys, locale files own the sentences, and `gateReasons.test.ts` holds
 * both languages to exactly the list below.
 */

/**
 * Every reason the projection can raise, mapped to the placeholders its
 * sentence interpolates. One flat table so the locale gate has a single
 * list to compare against; the prefix says which rule found it.
 */
export const BLOCK_REASON_PARAMS = {
  // shapeScan: the graph is not shaped like a document.
  'shape.branchOffIntermediate': [],
  'shape.notAStack': [],
  'shape.noImageSource': [],
  'shape.severalImageSources': [],
  'shape.maskNotASource': [],
  'shape.missingInput': [],
  'shape.cycle': [],
  // chainRules: the nodes inside a chain are not admissible.
  'chain.noClassicEquivalent': ['kind'],
  'chain.wrongOrder': ['earlierKind', 'laterKind'],
  'chain.duplicateKind': ['kind'],
  'chain.baseStageKind': ['kind'],
  // paramsToAdjustments: a param no classic control can produce.
  'param.branchDiffers': ['field'],
  'param.cameraMetadata': ['field'],
  'param.lensProfileUnknown': [],
  'param.baseStageEdited': [],
  'param.spaceOverrideAsymmetric': [],
  'param.spaceOverrideConflict': [],
  // projectToDocument: the assembly itself cannot write the document.
  'document.maskWithoutShape': [],
  'document.customHslSplit': [],
} as const satisfies Record<string, readonly string[]>;

export type BlockReasonKey = keyof typeof BLOCK_REASON_PARAMS;

/**
 * One finding, language-free. `params` carries raw values — a node KIND, not
 * a node label — so the surface decides how to spell them.
 */
export interface BlockReason {
  key: BlockReasonKey;
  params?: Readonly<Record<string, string>>;
}

/**
 * Identity of a finding, for de-duplication and for React keys. Two findings
 * are the same one when they will say the same sentence: same key, same
 * placeholder values. Sorted so the order the params were written in cannot
 * split one finding into two.
 */
export function blockReasonId(reason: BlockReason): string {
  const params = reason.params;
  if (!params) return reason.key;
  const entries = Object.keys(params).sort().map((k) => `${k}=${params[k]}`);
  return entries.length === 0 ? reason.key : `${reason.key}(${entries.join(',')})`;
}
