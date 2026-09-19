import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CollectionRow } from '../storage/repos';
import './AddToCollectionDialog.css';

interface Props {
  /** The photos the gallery's context menu was opened on. */
  photoIds: number[];
  collections: CollectionRow[];
  onAdd: (collectionId: number) => void;
  /** Creates the collection and returns its id, so it can be filled at once. */
  onCreate: (name: string, parentId: number | null) => number;
  onClose: () => void;
}

interface Node { collection: CollectionRow; depth: number }

/** Depth-first, so the list reads like the sidebar tree it mirrors. */
function flatten(collections: CollectionRow[]): Node[] {
  const byParent = new Map<number | null, CollectionRow[]>();
  for (const c of collections) {
    const pid = c.parentId ?? null;
    byParent.set(pid, [...(byParent.get(pid) ?? []), c]);
  }
  const out: Node[] = [];
  const walk = (parentId: number | null, depth: number) => {
    for (const c of byParent.get(parentId) ?? []) {
      out.push({ collection: c, depth });
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export function AddToCollectionDialog({ photoIds, collections, onAdd, onCreate, onClose }: Props) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [newName, setNewName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const nodes = useMemo(() => flatten(collections), [collections]);

  /**
   * Which collections already hold the whole selection.
   *
   * Adding those again would be a no-op, so they are shown as done rather than
   * offered - otherwise the dialog invites an action that changes nothing and
   * gives no feedback.
   */
  const alreadyHasAll = useMemo(() => {
    const map = new Map<number, boolean>();
    for (const c of collections) {
      const ids = new Set(c.photoIds ?? []);
      map.set(c.id, photoIds.length > 0 && photoIds.every((id) => ids.has(id)));
    }
    return map;
  }, [collections, photoIds]);

  const canPick = (c: CollectionRow) => c.type === 'manual' && !alreadyHasAll.get(c.id);

  const submit = () => {
    const name = newName.trim();
    if (name) {
      // A typed name wins over a highlighted row: the user is mid-sentence in
      // the field, and the highlight is only there to say where it will land.
      onAdd(onCreate(name, selectedId));
      onClose();
      return;
    }
    if (selectedId !== null) { onAdd(selectedId); onClose(); }
  };

  const ready = newName.trim().length > 0 || selectedId !== null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Enter' && ready) submit();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  return (
    <div className="add-collection-backdrop" onClick={onClose}>
      <div className="add-collection-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h3>{t('dialogs.addToCollection.header', { count: photoIds.length })}</h3>

        {nodes.length === 0 ? (
          <p className="add-collection-empty">{t('dialogs.addToCollection.empty')}</p>
        ) : (
          <ul className="add-collection-list">
            {nodes.map(({ collection, depth }) => {
              const done = !!alreadyHasAll.get(collection.id);
              const smart = collection.type !== 'manual';
              const pickable = canPick(collection);
              return (
                <li key={collection.id}>
                  <button
                    type="button"
                    className={`add-collection-row${selectedId === collection.id ? ' selected' : ''}`}
                    style={{ paddingLeft: 10 + depth * 16 }}
                    disabled={!pickable}
                    title={smart
                      ? t('dialogs.addToCollection.smartHint')
                      : done ? t('dialogs.addToCollection.alreadyIn') : undefined}
                    onClick={() => setSelectedId(collection.id)}
                    onDoubleClick={() => { onAdd(collection.id); onClose(); }}
                  >
                    <span className="add-collection-name">{collection.name}</span>
                    {smart && <span className="add-collection-tag">{t('dialogs.addToCollection.smart')}</span>}
                    {done && !smart && <span className="add-collection-check">✓</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <label className="add-collection-new">
          <span>{selectedId === null
            ? t('dialogs.addToCollection.newTopLevel')
            : t('dialogs.addToCollection.newBelow', {
              parent: collections.find((c) => c.id === selectedId)?.name ?? '',
            })}</span>
          <input
            ref={inputRef}
            type="text"
            value={newName}
            autoFocus
            placeholder={t('dialogs.addToCollection.newPlaceholder')}
            onChange={(e) => setNewName(e.target.value)}
          />
        </label>

        <div className="add-collection-actions">
          <button className="btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn-primary" onClick={submit} disabled={!ready}>
            {t('dialogs.addToCollection.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
