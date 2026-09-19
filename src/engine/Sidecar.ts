/**
 * Sidecar — the one JSON schema for portable edits and catalog metadata.
 *
 * Where the JSON lands is the source's business, not this module's: LocalSource
 * keeps it as the `e` field of its entry in `.photolib/index.json`
 * (SidecarStoreV2), the HTTP providers write `.photolib/<name>.json` next to
 * the photo (`src/sources/sidecarPath.ts`). A sidecar names its photo by
 * contentHash, never by filename.
 */

import type { Adjustments } from '../types';
import type { PhotoColorLabel, PhotoFlag } from '../storage/repos';
import type { PhotoDocument } from './DocumentModel';

export const SIDECAR_VERSION = 1;

export interface SidecarData {
  version: typeof SIDECAR_VERSION;
  contentHash: string;
  edits: SidecarEdit[];
  // Catalog metadata, exactly the four fields PhotoMetaRepository.set takes
  rating?: number;
  flag?: PhotoFlag;
  colorLabel?: PhotoColorLabel;
  keywords?: string[];
  exports?: SidecarExport[];
  updatedAt: number;
}

export interface SidecarEdit {
  copyIndex: number;
  copyName?: string;
  adjustments: Adjustments;
  document?: PhotoDocument;
  updatedAt: number;
}

export interface SidecarExport {
  targetAssetId: string;
  targetSourceId: string;
  /** Mirrors `ExportRow['format']`; `dng` is the linear negative from P10. */
  format: 'jpg' | 'tif' | 'png' | 'dng';
  editStackHash: string;
  filename: string;
  uploadedAt: number;
  bytes: number;
}

/**
 * Serialize a sidecar to JSON string.
 */
export function serializeSidecar(data: SidecarData): string {
  return JSON.stringify(data, null, 2);
}

/**
 * Parse a sidecar JSON string. Returns null if invalid.
 */
export function parseSidecar(json: string): SidecarData | null {
  try {
    const data = JSON.parse(json);
    if (!data || typeof data !== 'object') return null;
    if (data.version !== SIDECAR_VERSION) return null;
    if (!data.contentHash || !Array.isArray(data.edits)) return null;
    return data as SidecarData;
  } catch {
    return null;
  }
}

/**
 * Build SidecarData from DB edit records + photo metadata.
 */
export function buildSidecar(
  contentHash: string,
  edits: { copyIndex: number; copyName?: string; adjustments: Adjustments; document?: PhotoDocument; updatedAt: number }[],
  meta?: { rating?: number; flag?: PhotoFlag; colorLabel?: PhotoColorLabel; keywords?: string[] },
  exports?: SidecarExport[],
): SidecarData {
  return {
    version: SIDECAR_VERSION,
    contentHash,
    edits: edits.map((e) => ({
      copyIndex: e.copyIndex,
      copyName: e.copyName,
      adjustments: e.adjustments,
      document: e.document,
      updatedAt: e.updatedAt,
    })),
    rating: meta?.rating,
    flag: meta?.flag,
    colorLabel: meta?.colorLabel,
    keywords: meta?.keywords,
    exports: exports?.length ? exports : undefined,
    updatedAt: Date.now(),
  };
}

/**
 * Merge sidecar data into local DB edits.
 * Strategy: if sidecar is newer than local for a given copyIndex, use sidecar.
 * Returns the edits that should be applied (sidecar wins if newer).
 */
export function mergeSidecar(
  sidecar: SidecarData,
  localEdits: { copyIndex: number; updatedAt: number }[],
): { editsToApply: SidecarEdit[]; metaToApply: boolean } {
  const localByIndex = new Map(localEdits.map((e) => [e.copyIndex, e.updatedAt]));

  const editsToApply: SidecarEdit[] = [];
  for (const edit of sidecar.edits) {
    const localTime = localByIndex.get(edit.copyIndex);
    if (!localTime || edit.updatedAt > localTime) {
      editsToApply.push(edit);
    }
  }

  // Apply metadata if sidecar is newer than newest local edit
  const newestLocal = Math.max(0, ...localEdits.map((e) => e.updatedAt));
  const metaToApply = sidecar.updatedAt > newestLocal;

  return { editsToApply, metaToApply };
}
