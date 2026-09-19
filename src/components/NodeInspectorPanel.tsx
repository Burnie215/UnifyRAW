/**
 * Right-rail inspector for the currently-selected graph node. Renders a
 * generic form from the kind's JSON-schema — works for every registered
 * NodeKind without bespoke per-kind UI code.
 *
 * Phase 4 MVP-form coverage:
 *   - number / integer → range slider + numeric input
 *   - boolean         → checkbox
 *   - string (enum)   → select dropdown
 *   - string          → text input
 *   - object          → nested fieldset (recursive)
 *
 * A number without both `minimum` and `maximum` gets a plain field, NOT a
 * slider: a slider needs a scale, and the one time this file guessed one
 * (±100 in steps of two) the lens node's coefficients became undialable and
 * its strength flipped between 0 and 2 (F018). Bounded numbers step in 1/200
 * of their range unless the schema names a `multipleOf`.
 *
 * Arrays + Float32Array params (curve points) fall through to a read-only
 * summary. The one array a user can actually supply is the custom LUT's
 * samples, and that has a `.cube` file field of its own above the form.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RenderNode } from '../engine/graph';
import {
  getMainThreadNodeRegistry, nodeKindLabel,
  KIND_CUSTOM_LUT, MAX_INLINE_LUT_SIZE, lutSampleCount, parseCubeFile,
} from '../engine/graph';
import { hasTailoredInspector, NodeAdjustmentInspector } from './NodeAdjustmentInspectors';
import { CompactSlider as Slider } from '../ui/CompactSlider';

export interface NodeInspectorPanelProps {
  node: RenderNode | null;
  onParamsChange: (params: unknown) => void;
  onDelete?: () => void;
  /** Render-mode. 'rail' = side column. 'floating' = popover styled with
   *  border + shadow, designed for absolute positioning. */
  variant?: 'rail' | 'floating';
  /** Which side the rail sits on — controls which edge gets the divider line.
   *  Ignored in floating mode. */
  railSide?: 'left' | 'right';
  /** Close button for the floating popover. Ignored in rail mode. */
  onClose?: () => void;
}

export function NodeInspectorPanel({
  node, onParamsChange, onDelete, variant = 'rail', railSide = 'right', onClose,
}: NodeInspectorPanelProps) {
  const { t } = useTranslation();
  const registry = getMainThreadNodeRegistry();
  const kind = useMemo(() => node ? registry.get(node.kind) ?? null : null, [node, registry]);
  const style = variant === 'floating'
    ? floatingPanelStyle
    : railSide === 'left' ? leftRailPanelStyle : panelStyle;

  if (!node) {
    return (
      <div style={style}>
        <div style={{ padding: 12, color: 'var(--text-tertiary, #888)', fontSize: 11 }}>
          {t('graphEditor.inspector.empty')}
        </div>
      </div>
    );
  }

  return (
    <div style={style}>
      <div style={{
        padding: '8px 10px', borderBottom: '1px solid var(--border-subtle, #333)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary, #eee)' }}>
            {nodeKindLabel(node.kind)}
          </div>
          <div style={{ fontSize: 9, color: 'var(--text-tertiary, #888)' }}>{node.id}</div>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {onDelete && (
            <button
              onClick={onDelete}
              style={{
                padding: '2px 8px', fontSize: 10,
                background: 'transparent', border: '1px solid var(--border-subtle, #555)',
                color: 'var(--text-secondary, #e74c3c)', borderRadius: 3, cursor: 'pointer',
              }}
            >{t('common.delete')}</button>
          )}
          {variant === 'floating' && onClose && (
            <button
              onClick={onClose}
              title={t('common.close')}
              style={{
                width: 22, height: 22, padding: 0, fontSize: 14, lineHeight: 1,
                background: 'transparent', border: '1px solid var(--border-subtle, #555)',
                color: 'var(--text-secondary, #ccc)', borderRadius: 3, cursor: 'pointer',
              }}
            >×</button>
          )}
        </div>
      </div>
      <div style={{ padding: 8, overflowY: 'auto' }}>
        {node.kind === KIND_CUSTOM_LUT && (
          <CustomLutFileField
            params={node.params as Record<string, unknown>}
            onParamsChange={onParamsChange}
          />
        )}
        {hasTailoredInspector(node.kind) ? (
          <NodeAdjustmentInspector node={node} onParamsChange={onParamsChange} />
        ) : kind ? (
          <SchemaForm
            schema={kind.paramSchema}
            value={node.params as Record<string, unknown>}
            onChange={onParamsChange}
          />
        ) : (
          <div style={{ fontSize: 11, color: 'var(--text-tertiary, #888)' }}>
            {t('graphEditor.inspector.unknownKind', { kind: node.kind })}
          </div>
        )}
      </div>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  width: 280,
  borderLeft: '1px solid var(--border-subtle, #333)',
  background: 'var(--bg-panel, #1f1f1f)',
  display: 'flex', flexDirection: 'column', minHeight: 0, flexShrink: 0,
};

const leftRailPanelStyle: React.CSSProperties = {
  width: 280,
  borderRight: '1px solid var(--border-subtle, #333)',
  background: 'var(--bg-panel, #1f1f1f)',
  display: 'flex', flexDirection: 'column', minHeight: 0, flexShrink: 0,
};

const floatingPanelStyle: React.CSSProperties = {
  width: 280,
  maxHeight: '70vh',
  background: 'var(--bg-panel, #1f1f1f)',
  border: '1px solid var(--border-subtle, #444)',
  borderRadius: 6,
  boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
  display: 'flex', flexDirection: 'column', minHeight: 0,
  overflow: 'hidden',
};

// ─── Generic JSON-schema form renderer ─────────────────────────────

type Schema = {
  type?: string;
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  default?: unknown;
  enum?: string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  title?: string;
};

function SchemaForm({
  schema, value, onChange,
}: {
  schema: unknown;
  value: Record<string, unknown> | undefined;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const s = schema as Schema;
  if (s.type !== 'object' || !s.properties) return null;
  return (
    <div>
      {Object.entries(s.properties).map(([key, propSchema]) => (
        <FormField
          key={key}
          fieldKey={key}
          schema={propSchema}
          value={value?.[key]}
          onChange={(next) => onChange({ ...(value ?? {}), [key]: next })}
        />
      ))}
    </div>
  );
}

function FormField({
  fieldKey, schema, value, onChange,
}: {
  fieldKey: string;
  schema: Schema;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const { t } = useTranslation();
  const label = schema.title ?? fieldKey;
  // Hide internal fields (e.g. _colorSpaceOverride) — UI for those lives
  // in the classic tabs via the Phase-3 SpaceToggle.
  if (fieldKey.startsWith('_')) return null;

  if (schema.type === 'boolean') {
    return (
      <FieldRow label={label}>
        <input
          type="checkbox"
          checked={value === true}
          onChange={(ev) => onChange(ev.target.checked)}
        />
      </FieldRow>
    );
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    const num = typeof value === 'number' ? value : (schema.default as number ?? 0);
    const { minimum: min, maximum: max } = schema;
    // No scale, no slider. A guessed range is what made the lens node's
    // strength jump between 0 and 2 on one arrow key (F018).
    if (min === undefined || max === undefined) {
      return <NumberField label={label} value={num} onChange={onChange} />;
    }
    return (
      <Slider
        label={label}
        value={num}
        min={min}
        max={max}
        step={schema.type === 'integer' ? 1 : (schema.multipleOf ?? (max - min) / 200)}
        defaultValue={(schema.default as number | undefined) ?? 0}
        onChange={onChange}
      />
    );
  }
  if (schema.type === 'string') {
    if (schema.enum) {
      return (
        <FieldRow label={label}>
          <select
            value={(value as string | undefined) ?? schema.default as string ?? schema.enum[0]}
            onChange={(ev) => onChange(ev.target.value)}
            style={selectStyle}
          >
            {schema.enum.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
          </select>
        </FieldRow>
      );
    }
    return (
      <FieldRow label={label}>
        <input
          type="text"
          value={(value as string | undefined) ?? ''}
          onChange={(ev) => onChange(ev.target.value)}
          style={textStyle}
        />
      </FieldRow>
    );
  }
  if (schema.type === 'object' && schema.properties) {
    return (
      <fieldset style={{ margin: '6px 0', padding: 6, border: '1px solid var(--border-subtle, #333)', borderRadius: 3 }}>
        <legend style={{ padding: '0 4px', fontSize: 10, color: 'var(--text-tertiary, #888)' }}>{label}</legend>
        <SchemaForm
          schema={schema}
          value={(value as Record<string, unknown>) ?? {}}
          onChange={onChange}
        />
      </fieldset>
    );
  }
  if (schema.type === 'array') {
    const len = Array.isArray(value) ? value.length : (value as ArrayBufferView | undefined)?.byteLength;
    return (
      <FieldRow label={label}>
        <span style={{ fontSize: 10, color: 'var(--text-tertiary, #888)' }}>
          {len !== undefined ? t('graphEditor.inspector.entries', { count: len }) : '—'}
        </span>
      </FieldRow>
    );
  }
  return null;
}

/**
 * A number the schema gives no range for. Uncommitted keystrokes live in a
 * draft so "-" and "0." can be typed; the value only leaves on blur or Enter.
 */
function NumberField({
  label, value, onChange,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (raw: string) => {
    setDraft(null);
    const next = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(next)) onChange(next);
  };
  return (
    <FieldRow label={label}>
      <input
        type="number"
        step="any"
        value={draft ?? String(value)}
        onChange={(ev) => setDraft(ev.target.value)}
        onBlur={(ev) => commit(ev.target.value)}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur();
          if (ev.key === 'Escape') setDraft(null);
        }}
        style={textStyle}
      />
    </FieldRow>
  );
}

/**
 * The custom-LUT node's `.cube` file.
 *
 * The samples go into the node's params, which means into the edit and into
 * every stored revision of it — hence the size cap and the note under the
 * field. The photo itself is not touched; a LUT is an edit, not a sidecar.
 */
function CustomLutFileField({
  params, onParamsChange,
}: {
  params: Record<string, unknown>;
  onParamsChange: (params: unknown) => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const count = lutSampleCount(params.samples);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const { size, samples } = parseCubeFile(await file.text());
      if (size > MAX_INLINE_LUT_SIZE) {
        setError(t('graphEditor.inspector.lut.tooLarge', { size, max: MAX_INLINE_LUT_SIZE }));
        return;
      }
      // Plain array, not the Float32Array: the graph is stored as JSON.
      onParamsChange({ ...params, size, samples: Array.from(samples) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div style={{ padding: '2px 4px 8px', borderBottom: '1px solid var(--border-subtle, #333)', marginBottom: 6 }}>
      <label style={{ display: 'block', fontSize: 11, color: 'var(--text-secondary, #aaa)', marginBottom: 4 }}>
        {t('graphEditor.inspector.lut.load')}
      </label>
      <input
        type="file"
        accept=".cube"
        onChange={(ev) => { void onFile(ev.target.files?.[0]); }}
        style={{ fontSize: 10, color: 'var(--text-secondary, #aaa)', width: '100%' }}
      />
      <div style={{ fontSize: 10, color: 'var(--text-tertiary, #888)', marginTop: 4 }}>
        {count > 0
          ? t('graphEditor.inspector.lut.loaded', { size: params.size })
          : t('graphEditor.inspector.lut.none')}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-tertiary, #888)', marginTop: 2 }}>
        {t('graphEditor.inspector.lut.inDocument')}
      </div>
      {error && (
        <div style={{ fontSize: 10, color: 'var(--text-danger, #e74c3c)', marginTop: 4 }}>{error}</div>
      )}
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 4px', fontSize: 11 }}>
      <label style={{ flex: '0 0 70px', color: 'var(--text-secondary, #aaa)' }}>{label}</label>
      {children}
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  flex: 1, fontSize: 11, padding: '2px 4px',
  background: 'var(--bg-input, #111)', border: '1px solid var(--border-subtle, #333)', color: '#eee',
};
const textStyle: React.CSSProperties = { ...selectStyle };
