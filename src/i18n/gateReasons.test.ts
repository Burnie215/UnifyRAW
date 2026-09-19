/**
 * The gate on the gate: every reason the projection can raise has a sentence
 * in EVERY language, with exactly the placeholders the engine declares, and
 * no language carries a sentence for a reason that no longer exists.
 *
 * This is the test the engine cannot write for itself. `locales.test.ts`
 * catches a key the source asks for by name, but these keys are built at
 * runtime from `BlockReason.key`, so a rule could name a reason nobody ever
 * translated and nothing would notice until an empty tooltip showed up in the
 * editor. Here the engine's own list is the yardstick.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BLOCK_REASON_PARAMS, blockReasonId, type BlockReason, type BlockReasonKey } from '../engine/graph/projection/blockReasons';
import { CHAIN_REASONS } from '../engine/graph/projection/chainRules';
import { SHAPE_REASONS } from '../engine/graph/projection/shapeScan';
import { PARAM_REASONS } from '../engine/graph/projection/paramsToAdjustments';
import { DOCUMENT_REASONS } from '../engine/graph/projection/projectToDocument';
import { flattenKeys } from './i18nCatalog';
import { allGateReasonKeys, formatBlockReason, gateReasonKey, GATE_REASON_PREFIX } from './gateReasons';
import type { LocaleTree } from './mergeLocales';

const I18N_DIR = path.dirname(fileURLToPath(import.meta.url));
const LANGUAGES = ['de', 'en'] as const;

function gateLocale(lang: string): LocaleTree {
  return JSON.parse(readFileSync(path.join(I18N_DIR, 'locales', lang, 'gate.json'), 'utf8'));
}

/** `gate.reasons.<group>.<name>` -> sentence, per language. */
const sentences = Object.fromEntries(
  LANGUAGES.map((lang) => [lang, flattenKeys(gateLocale(lang))]),
) as Record<typeof LANGUAGES[number], Map<string, unknown>>;

function placeholdersIn(sentence: string): string[] {
  return [...sentence.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
}

/** A stand-in for i18next: looks the key up and interpolates `{{name}}`. */
function translate(lang: typeof LANGUAGES[number]) {
  return (key: string, params?: Record<string, string>): string => {
    const raw = sentences[lang].get(key);
    if (typeof raw !== 'string') throw new Error(`no ${lang} sentence for ${key}`);
    return raw.replace(/\{\{(\w+)\}\}/g, (_, name: string) => params?.[name] ?? `{{${name}}}`);
  };
}

describe('gate reason keys', () => {
  it('builds the locale key from the engine key', () => {
    expect(GATE_REASON_PREFIX).toBe('gate.reasons.');
    expect(gateReasonKey('shape.cycle')).toBe('gate.reasons.shape.cycle');
  });

  for (const lang of LANGUAGES) {
    it(`has a ${lang} sentence for every reason the projection can raise`, () => {
      const missing = allGateReasonKeys()
        .filter((key) => typeof sentences[lang].get(gateReasonKey(key)) !== 'string');
      expect(missing).toEqual([]);
    });

    it(`has no ${lang} sentence left over from a retired reason`, () => {
      const declared = new Set(allGateReasonKeys().map(gateReasonKey));
      const stale = [...sentences[lang].keys()].filter((key) => !declared.has(key));
      expect(stale.sort()).toEqual([]);
    });

    it(`interpolates exactly the placeholders the engine declares in ${lang}`, () => {
      for (const key of allGateReasonKeys()) {
        const sentence = sentences[lang].get(gateReasonKey(key));
        // Guarded so a key that is missing entirely fails here as a sentence
        // about the key, not as a TypeError inside the matcher.
        expect(typeof sentence, `${lang} ${key}`).toBe('string');
        expect(placeholdersIn(sentence as string), `${lang} ${key}`)
          .toEqual([...BLOCK_REASON_PARAMS[key]].sort());
      }
    });
  }
});

describe('formatBlockReason', () => {
  it('spells a node kind the way the rest of the editor spells it', () => {
    const reason = CHAIN_REASONS.noClassicEquivalent('__customLut');
    expect(formatBlockReason(reason, translate('de')))
      .toBe('Custom Lut hat in der klassischen Ansicht keine Entsprechung.');
    expect(formatBlockReason(reason, translate('en')))
      .toBe('Custom Lut has no equivalent in the classic view.');
  });

  it('quotes a param name verbatim instead of reading it as a kind', () => {
    const reason = PARAM_REASONS.branchDiffers('flipH');
    expect(formatBlockReason(reason, translate('de'))).toContain('„flipH"');
    expect(formatBlockReason(reason, translate('en'))).toContain('"flipH"');
  });

  it('fills both places of the order rule', () => {
    const reason = CHAIN_REASONS.wrongOrder('__transform', '__tone');
    expect(formatBlockReason(reason, translate('en')))
      .toBe('Transform comes before Tone; the classic view has a fixed order.');
  });

  it('leaves a reason without params alone', () => {
    expect(formatBlockReason(SHAPE_REASONS.cycle, translate('en')))
      .toBe('This node sits in a cycle; a layer chain always runs one way.');
    expect(formatBlockReason(DOCUMENT_REASONS.customHslSplit, translate('en')))
      .toBe('The color ranges cannot be split across the three lists of the classic view.');
  });
});

describe('blockReasonId', () => {
  it('tells two findings of the same rule apart by their params', () => {
    expect(blockReasonId(PARAM_REASONS.branchDiffers('flipH')))
      .not.toBe(blockReasonId(PARAM_REASONS.branchDiffers('flipV')));
  });

  it('gives the same finding the same id whatever order the params came in', () => {
    const a: BlockReason = { key: 'chain.wrongOrder', params: { earlierKind: 'a', laterKind: 'b' } };
    const b: BlockReason = { key: 'chain.wrongOrder', params: { laterKind: 'b', earlierKind: 'a' } };
    expect(blockReasonId(a)).toBe(blockReasonId(b));
  });

  it('is the bare key when there is nothing to interpolate', () => {
    expect(blockReasonId(SHAPE_REASONS.noImageSource)).toBe('shape.noImageSource');
  });
});

describe('the reason tables', () => {
  it('raise only keys the engine declares', () => {
    const declared = new Set<string>(allGateReasonKeys());
    const raised: BlockReasonKey[] = [
      ...Object.values(SHAPE_REASONS).map((r) => r.key),
      ...Object.values(DOCUMENT_REASONS).map((r) => r.key),
      CHAIN_REASONS.noClassicEquivalent('k').key,
      CHAIN_REASONS.wrongOrder('a', 'b').key,
      CHAIN_REASONS.duplicateKind('k').key,
      CHAIN_REASONS.baseStageKind('k').key,
      PARAM_REASONS.branchDiffers('f').key,
      PARAM_REASONS.cameraMetadata('f').key,
      PARAM_REASONS.lensProfileUnknown.key,
      PARAM_REASONS.baseStageEdited.key,
      PARAM_REASONS.spaceOverrideAsymmetric.key,
      PARAM_REASONS.spaceOverrideConflict.key,
    ];
    expect(raised.filter((key) => !declared.has(key))).toEqual([]);
    // And the declaration has nothing the tables never raise.
    expect([...declared].filter((key) => !raised.includes(key as BlockReasonKey)).sort())
      .toEqual([]);
  });
});
