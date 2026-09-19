import { useTranslation } from 'react-i18next';
import './ToolStrip.css';

export type EditorTool = 'edit' | 'crop' | 'heal' | 'clone' | 'brush' | 'gradient' | 'radial' | 'straighten' | null;

interface ToolStripProps {
  activeTool: EditorTool;
  onToolChange: (tool: EditorTool) => void;
}

export function ToolStrip({ activeTool, onToolChange }: ToolStripProps) {
  const { t } = useTranslation();
  const toggle = (tool: EditorTool) => {
    onToolChange(activeTool === tool ? null : tool);
  };

  return (
    <div className="tool-strip">
      <button className={`ts-btn ${!activeTool || activeTool === 'edit' ? 'active' : ''}`}
        onClick={() => toggle('edit')} title={t('uiShell.toolStrip.edit')}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
          <path d="M3 13h2l7-7-2-2-7 7v2z" /><path d="M10 4l2 2" />
        </svg>
      </button>
      <button className={`ts-btn ${activeTool === 'crop' ? 'active' : ''}`}
        onClick={() => toggle('crop')} title={t('uiShell.toolStrip.crop')}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
          <path d="M4 1v11h11M1 4h11v11" />
        </svg>
      </button>
      <button className={`ts-btn ${activeTool === 'heal' ? 'active' : ''}`}
        onClick={() => toggle('heal')} title={t('uiShell.toolStrip.heal')}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
          <circle cx="8" cy="8" r="5.5" /><path d="M8 5v6M5 8h6" />
        </svg>
      </button>

      <div className="ts-sep" />

      <button className={`ts-btn ${activeTool === 'brush' ? 'active' : ''}`}
        onClick={() => toggle('brush')} title={t('uiShell.toolStrip.brush')}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
          <path d="M10 2l4 4-8 8H2v-4z" />
        </svg>
      </button>
      <button className={`ts-btn ${activeTool === 'gradient' ? 'active' : ''}`}
        onClick={() => toggle('gradient')} title={t('uiShell.toolStrip.gradient')}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
          <rect x="2" y="2" width="12" height="12" rx="1" /><line x1="8" y1="2" x2="8" y2="14" strokeDasharray="2 2" />
        </svg>
      </button>
      <button className={`ts-btn ${activeTool === 'radial' ? 'active' : ''}`}
        onClick={() => toggle('radial')} title={t('uiShell.toolStrip.radial')}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
          <circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="3" strokeDasharray="2 2" />
        </svg>
      </button>

      <div className="ts-sep" />

      <button className={`ts-btn ${activeTool === 'straighten' ? 'active' : ''}`}
        onClick={() => toggle('straighten')} title={t('uiShell.toolStrip.straighten')}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
          <path d="M2 11l12-6" /><circle cx="2" cy="11" r="1.5" /><circle cx="14" cy="5" r="1.5" />
        </svg>
      </button>
    </div>
  );
}
