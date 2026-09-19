import type { ReactNode } from 'react';
import { BeforeAfter, type CompareMode } from './BeforeAfter';

export function EditorModeSurface({
  renderMode,
  compareMode,
  graphAvailable,
  cropActive,
  graphEditor,
  children,
}: {
  renderMode: 'classic' | 'graph';
  compareMode: CompareMode;
  graphAvailable: boolean;
  cropActive: boolean;
  graphEditor: ReactNode;
  children: ReactNode;
}) {
  const graphSurfaceActive = renderMode === 'graph' && graphAvailable && !cropActive;
  if (!graphSurfaceActive) return children;
  const compareActive = compareMode !== 'off';
  return <>
    <div data-editor-mode-surface="graph" style={{ display: compareActive ? 'none' : 'contents' }}>
      {graphEditor}
    </div>
    {compareActive ? children : null}
  </>;
}

export function EditorImageStage({ width, height, transform, children, compare }: {
  width: number | undefined;
  height: number | undefined;
  transform: string;
  children: ReactNode;
  compare: ReactNode;
}) {
  return <>
    <div className="editor-image-wrapper" style={{ width, height, transform }}>
      {children}
    </div>
    {compare}
  </>;
}

export function EditorCompareOverlay({
  before,
  after,
  beforeGeneration,
  renderGeneration,
  proofFilter,
  mode,
  onModeChange,
  zoom,
  displayWidth,
  displayHeight,
  panX,
  panY,
}: {
  before: HTMLCanvasElement;
  after: HTMLCanvasElement | null;
  beforeGeneration: number;
  renderGeneration: number;
  proofFilter: string;
  mode: CompareMode;
  onModeChange: (mode: CompareMode) => void;
  zoom: number;
  displayWidth: number;
  displayHeight: number;
  panX: number;
  panY: number;
}) {
  return <div
    className="editor-compare-overlay"
    data-coordinate-space="screen"
    style={{
      width: displayWidth,
      height: displayHeight,
      left: `calc(50% + ${panX}px)`,
      top: `calc(50% + ${panY}px)`,
      transform: 'translate(-50%, -50%)',
    }}
  >
    <BeforeAfter
      before={before}
      after={after}
      beforeGeneration={beforeGeneration}
      renderGeneration={renderGeneration}
      proofFilter={proofFilter}
      mode={mode}
      onModeChange={onModeChange}
      zoom={zoom}
    />
  </div>;
}
