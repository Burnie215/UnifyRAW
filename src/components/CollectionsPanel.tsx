import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { CollectionRow, CollectionRule } from '../storage/repos';
import {
  COLLECTION_RULE_FIELDS, defaultCollectionRule, operatorsForCollectionField,
  validCollectionRules, type CollectionRuleField, type CollectionRuleOperator,
} from '../data/collectionRules';
import './CollectionsPanel.css';

interface CollectionsPanelProps {
  collections: CollectionRow[];
  activeCollectionId: number | null;
  onSelect: (id: number | null) => void;
  onAdd: (name: string, type: 'manual' | 'smart', parentId?: number) => number | void;
  onDelete: (id: number) => void;
  onRename: (id: number, name: string) => void;
  onUpdateSmartRules: (id: number, rules: CollectionRule[]) => void;
}

interface CollectionNode {
  collection: CollectionRow;
  children: CollectionNode[];
}

function buildTree(collections: CollectionRow[]): CollectionNode[] {
  const byParent = new Map<number | null, CollectionRow[]>();
  for (const c of collections) {
    const pid = c.parentId ?? null;
    const arr = byParent.get(pid) ?? [];
    arr.push(c);
    byParent.set(pid, arr);
  }

  const build = (parentId: number | null): CollectionNode[] => {
    return (byParent.get(parentId) ?? []).map((c) => ({
      collection: c,
      children: c.id != null ? build(c.id) : [],
    }));
  };

  return build(null);
}

export function CollectionsPanel({
  collections, activeCollectionId, onSelect, onAdd, onDelete, onRename, onUpdateSmartRules,
}: CollectionsPanelProps) {
  const { t } = useTranslation();
  const [showAdd, setShowAdd] = useState(false);
  const [addName, setAddName] = useState('');
  const [addType, setAddType] = useState<'manual' | 'smart'>('manual');
  const [addParentId, setAddParentId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());

  const tree = useMemo(() => buildTree(collections), [collections]);

  // Only collections that can be parents (manual collections or collection sets)
  const parentOptions = collections.filter((c) => c.type === 'manual');

  const handleAdd = () => {
    if (!addName.trim()) return;
    const id = onAdd(addName.trim(), addType, addParentId ?? undefined);
    if (addType === 'smart' && typeof id === 'number') onSelect(id);
    setAddName('');
    setAddParentId(null);
    setShowAdd(false);
  };

  const toggleCollapse = (id: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div className="collections-panel">
      <div className="col-actions">
        <button className="col-add-btn" onClick={() => setShowAdd(!showAdd)} title={t('panels.collections.addTitle')}>
          {t('panels.collections.add')}
        </button>
      </div>

      {showAdd && (
        <div className="col-add-form">
          <input
            type="text"
            placeholder={t('panels.collections.namePlaceholder')}
            value={addName}
            onChange={(e) => setAddName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            autoFocus
          />
          <div className="col-type-btns">
            <button className={`col-type-btn ${addType === 'manual' ? 'active' : ''}`} onClick={() => setAddType('manual')}>
              {t('panels.collections.typeManual')}
            </button>
            <button className={`col-type-btn ${addType === 'smart' ? 'active' : ''}`} onClick={() => setAddType('smart')}>
              {t('panels.collections.typeSmart')}
            </button>
          </div>
          {parentOptions.length > 0 && (
            <select className="col-parent-select" value={addParentId ?? ''} onChange={(e) => setAddParentId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">{t('panels.collections.noParent')}</option>
              {parentOptions.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          )}
          <button className="col-confirm-btn" onClick={handleAdd}>{t('panels.collections.create')}</button>
        </div>
      )}

      {/* All photos */}
      <button
        className={`col-item ${activeCollectionId === null ? 'active' : ''}`}
        onClick={() => onSelect(null)}
      >
        <ColIcon type="all" />
        <span>{t('panels.collections.allPhotos')}</span>
      </button>

      {/* Recursive tree */}
      {tree.map((node) => (
        <CollectionTreeNode
          key={node.collection.id}
          node={node}
          depth={0}
          activeCollectionId={activeCollectionId}
          editingId={editingId}
          confirmDelete={confirmDelete}
          collapsed={collapsed}
          onSelect={onSelect}
          onStartEdit={setEditingId}
          onRename={(id, name) => { onRename(id, name); setEditingId(null); }}
          onCancelEdit={() => setEditingId(null)}
          onDelete={(id) => {
            if (confirmDelete === id) { onDelete(id); setConfirmDelete(null); }
            else setConfirmDelete(id);
          }}
          onToggleCollapse={toggleCollapse}
          onUpdateSmartRules={onUpdateSmartRules}
        />
      ))}
    </div>
  );
}

function CollectionTreeNode({ node, depth, activeCollectionId, editingId, confirmDelete, collapsed, onSelect, onStartEdit, onRename, onCancelEdit, onDelete, onToggleCollapse, onUpdateSmartRules }: {
  node: CollectionNode; depth: number;
  activeCollectionId: number | null; editingId: number | null; confirmDelete: number | null;
  collapsed: Set<number>;
  onSelect: (id: number | null) => void;
  onStartEdit: (id: number) => void;
  onRename: (id: number, name: string) => void;
  onCancelEdit: () => void;
  onDelete: (id: number) => void;
  onToggleCollapse: (id: number) => void;
  onUpdateSmartRules: (id: number, rules: CollectionRule[]) => void;
}) {
  const { t } = useTranslation();
  const { collection: col, children } = node;
  const id = col.id!;
  const hasChildren = children.length > 0;
  const isCollapsed = collapsed.has(id);
  const isEditing = editingId === id;
  const isConfirmDelete = confirmDelete === id;
  const isActive = activeCollectionId === id;
  const smartRules = col.type === 'smart' ? validCollectionRules(col.rules) : null;

  return (
    <>
      <div
        className={`col-item ${isActive ? 'active' : ''}`}
        style={{ paddingLeft: 8 + depth * 16 }}
      >
        {hasChildren ? (
          <span className="col-toggle" onClick={(e) => { e.stopPropagation(); onToggleCollapse(id); }}>
            <svg className={`col-chevron ${isCollapsed ? '' : 'open'}`} width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M3 2l4 3-4 3" />
            </svg>
          </span>
        ) : (
          <span className="col-toggle-spacer" />
        )}
        {isEditing ? (
          <>
            <ColIcon type={col.type} />
            <input
              className="col-name-input"
              defaultValue={col.name}
              onBlur={(e) => onRename(id, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') onCancelEdit();
              }}
              autoFocus
            />
          </>
        ) : (
          <button
            className="col-select-btn"
            type="button"
            onClick={() => onSelect(id)}
            aria-current={isActive ? 'true' : undefined}
            aria-label={col.name}
          >
            <ColIcon type={col.type} />
            <span className="col-name" onDoubleClick={() => onStartEdit(id)}>{col.name}</span>
            <span className="col-count">{col.type === 'manual' ? (col.photoIds?.length ?? 0) : ''}</span>
          </button>
        )}
        <button
          className={`col-del-btn ${isConfirmDelete ? 'danger' : ''}`}
          onClick={(e) => { e.stopPropagation(); onDelete(id); }}
          title={isConfirmDelete ? t('panels.collections.confirm') : t('panels.collections.delete')}
        >
          {isConfirmDelete ? '✓' : '×'}
        </button>
      </div>
      {col.type === 'smart' && isActive && (
        <SmartCollectionRulesEditor
          rules={smartRules ?? []}
          invalidPayload={smartRules === null}
          onChange={(rules) => onUpdateSmartRules(id, rules)}
        />
      )}
      {hasChildren && !isCollapsed && children.map((child) => (
        <CollectionTreeNode
          key={child.collection.id}
          node={child}
          depth={depth + 1}
          activeCollectionId={activeCollectionId}
          editingId={editingId}
          confirmDelete={confirmDelete}
          collapsed={collapsed}
          onSelect={onSelect}
          onStartEdit={onStartEdit}
          onRename={onRename}
          onCancelEdit={onCancelEdit}
          onDelete={onDelete}
          onToggleCollapse={onToggleCollapse}
          onUpdateSmartRules={onUpdateSmartRules}
        />
      ))}
    </>
  );
}

export function SmartCollectionRulesEditor({ rules, invalidPayload = false, onChange }: {
  rules: CollectionRule[];
  invalidPayload?: boolean;
  onChange: (rules: CollectionRule[]) => void;
}) {
  const { t } = useTranslation();
  const replace = (index: number, rule: CollectionRule) => {
    onChange(rules.map((current, currentIndex) => currentIndex === index ? rule : current));
  };

  return (
    <div className="col-rule-editor" role="group" aria-label={t('panels.collections.rules')}>
      <div className="col-rule-heading">
        <span>{t('panels.collections.matchAll')}</span>
        <button
          className="col-rule-add"
          onClick={() => onChange([...rules, defaultCollectionRule()])}
          type="button"
        >
          {t('panels.collections.addRule')}
        </button>
      </div>
      {invalidPayload
        ? <p className="col-rule-empty col-rule-invalid">{t('panels.collections.invalidRules')}</p>
        : rules.length === 0 && <p className="col-rule-empty">{t('panels.collections.noRules')}</p>}
      {rules.map((rule, index) => (
        <div className="col-rule" key={index}>
          <select
            className="col-rule-field"
            aria-label={`${t('panels.collections.field')} ${index + 1}`}
            value={rule.field}
            onChange={(event) => replace(index, defaultCollectionRule(event.target.value as CollectionRuleField))}
          >
            {COLLECTION_RULE_FIELDS.map((field) => (
              <option key={field} value={field}>{t(`panels.collections.fields.${field}`)}</option>
            ))}
          </select>
          <select
            className="col-rule-operator"
            aria-label={`${t('panels.collections.operator')} ${index + 1}`}
            value={rule.operator}
            onChange={(event) => {
              const operator = event.target.value as CollectionRuleOperator;
              replace(index, { ...rule, operator, value2: operator === 'between' ? rule.value2 ?? rule.value : undefined });
            }}
          >
            {operatorsForCollectionField(rule.field).map((operator) => (
              <option key={operator} value={operator}>{t(`panels.collections.operators.${operator}`)}</option>
            ))}
          </select>
          <RuleValueInput
            index={index}
            rule={rule}
            onChange={(patch) => replace(index, { ...rule, ...patch })}
          />
          <button
            className="col-rule-delete"
            aria-label={`${t('panels.collections.deleteRule')} ${index + 1}`}
            onClick={() => onChange(rules.filter((_, currentIndex) => currentIndex !== index))}
            type="button"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function RuleValueInput({ index, rule, onChange }: {
  index: number;
  rule: CollectionRule;
  onChange: (patch: Partial<CollectionRule>) => void;
}) {
  const { t } = useTranslation();
  if (rule.field === 'flag' || rule.field === 'colorLabel') {
    const values = rule.field === 'flag' ? ['', 'pick', 'reject'] : ['', 'red', 'yellow', 'green', 'blue', 'purple'];
    return (
      <select
        className="col-rule-value"
        aria-label={`${t('panels.collections.value')} ${index + 1}`}
        value={rule.value}
        onChange={(event) => onChange({ value: event.target.value })}
      >
        {values.map((value) => (
          <option key={value} value={value}>
            {t(`panels.collections.values.${rule.field}.${value || 'none'}`)}
          </option>
        ))}
      </select>
    );
  }

  const type = rule.field === 'date' ? 'date'
    : rule.field === 'rating' || rule.field === 'iso' || rule.field === 'focalLength' ? 'number'
      : 'text';
  const min = rule.field === 'rating' || rule.field === 'iso' || rule.field === 'focalLength' ? 0 : undefined;
  const max = rule.field === 'rating' ? 5 : undefined;
  const step = rule.field === 'focalLength' ? 'any' : undefined;
  const parse = (value: string): string | number => type === 'number' && value !== '' ? Number(value) : value;

  return (
    <div className="col-rule-values">
      <input
        className="col-rule-value"
        aria-label={`${t('panels.collections.value')} ${index + 1}`}
        type={type}
        min={min}
        max={max}
        step={step}
        value={rule.value}
        onChange={(event) => onChange({ value: parse(event.target.value) })}
      />
      {rule.operator === 'between' && (
        <input
          className="col-rule-value"
          aria-label={`${t('panels.collections.secondValue')} ${index + 1}`}
          type={type}
          min={min}
          max={max}
          step={step}
          value={rule.value2 ?? ''}
          onChange={(event) => onChange({ value2: parse(event.target.value) })}
        />
      )}
    </div>
  );
}

function ColIcon({ type }: { type: string }) {
  if (type === 'smart') {
    return (
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" className="col-icon">
        <rect x="1" y="3" width="12" height="8" rx="2" />
        <path d="M5 7l2 2 3-3" />
      </svg>
    );
  }
  if (type === 'all') {
    return (
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" className="col-icon">
        <rect x="1" y="1" width="5" height="5" rx="1" /><rect x="8" y="1" width="5" height="5" rx="1" />
        <rect x="1" y="8" width="5" height="5" rx="1" /><rect x="8" y="8" width="5" height="5" rx="1" />
      </svg>
    );
  }
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" className="col-icon">
      <rect x="1" y="3" width="12" height="8" rx="2" />
      <path d="M4 7h6" />
    </svg>
  );
}
