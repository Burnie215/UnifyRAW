import type { Adjustments } from '../types';
import { defaultAdjustments } from '../types';
import {
  ADJUSTMENT_PANEL_FIELDS,
  type AdjustmentPanelId,
} from '../engine/adjustmentFields';

// Compatibility for UI consumers; the ownership table itself lives in engine.
export { ADJUSTMENT_PANEL_FIELDS, type AdjustmentPanelId } from '../engine/adjustmentFields';

function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function cloneDefault<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

export function modifiedAdjustmentPanelIds(adjustments: Adjustments): Set<string> {
  const changed = new Set<string>();
  for (const [panelId, fields] of Object.entries(ADJUSTMENT_PANEL_FIELDS)) {
    if (fields.some((field) => !valuesEqual(adjustments[field], defaultAdjustments[field]))) {
      changed.add(panelId);
    }
  }
  return changed;
}

/** Reset one panel without disturbing adjustments owned by another panel. */
export function resetAdjustmentPanel(adjustments: Adjustments, panelId: string): Adjustments {
  const fields = ADJUSTMENT_PANEL_FIELDS[panelId as AdjustmentPanelId];
  if (!fields) return adjustments;

  let changed = false;
  const next = { ...adjustments };
  const writable = next as unknown as Record<string, unknown>;
  for (const field of fields) {
    const defaultValue = defaultAdjustments[field];
    if (valuesEqual(adjustments[field], defaultValue)) continue;
    changed = true;
    if (defaultValue === undefined) delete writable[field];
    else writable[field] = cloneDefault(defaultValue);
  }
  return changed ? next : adjustments;
}
