import { useMemo } from 'react';

import { panelAdjustmentsForLayer, type DocLayer } from '../engine/DocumentModel';
import type { Adjustments } from '../types';

export function usePanelAdjustments(
  activeIsAdjustmentLayer: boolean,
  activeLayer: DocLayer | null,
  adjustments: Adjustments,
): Adjustments {
  const layerAdjustments = activeLayer?.adjustments;
  const presetSyncId = activeLayer?.presetSyncId;
  return useMemo(
    () => activeIsAdjustmentLayer && layerAdjustments
      ? panelAdjustmentsForLayer({ adjustments: layerAdjustments, presetSyncId }, adjustments)
      : adjustments,
    [activeIsAdjustmentLayer, layerAdjustments, presetSyncId, adjustments],
  );
}
