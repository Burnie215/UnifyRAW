/**
 * What the import preset writes for photos an ingest has just created.
 *
 * The decisions live outside the hook so the one that matters can be asked
 * directly, without React: a second scan of the same source must not touch a
 * rating, a flag, a colour label or a keyword the user set in between. Two
 * guards do that. Only rows an ingest created are candidates at all -
 * `planIngest` separates additions from updates, and a rescan produces
 * updates. And even for those a field is only filled when nothing stands
 * there yet, because photoMeta is keyed by content hash: the same bytes can
 * already carry metadata from a second source, from a sidecar or from a sync.
 *
 * Keywords are merged, never replaced, for the same reason.
 */
import type { ImportPreset } from './useImportPreset';
import type { PhotoColorLabel, PhotoMetaRow, PresetRow } from '../storage/repos';
import type { Adjustments } from '../types';
import { createDocument, documentToAdjustments, type PhotoDocument } from '../engine/DocumentModel';
import { applyPresetAsLayer } from '../engine/PresetLayer';

/** A catalog row an ingest has just created. */
export interface AddedPhoto {
  id: number;
  contentHash: string | null;
}

export type ImportMetaPatch = Partial<Pick<PhotoMetaRow, 'rating' | 'flag' | 'colorLabel' | 'keywords'>>;

export interface ImportMetaWrite {
  contentHash: string;
  patch: ImportMetaPatch;
}

export interface ImportEditWrite {
  contentHash: string;
  adjustments: Adjustments;
  document: PhotoDocument;
}

const COLOR_LABELS: readonly string[] = ['red', 'yellow', 'green', 'blue', 'purple'];

/** The preset stores the label as a plain string; only the five the UI offers count. */
function colorLabelOf(value: string | null): PhotoColorLabel {
  return value && COLOR_LABELS.includes(value) ? (value as PhotoColorLabel) : null;
}

function cleanKeywords(keywords: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of keywords) {
    const keyword = raw.trim();
    if (keyword && !out.includes(keyword)) out.push(keyword);
  }
  return out;
}

/**
 * The photoMeta writes an import preset asks for.
 *
 * `existingMeta` is what the catalog already holds for the hashes in `added`;
 * every field it fills is left alone. A rating of 0 means "none" in the tab,
 * so it writes nothing.
 */
export function planImportPresetMeta(
  added: readonly AddedPhoto[],
  preset: ImportPreset,
  existingMeta: ReadonlyMap<string, PhotoMetaRow>,
): ImportMetaWrite[] {
  const rating = preset.defaultRating > 0 ? preset.defaultRating : null;
  const flag = preset.defaultFlag;
  const colorLabel = colorLabelOf(preset.defaultLabel);
  const keywords = cleanKeywords(preset.defaultKeywords);
  if (rating === null && flag === null && colorLabel === null && keywords.length === 0) return [];

  const writes: ImportMetaWrite[] = [];
  const seen = new Set<string>();

  for (const photo of added) {
    const contentHash = photo.contentHash;
    // photoMeta is keyed by content hash. A row ingested without one (most
    // sources hash lazily) cannot be addressed yet and is skipped.
    if (!contentHash || seen.has(contentHash)) continue;
    seen.add(contentHash);

    const existing = existingMeta.get(contentHash) ?? null;
    const patch: ImportMetaPatch = {};
    if (rating !== null && existing?.rating == null) patch.rating = rating;
    if (flag !== null && existing?.flag == null) patch.flag = flag;
    if (colorLabel !== null && existing?.colorLabel == null) patch.colorLabel = colorLabel;

    if (keywords.length > 0) {
      const before = existing?.keywords ?? [];
      const merged = [...before];
      for (const keyword of keywords) if (!merged.includes(keyword)) merged.push(keyword);
      if (merged.length > before.length) patch.keywords = merged;
    }

    if (Object.keys(patch).length > 0) writes.push({ contentHash, patch });
  }

  return writes;
}

/** The preset the import tab names, by name, or null when it is gone. */
export function findDevelopPreset(presets: readonly PresetRow[], name: string): PresetRow | null {
  const wanted = name.trim();
  if (!wanted) return null;
  return presets.find((preset) => preset.name === wanted) ?? null;
}

/**
 * The edit rows that put the import preset's look on new photos.
 *
 * A preset is a replaceable adjustment layer, not a baked-in edit
 * (`applyPresetAsLayer`), so the user can dial it back or drop it per photo.
 * `hashesWithEdits` are the hashes the catalog already has an edit for; they
 * are skipped, because overwriting a develop state is exactly what a second
 * scan must never do.
 */
export function planImportPresetEdits(
  added: readonly AddedPhoto[],
  developPreset: PresetRow | null,
  hashesWithEdits: ReadonlySet<string>,
): ImportEditWrite[] {
  if (!developPreset) return [];

  const writes: ImportEditWrite[] = [];
  const seen = new Set<string>();

  for (const photo of added) {
    const contentHash = photo.contentHash;
    if (!contentHash || seen.has(contentHash) || hashesWithEdits.has(contentHash)) continue;
    seen.add(contentHash);
    const document = applyPresetAsLayer(createDocument(), developPreset);
    writes.push({ contentHash, document, adjustments: documentToAdjustments(document) });
  }

  return writes;
}
