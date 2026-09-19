import { useTranslation } from 'react-i18next';
import type { MaskType } from '../engine/Mask';
import type { SegmentationType } from '../engine/ai';
import './MaskToolbar.css';

interface MaskToolbarProps {
  activeTool: MaskType | 'spot-heal' | 'spot-clone' | null;
  onSelectTool: (tool: MaskType | 'spot-heal' | 'spot-clone' | null) => void;
  brushRadius: number;
  brushFeather: number;
  brushFlow: number;
  brushErase: boolean;
  onBrushRadiusChange: (r: number) => void;
  onBrushFeatherChange: (f: number) => void;
  onBrushFlowChange: (f: number) => void;
  onBrushEraseToggle: () => void;
  showMaskOverlay: boolean;
  onToggleMaskOverlay: () => void;
  onAIMask?: (type: SegmentationType) => void;
  aiLoading?: boolean;
}

export function MaskToolbar({
  activeTool, onSelectTool, onAIMask, aiLoading,
  brushRadius, brushFeather, brushFlow, brushErase,
  onBrushRadiusChange, onBrushFeatherChange, onBrushFlowChange, onBrushEraseToggle,
  showMaskOverlay, onToggleMaskOverlay,
}: MaskToolbarProps) {
  const { t } = useTranslation();
  const isBrushTool = activeTool === 'brush' || activeTool === 'spot-heal' || activeTool === 'spot-clone';

  return (
    <div className="mask-toolbar">
      <div className="mask-tools">
        <button className={`mask-tool-btn ${activeTool === 'brush' ? 'active' : ''}`}
          onClick={() => onSelectTool(activeTool === 'brush' ? null : 'brush')} title={t('panels.masks.toolBrush')}>
          <BrushIcon />
        </button>
        <button className={`mask-tool-btn ${activeTool === 'linear-gradient' ? 'active' : ''}`}
          onClick={() => onSelectTool(activeTool === 'linear-gradient' ? null : 'linear-gradient')} title={t('panels.masks.toolLinearGradient')}>
          <GradientIcon />
        </button>
        <button className={`mask-tool-btn ${activeTool === 'radial-gradient' ? 'active' : ''}`}
          onClick={() => onSelectTool(activeTool === 'radial-gradient' ? null : 'radial-gradient')} title={t('panels.masks.toolRadialGradient')}>
          <RadialIcon />
        </button>
        <button className={`mask-tool-btn ${activeTool === 'luminance-range' ? 'active' : ''}`}
          onClick={() => onSelectTool(activeTool === 'luminance-range' ? null : 'luminance-range')} title={t('panels.masks.toolLuminanceMask')}>
          <LuminanceIcon />
        </button>
        <button className={`mask-tool-btn ${activeTool === 'color-range' ? 'active' : ''}`}
          onClick={() => onSelectTool(activeTool === 'color-range' ? null : 'color-range')} title={t('panels.masks.toolColorMask')}>
          <ColorIcon />
        </button>

        <div className="mask-tool-separator" />

        <button className={`mask-tool-btn ${activeTool === 'spot-heal' ? 'active' : ''}`}
          onClick={() => onSelectTool(activeTool === 'spot-heal' ? null : 'spot-heal')} title={t('panels.masks.toolHeal')}>
          <HealIcon />
        </button>
        <button className={`mask-tool-btn ${activeTool === 'spot-clone' ? 'active' : ''}`}
          onClick={() => onSelectTool(activeTool === 'spot-clone' ? null : 'spot-clone')} title={t('panels.masks.toolClone')}>
          <CloneIcon />
        </button>

        <div className="mask-tool-separator" />

        <button className={`mask-tool-btn ${showMaskOverlay ? 'active' : ''}`}
          onClick={onToggleMaskOverlay} title={t('panels.masks.toolToggleOverlay')}>
          <OverlayIcon />
        </button>

        {onAIMask && (
          <>
            <div className="mask-tool-separator" />
            <button className="mask-tool-btn ai" onClick={() => onAIMask('subject')} disabled={aiLoading}
              title={t('panels.masks.aiSubject')}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                <rect x="3" y="3" width="10" height="10" rx="2" strokeDasharray="2 2" />
                <circle cx="8" cy="8" r="3" />
              </svg>
            </button>
            <button className="mask-tool-btn ai" onClick={() => onAIMask('background')} disabled={aiLoading}
              title={t('panels.masks.aiBackground')}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                <rect x="2" y="2" width="12" height="12" rx="1" />
                <circle cx="8" cy="8" r="3" fill="currentColor" opacity="0.3" />
              </svg>
            </button>
            <button className="mask-tool-btn ai" onClick={() => onAIMask('foreground')} disabled={aiLoading}
              title={t('panels.masks.aiForeground')}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                <rect x="4" y="4" width="8" height="8" rx="1" />
                <path d="M2 14V2h12" strokeDasharray="2 2" />
              </svg>
            </button>
            <button className="mask-tool-btn ai" onClick={() => onAIMask('sky')} disabled={aiLoading}
              title={t('panels.masks.aiSky')}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                <path d="M1 10c2-4 4-6 7-6s5 3 7 6" /><circle cx="12" cy="4" r="2" />
              </svg>
            </button>
            <button className="mask-tool-btn ai" onClick={() => onAIMask('person')} disabled={aiLoading}
              title={t('panels.masks.aiPerson')}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                <circle cx="8" cy="5" r="3" /><path d="M3 14c0-3 2.5-5 5-5s5 2 5 5" />
              </svg>
            </button>
            <button className="mask-tool-btn ai" onClick={() => onAIMask('animal')} disabled={aiLoading}
              title={t('panels.masks.aiAnimal')}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                <circle cx="5" cy="4" r="1.5" /><circle cx="11" cy="4" r="1.5" />
                <ellipse cx="8" cy="10" rx="5" ry="4" />
                <circle cx="8" cy="9" r="1" />
              </svg>
            </button>
            {aiLoading && <span className="ai-loading-text">{t('panels.masks.analyzing')}</span>}
          </>
        )}
      </div>

      {isBrushTool && (
        <div className="brush-settings">
          <div className="brush-setting">
            <label>{t('panels.masks.brushSize')}</label>
            <input type="range" min={1} max={200} value={brushRadius} onChange={(e) => onBrushRadiusChange(Number(e.target.value))} />
            <span>{brushRadius}px</span>
          </div>
          <div className="brush-setting">
            <label>{t('panels.masks.brushFeather')}</label>
            <input type="range" min={0} max={100} value={brushFeather * 100} onChange={(e) => onBrushFeatherChange(Number(e.target.value) / 100)} />
            <span>{Math.round(brushFeather * 100)}%</span>
          </div>
          <div className="brush-setting">
            <label>{t('panels.masks.brushFlow')}</label>
            <input type="range" min={1} max={100} value={brushFlow * 100} onChange={(e) => onBrushFlowChange(Number(e.target.value) / 100)} />
            <span>{Math.round(brushFlow * 100)}%</span>
          </div>
          {activeTool === 'brush' && (
            <button className={`brush-erase-btn ${brushErase ? 'active' : ''}`} onClick={onBrushEraseToggle}
              title={brushErase ? t('panels.masks.brushSwitchToPaint') : t('panels.masks.brushSwitchToErase')}>
              {brushErase ? t('panels.masks.brushErase') : t('panels.masks.brushPaint')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function BrushIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M10 2l4 4-8 8H2v-4z" /><path d="M8 4l4 4" /></svg>;
}
function GradientIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="2" y="2" width="12" height="12" rx="1" /><line x1="8" y1="2" x2="8" y2="14" strokeDasharray="2 2" /></svg>;
}
function RadialIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><circle cx="8" cy="8" r="6" /><circle cx="8" cy="8" r="3" strokeDasharray="2 2" /></svg>;
}
function LuminanceIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="2" y="4" width="12" height="8" rx="1" /><path d="M2 8h12" /><path d="M5 4v8M11 4v8" strokeDasharray="1 2" /></svg>;
}
function ColorIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><circle cx="6" cy="7" r="4" /><circle cx="10" cy="7" r="4" /></svg>;
}
function HealIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><circle cx="8" cy="8" r="6" /><path d="M8 5v6M5 8h6" /></svg>;
}
function CloneIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="1" y="4" width="8" height="8" rx="1" /><rect x="5" y="1" width="8" height="8" rx="1" strokeDasharray="2 2" /></svg>;
}
function OverlayIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="2" y="2" width="12" height="12" rx="1" /><path d="M2 8h12" opacity="0.5" /><path d="M8 2v12" opacity="0.5" /></svg>;
}
