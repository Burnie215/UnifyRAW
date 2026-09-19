/**
 * Metadata write-back: UnifyRAW's own photo metadata back into the source.
 *
 * The gate is [writeCapabilitiesOf()](../sources/writeCapabilities.ts) — the
 * one derivation that reads a source's abilities off the methods it actually
 * implements. A field the source cannot take is REPORTED as skipped, never
 * silently dropped; that report is what the toast says out loud.
 *
 * Three fields travel, because three fields have a counterpart:
 *
 *   | UnifyRAW      | call                          |
 *   |---------------|-------------------------------|
 *   | rating 1-5    | `setRating`                   |
 *   | flag `pick`   | `setFavorite(ref, true)`      |
 *   | keywords      | `setTags`                     |
 *
 * Deliberately not pushed:
 *   - **Clearing.** No rating, no flag and an empty keyword list are absences,
 *     not statements: `setTags` overrides the source's whole tag set and
 *     `setFavorite(false)` would undo a favourite the user set in Immich
 *     itself. This push only ever adds what UnifyRAW knows.
 *   - **Colour label and title/description.** No source in the table has a
 *     colour label, and UnifyRAW's catalog carries no title of its own
 *     (`photoMeta` is rating/flag/colourLabel/keywords, catalog-schema.sql:95),
 *     so there is nothing to send — `canSetTitle` keeps no caller here.
 *   - The `reject` flag has no counterpart anywhere. Decision of 2026-09-12:
 *     it travels as the keyword `unifyraw:reject`.
 */
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast, type ToastSpec } from '../components/Toast';
import { sourceManager } from '../sources/SourceManager';
import { writeCapabilitiesOf } from '../sources/writeCapabilities';
import type { PhotoRef, SourceProvider } from '../sources/types';
import type { PhotoFlag } from '../storage/repos/types';

/** Carries the `reject` flag into sources that have no flag of their own. */
export const REJECT_KEYWORD = 'unifyraw:reject';

export type MetadataPushField = 'rating' | 'favorite' | 'keywords';

/** The part of a PhotoView this push reads. */
export interface MetadataPushPhoto {
  sourceId: string;
  sourcePhotoId: string;
  name: string;
  rating: number | null;
  flag: PhotoFlag;
  keywords: string[];
}

/** What one photo has to say to its source. An absent field says nothing. */
export interface MetadataPushPlan {
  /** 1-5. Absent when the photo carries no rating — clearing is not pushed. */
  rating?: number;
  /** Only ever true: `pick` is a statement, the absence of a flag is not. */
  favorite?: true;
  /** Non-empty; `setTags` overrides, so an empty list would wipe source tags. */
  keywords?: string[];
}

export function planMetadataPush(photo: MetadataPushPhoto): MetadataPushPlan {
  const plan: MetadataPushPlan = {};
  if (photo.rating != null && photo.rating >= 1) {
    plan.rating = Math.min(5, Math.round(photo.rating));
  }
  if (photo.flag === 'pick') plan.favorite = true;
  const keywords = photo.flag === 'reject'
    ? [...photo.keywords, REJECT_KEYWORD]
    : photo.keywords;
  const unique = [...new Set(keywords.map((k) => k.trim()).filter(Boolean))];
  if (unique.length > 0) plan.keywords = unique;
  return plan;
}

export function isEmptyPlan(plan: MetadataPushPlan): boolean {
  return plan.rating === undefined && plan.favorite === undefined && plan.keywords === undefined;
}

/** One field the push could not put into one source. */
export interface MetadataPushNote {
  field: MetadataPushField;
  source: string;
}

export interface MetadataPushResult {
  /** Photos that carried at least one pushable field. */
  photos: number;
  /** Field writes the source accepted. */
  applied: number;
  /** Field writes sent — accepted plus rejected, skips excluded. */
  attempted: number;
  /** Field/source pairs the source cannot write at all, deduplicated. */
  skipped: MetadataPushNote[];
  /** Field/source pairs that were sent and came back refused, deduplicated. */
  failed: MetadataPushNote[];
  /** Photos whose source is not connected in this session. */
  offline: number;
}

/**
 * Push the metadata of `photos` into their sources, one photo at a time.
 * Sequential on purpose: these are per-asset API calls against a server the
 * user also browses with, and a selection of 500 fired at once is a way to
 * get rate-limited, not a way to be fast.
 */
export async function pushMetadata(
  photos: readonly MetadataPushPhoto[],
  resolveSource: (sourceId: string) => SourceProvider | undefined,
): Promise<MetadataPushResult> {
  const result: MetadataPushResult = {
    photos: 0, applied: 0, attempted: 0, skipped: [], failed: [], offline: 0,
  };
  const seen: Record<'skipped' | 'failed', Set<string>> = { skipped: new Set(), failed: new Set() };
  const note = (list: 'skipped' | 'failed', field: MetadataPushField, source: string) => {
    const key = `${field}|${source}`;
    if (seen[list].has(key)) return;
    seen[list].add(key);
    result[list].push({ field, source });
  };

  for (const photo of photos) {
    const source = resolveSource(photo.sourceId);
    if (!source) {
      result.offline++;
      continue;
    }
    const plan = planMetadataPush(photo);
    if (isEmptyPlan(plan)) continue;
    result.photos++;

    const caps = writeCapabilitiesOf(source);
    const ref: PhotoRef = {
      sourceId: photo.sourceId,
      sourcePhotoId: photo.sourcePhotoId,
      name: photo.name,
    };
    const write = async (
      field: MetadataPushField,
      allowed: boolean,
      call: () => Promise<boolean | undefined>,
    ) => {
      if (!allowed) {
        note('skipped', field, source.label);
        return;
      }
      result.attempted++;
      let ok = false;
      try {
        ok = (await call()) === true;
      } catch {
        ok = false;
      }
      if (ok) result.applied++;
      else note('failed', field, source.label);
    };

    if (plan.rating !== undefined) {
      await write('rating', caps.canSetRating, () => source.setRating!(ref, plan.rating!));
    }
    if (plan.favorite !== undefined) {
      await write('favorite', caps.canSetFavorite, () => source.setFavorite!(ref, true));
    }
    if (plan.keywords !== undefined) {
      await write('keywords', caps.canSetTags, () => source.setTags!(ref, plan.keywords!));
    }
  }

  return result;
}

/** True when the push had nothing to report beyond plain success. */
export function metadataPushIsClean(result: MetadataPushResult): boolean {
  return result.skipped.length === 0 && result.failed.length === 0 && result.offline === 0;
}

type Translate = (key: string, opts?: Record<string, unknown>) => string;

/** Pure mapping from a push result to one toast that names what was left out. */
export function metadataPushToast(result: MetadataPushResult, t: Translate): ToastSpec {
  const title = t('metadataPush.title');
  if (result.photos === 0 && result.offline === 0) {
    return { title, message: t('metadataPush.nothing'), kind: 'info' };
  }
  const list = (notes: readonly MetadataPushNote[]) => notes
    .map((n) => t('metadataPush.note', {
      field: t(`metadataPush.fields.${n.field}`),
      source: n.source,
    }))
    .join(', ');

  const parts = [t('metadataPush.done', {
    applied: result.applied,
    attempted: result.attempted,
  })];
  if (result.skipped.length > 0) parts.push(t('metadataPush.skipped', { list: list(result.skipped) }));
  if (result.failed.length > 0) parts.push(t('metadataPush.failed', { list: list(result.failed) }));
  if (result.offline > 0) parts.push(t('metadataPush.offline', { photos: result.offline }));

  const kind: ToastSpec['kind'] = result.failed.length > 0
    ? 'error'
    : (result.skipped.length > 0 || result.offline > 0) ? 'warning' : 'info';
  return { title, message: parts.join(' — '), kind };
}

/** True when at least one of the three setters exists on this source. */
export function canPushMetadata(source: SourceProvider | undefined): boolean {
  if (!source) return false;
  const caps = writeCapabilitiesOf(source);
  return caps.canSetRating || caps.canSetFavorite || caps.canSetTags;
}

export interface MetadataPushOptions {
  /**
   * Auto-push mode: stay silent while everything lands, and speak only about
   * skips and failures — deduplicated, so a run of star clicks against an
   * Immich that has no rating does not stack six identical toasts.
   */
  quiet?: boolean;
}

/**
 * `pushMetadata(photos)` wired to the live sources and one toast.
 * Returns the result so a caller can assert on it.
 */
export function useMetadataPush() {
  const { t } = useTranslation();
  const toast = useToast();

  return useCallback(async (
    photos: readonly MetadataPushPhoto[],
    options: MetadataPushOptions = {},
  ): Promise<MetadataPushResult> => {
    const result = await pushMetadata(photos, (id) => sourceManager.get(id));
    if (options.quiet && metadataPushIsClean(result)) return result;
    const spec = metadataPushToast(result, t);
    toast.push(options.quiet
      ? { ...spec, dedupeKey: `metadataPush:${spec.kind}:${spec.message}` }
      : spec);
    return result;
  }, [t, toast]);
}
