import { useTranslation } from 'react-i18next';
import { useAdjustments } from '../contexts/AdjustmentsContext';

/**
 * Small banner shown at the top of adjustment panels when editing an adjustment layer.
 * Shows the layer name so the user knows they're not editing the base.
 */
export function LayerBanner() {
  const { t } = useTranslation();
  const { activeLayerName } = useAdjustments();
  if (!activeLayerName) return null;
  return (
    <div style={{
      fontSize: 11, padding: '3px 8px', marginBottom: 4, borderRadius: 3,
      background: 'rgba(59, 130, 246, 0.15)', color: 'var(--accent, #3b82f6)',
      textAlign: 'center',
    }}>
      {t('uiShell.layerBanner.label', { name: activeLayerName })}
    </div>
  );
}
