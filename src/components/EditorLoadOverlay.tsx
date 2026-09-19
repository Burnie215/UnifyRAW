import './EditorLoadOverlay.css';

export interface EditorLoadStep {
  /** Index of this step in the overall sequence (1-based). */
  index: number;
  /** Total number of steps. */
  total: number;
  /** Human-readable label for the current step (e.g. "RAW aufbereiten"). */
  label: string;
  /** Optional hint of the next step. Empty / null when this is the last. */
  next: string | null;
}

/**
 * Editor loading overlay. Shows the current decode phase + a progress
 * indicator while RAW/HEIF files are being prepared.
 *
 * The overlay is intentionally NON-blocking visually: small panel in the
 * lower-right, dark background, semi-transparent. Doesn't intercept clicks.
 */
export function EditorLoadOverlay({ step }: { step: EditorLoadStep | null }) {
  if (!step) return null;
  const pct = Math.round((step.index / step.total) * 100);

  return (
    <div className="editor-load-overlay" role="status" aria-live="polite">
      <div className="editor-load-panel">
        <div className="editor-load-header">
          <span className="editor-load-step">Schritt {step.index} / {step.total}</span>
          <span className="editor-load-pct">{pct}%</span>
        </div>
        <div className="editor-load-label">{step.label}…</div>
        {step.next && (
          <div className="editor-load-next">Als nächstes: {step.next}</div>
        )}
        <div className="editor-load-bar">
          <div className="editor-load-bar-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}
