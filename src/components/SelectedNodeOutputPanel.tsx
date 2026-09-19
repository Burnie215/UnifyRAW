/**
 * Right-rail panel that visualises the pipeline state at the currently
 * selected node. Renders a preview thumbnail through the same worker
 * pipeline as the in-canvas preview-tap nodes, and a histogram derived
 * from that preview.
 *
 * With nothing selected it falls back to the graph's terminal node, so the
 * panel answers "what does this pipeline currently produce?" instead of going
 * blank - that is the picture you want while wiring nodes up.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { nodeKindLabel, type RenderNode, type RenderGraph } from '../engine/graph';
import { useNodePreview } from '../hooks/useNodePreview';
import type { PreviewMaskLayer } from '../hooks/usePreviewTapRenderer';
import type { RawPixelData } from '../engine/raw/RawDecoderStrategy';
import { drawHistogram, histogramFromUrl, type HistogramBins } from '../image/histogram';
import { useSettings } from '../contexts/SettingsContext';

export interface SelectedNodeOutputPanelProps {
  graph: RenderGraph;
  node: RenderNode | null;
  sourceUrl?: string | null;
  /** The photo's 16-bit pixels, when it has them: a RAW graph takes no JPEG. */
  rawPixels?: RawPixelData | null;
  /** Rasterized-mask inputs for the graph's `mask:<layerId>` source nodes. */
  maskLayers?: readonly PreviewMaskLayer[];
}

export function SelectedNodeOutputPanel({ graph, node, sourceUrl, rawPixels, maskLayers }: SelectedNodeOutputPanelProps) {
  const { t } = useTranslation();
  const { histogramStyle } = useSettings();
  // Deliberately its own state: selecting a node in the canvas must not yank
  // the panel away from the final image, which is the reference you compare
  // everything else against.
  const [mode, setMode] = useState<'final' | 'selected'>('final');
  const finalNode = graph.nodes.get(graph.output) ?? null;
  const shown = mode === 'final' ? finalNode : node;
  const isFinal = mode === 'final' && !!finalNode;
  const { url, loading } = useNodePreview(
    graph, shown?.id ?? null, sourceUrl ?? null, maskLayers, rawPixels ?? null);
  const [bins, setBins] = useState<HistogramBins | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Recompute histogram whenever the preview URL changes.
  useEffect(() => {
    let cancelled = false;
    if (!url) { setBins(null); return; }
    void histogramFromUrl(url).then((b) => { if (!cancelled) setBins(b); });
    return () => { cancelled = true; };
  }, [url]);

  // Paint histogram into the canvas.
  useEffect(() => {
    const c = canvasRef.current; if (!c) return;
    const ctx = c.getContext('2d'); if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    if (c.width !== W * dpr) c.width = W * dpr;
    if (c.height !== H * dpr) c.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!bins) {
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#222'; ctx.fillRect(0, 0, W, H);
      return;
    }
    drawHistogram(ctx, bins, W, H, histogramStyle);
  }, [bins, histogramStyle]);

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>{t('graphEditor.output.title')}</div>
      <div style={switchStyle} role="group" aria-label={t('graphEditor.output.choose')}>
        <button
          style={mode === 'final' ? switchBtnActiveStyle : switchBtnStyle}
          aria-pressed={mode === 'final'}
          data-testid="graph-output-final"
          onClick={() => setMode('final')}
        >{t('graphEditor.output.final')}</button>
        <button
          style={mode === 'selected' ? switchBtnActiveStyle : switchBtnStyle}
          aria-pressed={mode === 'selected'}
          data-testid="graph-output-selected"
          onClick={() => setMode('selected')}
        >{t('graphEditor.output.selected')}</button>
      </div>
      {!shown ? (
        <div style={emptyStyle}>{t('graphEditor.inspector.empty')}</div>
      ) : (
        <>
          <div style={sectionLabelStyle}>
            {isFinal ? `${t('graphEditor.output.final')} · ${nodeKindLabel(shown.kind)}` : nodeKindLabel(shown.kind)}
          </div>
          <div style={thumbWrap}>
            {url ? (
              <img src={url} alt="Preview" style={thumbImg} />
            ) : (
              <div style={thumbPlaceholder}>{loading ? t('graphEditor.output.rendering') : '–'}</div>
            )}
          </div>
          <div style={sectionLabelStyle}>{t('panels.histogram.title')}</div>
          <canvas ref={canvasRef} style={histogramCanvasStyle} />
        </>
      )}
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  width: 280,
  borderLeft: '1px solid var(--border-subtle, #333)',
  background: 'var(--bg-panel, #1f1f1f)',
  display: 'flex', flexDirection: 'column', minHeight: 0, flexShrink: 0,
  padding: 8, gap: 6, overflowY: 'auto',
};

const headerStyle: React.CSSProperties = {
  fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5,
  color: 'var(--text-tertiary, #888)', padding: '4px 0',
  borderBottom: '1px solid var(--border-subtle, #333)', marginBottom: 4,
};

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 11, color: 'var(--text-secondary, #ccc)', fontWeight: 600,
  padding: '4px 0 2px',
};

const switchStyle: React.CSSProperties = {
  display: 'flex', gap: 2, padding: '2px', marginBottom: 6,
  background: 'var(--bg-tertiary, #222)', borderRadius: 4,
};

const switchBtnStyle: React.CSSProperties = {
  flex: 1, minWidth: 0, padding: '3px 4px', fontSize: 10,
  border: 'none', borderRadius: 3, cursor: 'pointer',
  background: 'none', color: 'var(--text-tertiary, #888)',
};

const switchBtnActiveStyle: React.CSSProperties = {
  ...switchBtnStyle,
  background: 'var(--bg-active, #333)',
  color: 'var(--accent, #4a9eff)',
  fontWeight: 600,
};

const emptyStyle: React.CSSProperties = {
  fontSize: 11, color: 'var(--text-tertiary, #888)', padding: 8,
};

const thumbWrap: React.CSSProperties = {
  width: '100%', aspectRatio: '3 / 2',
  background: '#111', border: '1px solid var(--border-subtle, #333)',
  borderRadius: 3, overflow: 'hidden',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};

const thumbImg: React.CSSProperties = {
  width: '100%', height: '100%', objectFit: 'contain',
};

const thumbPlaceholder: React.CSSProperties = {
  fontSize: 10, color: '#666',
};

const histogramCanvasStyle: React.CSSProperties = {
  width: '100%', height: 90,
  border: '1px solid var(--border-subtle, #333)', borderRadius: 3,
  background: '#222',
};
