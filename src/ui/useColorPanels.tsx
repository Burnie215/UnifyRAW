import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdjustments } from '../contexts/AdjustmentsContext';
import { CompactSlider as Slider } from './CompactSlider';
import { HSLPanel } from '../components/HSLPanel';
import { ColorGradingPanel } from '../components/ColorGradingPanel';
import { SpaceToggle } from '../components/SpaceToggle';

export interface ColorPanelProps {
  colorPickerActive?: boolean;
  onColorPickerRequest?: (active: boolean) => void;
  pickedColor?: { h: number; s: number; l: number } | null;
  onViewSelectedRange?: (range: { hueCenter: number; hueHalfWidth: number; feather?: number } | null) => void;
  onCustomSectorsUpdate?: (sectors: { hueCenter: number; hueHalfWidth: number; feather: number; dH: number; dS: number; dL: number }[]) => void;
}

/**
 * Panels: hsl, colorgrading, bw
 */
export function useColorPanels(props: ColorPanelProps): Map<string, React.ReactNode> {
  const { t } = useTranslation();
  const { adjustments, set } = useAdjustments();
  const {
    colorPickerActive, onColorPickerRequest, pickedColor,
    onViewSelectedRange, onCustomSectorsUpdate,
  } = props;

  return useMemo(() => {
    const map = new Map<string, React.ReactNode>();

    // HSL
    map.set('hsl', (
      <div>
      <SpaceToggle
        label="HSL"
        value={adjustments.hslSpace}
        onChange={(v) => set('hslSpace', v)}
      />
      <HSLPanel hsl={adjustments.hsl} onChange={(h) => set('hsl', h)}
        pickedColor={pickedColor} onPickerRequest={onColorPickerRequest} pickerActive={colorPickerActive}
        onViewSelectedRange={onViewSelectedRange}
        onCustomSectorsUpdate={onCustomSectorsUpdate}
        colorEditorMode={adjustments.colorEditorMode}
        onColorEditorModeChange={(m) => set('colorEditorMode', m)}
        advancedSectors={adjustments.advancedSectors}
        onAdvancedSectorsChange={(sectors) => set('advancedSectors', sectors)}
        skinToneSector={adjustments.skinToneSector}
        onSkinToneSectorChange={(sector) => set('skinToneSector', sector)}
        skinToneSectors={adjustments.skinToneSectors ?? []}
        onSkinToneSectorsChange={(sectors) => set('skinToneSectors', sectors)}
        skinToneUniformity={adjustments.skinToneUniformity}
        onSkinToneUniformityChange={(u) => set('skinToneUniformity', u)} />
      </div>
    ));

    // Color Grading
    map.set('colorgrading', (
      <div>
        <SpaceToggle
          label="Color Grading"
          value={adjustments.colorGradingSpace}
          onChange={(v) => set('colorGradingSpace', v)}
        />
        <ColorGradingPanel grading={adjustments.colorGrading} onChange={(g) => set('colorGrading', g)} />
      </div>
    ));

    // B&W Mix
    map.set('bw', (
      <>
        {adjustments.bwEnabled ? (
          <>
            <Slider label={t('uiShell.colorPanels.red')} value={adjustments.bwMix.red} min={-100} max={100} onChange={(v) => set('bwMix', { ...adjustments.bwMix, red: v })} />
            <Slider label={t('uiShell.colorPanels.orange')} value={adjustments.bwMix.orange} min={-100} max={100} onChange={(v) => set('bwMix', { ...adjustments.bwMix, orange: v })} />
            <Slider label={t('uiShell.colorPanels.yellow')} value={adjustments.bwMix.yellow} min={-100} max={100} onChange={(v) => set('bwMix', { ...adjustments.bwMix, yellow: v })} />
            <Slider label={t('uiShell.colorPanels.green')} value={adjustments.bwMix.green} min={-100} max={100} onChange={(v) => set('bwMix', { ...adjustments.bwMix, green: v })} />
            <Slider label={t('uiShell.colorPanels.aqua')} value={adjustments.bwMix.aqua} min={-100} max={100} onChange={(v) => set('bwMix', { ...adjustments.bwMix, aqua: v })} />
            <Slider label={t('uiShell.colorPanels.blue')} value={adjustments.bwMix.blue} min={-100} max={100} onChange={(v) => set('bwMix', { ...adjustments.bwMix, blue: v })} />
            <Slider label={t('uiShell.colorPanels.purple')} value={adjustments.bwMix.purple} min={-100} max={100} onChange={(v) => set('bwMix', { ...adjustments.bwMix, purple: v })} />
            <Slider label={t('uiShell.colorPanels.magenta')} value={adjustments.bwMix.magenta} min={-100} max={100} onChange={(v) => set('bwMix', { ...adjustments.bwMix, magenta: v })} />
          </>
        ) : (
          <div className="bw-inactive-hint">{t('uiShell.colorPanels.bwInactiveHint')}</div>
        )}
      </>
    ));

    return map;
  }, [
    t, adjustments, set, colorPickerActive, pickedColor,
    onColorPickerRequest, onViewSelectedRange, onCustomSectorsUpdate,
  ]);
}
