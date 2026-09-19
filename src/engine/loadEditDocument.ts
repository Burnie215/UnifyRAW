/**
 * How a stored edit row becomes a document. One place for it: the editor
 * (usePhotoEdits) and the batch export read the same rows and must not
 * render them differently.
 */
import type { Adjustments, CurvePoint } from '../types';
import { defaultAdjustments } from '../types';
import { adjustmentsToDocument, isPhotoDocument, type PhotoDocument } from './DocumentModel';
import { normalizeLoadedDocument } from './layerMasks';

export function migrateAdjustments(adj: Adjustments): Adjustments {
  const result = { ...defaultAdjustments, ...adj };

  if (Array.isArray(result.toneCurve)) {
    const old = result.toneCurve as unknown as CurvePoint[];
    result.toneCurve = {
      rgb: old, luma: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      red: [{ x: 0, y: 0 }, { x: 1, y: 1 }], green: [{ x: 0, y: 0 }, { x: 1, y: 1 }], blue: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    };
  }
  if (result.toneCurve && 'shadows' in result.toneCurve && !('rgb' in result.toneCurve)) {
    const old = result.toneCurve as unknown as { shadows: CurvePoint; darks: CurvePoint; lights: CurvePoint; highlights: CurvePoint };
    const pts: CurvePoint[] = [{ x: 0, y: 0 }, old.shadows, old.darks, old.lights, old.highlights];
    result.toneCurve = {
      rgb: pts, luma: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      red: [{ x: 0, y: 0 }, { x: 1, y: 1 }], green: [{ x: 0, y: 0 }, { x: 1, y: 1 }], blue: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    };
  }

  if (!result.levels) result.levels = defaultAdjustments.levels;
  return result;
}

export function loadDocument(edit: { adjustments: Adjustments; document?: PhotoDocument | null }): PhotoDocument {
  if (edit.document && isPhotoDocument(edit.document)) return normalizeLoadedDocument(edit.document);
  return adjustmentsToDocument(migrateAdjustments(edit.adjustments));
}
