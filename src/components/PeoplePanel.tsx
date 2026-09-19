import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { FaceGroup } from '../hooks/useFaces';
import type { PhotoView } from '../storage/repos';
import './PeoplePanel.css';

interface PeoplePanelProps {
  groups: FaceGroup[];
  scanning: boolean;
  onScan: () => void;
  onRename: (clusterId: number, name: string) => void;
  onSelectPerson: (clusterId: number) => void;
  /** Get display URL for face thumbnail */
  getDisplayUrl: (photo: PhotoView) => Promise<string | null>;
  photos: PhotoView[];
}

export function PeoplePanel({
  groups, scanning, onScan, onRename, onSelectPerson, getDisplayUrl, photos,
}: PeoplePanelProps) {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId !== null && inputRef.current) inputRef.current.focus();
  }, [editingId]);

  const handleRenameSubmit = useCallback((clusterId: number) => {
    if (editName.trim()) {
      onRename(clusterId, editName.trim());
    }
    setEditingId(null);
    setEditName('');
  }, [editName, onRename]);

  return (
    <div className="people-panel">
      <button className="people-scan-btn" onClick={onScan} disabled={scanning}
        title={t('panels.people.scanTitle')}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
          <circle cx="7" cy="5" r="3" />
          <path d="M3 13c0-2.5 1.8-4 4-4s4 1.5 4 4" />
        </svg>
        {scanning ? t('panels.people.scanning') : t('panels.people.scan')}
      </button>

      {groups.length === 0 && !scanning && (
        <div className="people-empty">{t('panels.people.empty')}</div>
      )}

      <div className="people-grid">
        {groups.map((group) => (
          <PersonCard
            key={group.clusterId}
            group={group}
            editing={editingId === group.clusterId}
            editName={editName}
            inputRef={editingId === group.clusterId ? inputRef : undefined}
            onStartEdit={() => { setEditingId(group.clusterId); setEditName(group.name ?? ''); }}
            onEditNameChange={setEditName}
            onSubmitName={() => handleRenameSubmit(group.clusterId)}
            onSelect={() => onSelectPerson(group.clusterId)}
            getDisplayUrl={getDisplayUrl}
            photos={photos}
          />
        ))}
      </div>
    </div>
  );
}

function PersonCard({ group, editing, editName, inputRef, onStartEdit, onEditNameChange, onSubmitName, onSelect, getDisplayUrl, photos }: {
  group: FaceGroup;
  editing: boolean;
  editName: string;
  inputRef?: React.Ref<HTMLInputElement>;
  onStartEdit: () => void;
  onEditNameChange: (name: string) => void;
  onSubmitName: () => void;
  onSelect: () => void;
  getDisplayUrl: (photo: PhotoView) => Promise<string | null>;
  photos: PhotoView[];
}) {
  const { t } = useTranslation();
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);

  // Generate face thumbnail from the representative face
  useEffect(() => {
    const face = group.representative;
    const photo = photos.find((p) => p.id === face.photoId);
    if (!photo) return;
    let cancelled = false;

    getDisplayUrl(photo).then((url) => {
      if (cancelled || !url) return;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        if (cancelled) return;
        // Crop face region with padding
        const pad = 0.15;
        const cx = face.x + face.width / 2;
        const cy = face.y + face.height / 2;
        const size = Math.max(face.width, face.height) * (1 + pad * 2);
        const cropX = Math.max(0, cx - size / 2) * img.width;
        const cropY = Math.max(0, cy - size / 2) * img.height;
        const cropW = Math.min(size * img.width, img.width - cropX);
        const cropH = Math.min(size * img.height, img.height - cropY);

        const thumbSize = 80;
        const canvas = document.createElement('canvas');
        canvas.width = thumbSize;
        canvas.height = thumbSize;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, thumbSize, thumbSize);
        setThumbUrl(canvas.toDataURL('image/jpeg', 0.7));
      };
      img.src = url;
    });

    return () => { cancelled = true; };
  }, [group.representative, photos, getDisplayUrl]);

  return (
    <div className="person-card" onClick={onSelect}>
      <div className="person-thumb">
        {thumbUrl ? <img src={thumbUrl} alt="" /> : <div className="person-placeholder" />}
        <span className="person-count">{group.faces.length}</span>
      </div>
      {editing ? (
        <input
          ref={inputRef}
          className="person-name-input"
          value={editName}
          onChange={(e) => onEditNameChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onSubmitName(); if (e.key === 'Escape') onSubmitName(); }}
          onBlur={onSubmitName}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="person-name" onDoubleClick={(e) => { e.stopPropagation(); onStartEdit(); }}>
          {group.name || t('panels.people.unnamed')}
        </span>
      )}
    </div>
  );
}
