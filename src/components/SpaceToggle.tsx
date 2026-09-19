/**
 * Phase 3 per-pass color-space toggle.
 *
 * Sits at the top of ToneCurve / ColorGrading / HSL tabs. When set, the
 * adjustment runs in the chosen space (overriding the graph default —
 * Phase 2's linear math). Undefined = graph default.
 *
 * The control surface is intentionally small: a two-button segmented
 * control with a "↻" reset chip beside it. Tooltip explains the trade-off:
 * linear is physically correct; gamma matches legacy looks (Lightroom,
 * Photoshop) and is preferred for some aesthetic effects.
 */
import { useTranslation } from 'react-i18next';

export interface SpaceToggleProps {
  label: string;
  value: 'linear' | 'gamma' | undefined;
  onChange: (value: 'linear' | 'gamma' | undefined) => void;
}

/**
 * Phase 2 LIN-Badge — small live indicator showing the *effective* space
 * a pass runs in. Sits anywhere in a tab header so users see at a glance
 * whether their override is active and what the underlying default is.
 */
export function SpaceBadge({ effective }: { effective: 'linear' | 'gamma' }) {
  const { t } = useTranslation();
  const isLinear = effective === 'linear';
  return (
    <span
      title={isLinear ? t('panels.spaceToggle.badgeLinear') : t('panels.spaceToggle.badgeGamma')}
      style={{
        display: 'inline-block',
        padding: '1px 5px',
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: 0.5,
        borderRadius: 2,
        background: isLinear ? 'rgba(74, 158, 255, 0.2)' : 'rgba(245, 166, 35, 0.2)',
        color: isLinear ? '#4a9eff' : '#f5a623',
        border: `1px solid ${isLinear ? 'rgba(74, 158, 255, 0.4)' : 'rgba(245, 166, 35, 0.4)'}`,
      }}
    >
      {isLinear ? 'LIN' : 'GAMMA'}
    </span>
  );
}

export function SpaceToggle({ label, value, onChange }: SpaceToggleProps) {
  const { t } = useTranslation();
  const tooltip = t('panels.spaceToggle.tooltip', { label });
  return (
    <div
      className="space-toggle"
      title={tooltip}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        justifyContent: 'flex-end', marginBottom: 6, fontSize: 11,
      }}
    >
      <span style={{ color: 'var(--text-tertiary, #888)', marginRight: 4 }}>
        {t('panels.spaceToggle.label')}
      </span>
      {/* LIN-badge shows the effective space. Phase 2 default is linear;
       *  user override flips it. When 'Auto' is selected we still show LIN
       *  since that's the underlying graph default. */}
      <SpaceBadge effective={value ?? 'linear'} />
      <span style={{ width: 4 }} />
      <div className="seg">
      <SegmentButton
        active={value === undefined}
        onClick={() => onChange(undefined)}
        title={t('panels.spaceToggle.auto')}
      >
        Auto
      </SegmentButton>
      <SegmentButton
        active={value === 'linear'}
        onClick={() => onChange('linear')}
      >
        Linear
      </SegmentButton>
      <SegmentButton
        active={value === 'gamma'}
        onClick={() => onChange('gamma')}
      >
        Gamma
      </SegmentButton>
      </div>
      {value !== undefined && (
        <button
          type="button"
          onClick={() => onChange(undefined)}
          title={t('panels.spaceToggle.reset')}
          style={{
            marginLeft: 2, padding: '2px 5px', fontSize: 11, lineHeight: 1,
            background: 'transparent', border: '1px solid var(--border-subtle, #333)',
            color: 'var(--text-tertiary, #888)', borderRadius: 3, cursor: 'pointer',
          }}
        >↻</button>
      )}
    </div>
  );
}

function SegmentButton({
  active, onClick, title, children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`seg-btn ${active ? 'active' : ''}`}
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  );
}
