import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ViewMode } from '../types';
import type { SourceRow } from '../storage/repos';
import { CollectionsPanel } from './CollectionsPanel';
import { ContextMenu } from './ContextMenu';
import { PeoplePanel } from './PeoplePanel';
import { PresetsPanel } from './PresetsPanel';
import { Panel } from './Panel';
import type { CollectionRow, CollectionRule, PhotoView } from '../storage/repos';
import type { FaceGroup } from '../hooks/useFaces';
import type { PresetRow } from '../storage/repos';
import type { PresetImportResult } from '../hooks/usePresets';
import { useBrand } from '../brand';
import { AlphaBadge } from './AlphaBadge';
import { sourceTypeLabel } from '../sources/sourcePresentation';
import { STORAGE_KEYS } from '../platform/storageKeys';
import './Sidebar.css';

interface SidebarProps {
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
  photoCount: number;
  sources: SourceRow[];
  onAddSource: () => void;
  onRescanSource: (id: string) => void;
  onToggleSourceVisibility: (id: string) => void;
  hiddenSources: Set<string>;
  scanning: boolean;
  photoCountBySource: Record<string, number>;
  folderTree: { tree: Map<string, number>; sourceLabels: Map<string, string> };
  folderFilter: string | null;
  onFolderFilterChange: (path: string | null) => void;
  // Collections
  collections?: CollectionRow[];
  activeCollectionId?: number | null;
  onSelectCollection?: (id: number | null) => void;
  onAddCollection?: (name: string, type: 'manual' | 'smart', parentId?: number) => number | void;
  onDeleteCollection?: (id: number) => void;
  onRenameCollection?: (id: number, name: string) => void;
  onUpdateSmartRules?: (id: number, rules: CollectionRule[]) => void;
  // Reconnect
  disconnectedIds?: string[];
  onReconnectSource?: (id: string) => Promise<boolean>;
  // People / Face Detection
  faceGroups?: FaceGroup[];
  facesScanning?: boolean;
  onFaceScan?: () => void;
  onFaceRename?: (clusterId: number, name: string) => void;
  onSelectPerson?: (clusterId: number) => void;
  getDisplayUrl?: (photo: PhotoView) => Promise<string | null>;
  allPhotos?: PhotoView[];
  // Presets (library only). A preset applied here lands on the whole
  // selection, and the bench that builds one works on that same selection -
  // which is why its way in sits with the library and not with the editor.
  presets?: PresetRow[];
  onApplyPreset?: (preset: PresetRow) => void;
  onSavePreset?: (name: string, category?: string, groups?: string[]) => void;
  onDeletePreset?: (id: number) => void;
  onExportPreset?: (preset: PresetRow) => void;
  onImportPreset?: (contents: string, fileName?: string) => PresetImportResult | void;
  onOpenBench?: () => void;
  // About & Settings
  onShowAbout?: () => void;
  onShowSettings?: () => void;
  focusSection?: 'sources' | 'collections';
}

/* ─── Tree Node type ─── */
interface TreeNode {
  name: string;
  path: string;
  count: number;
  children: TreeNode[];
}

function buildTree(folderTree: Map<string, number>, sourceLabels: Map<string, string>): TreeNode[] {
  const roots: TreeNode[] = [];
  const nodeMap = new Map<string, TreeNode>();

  const paths = Array.from(folderTree.keys()).sort();

  for (const path of paths) {
    const parts = path.split('/');
    let name = parts[parts.length - 1];

    // Source root nodes: §sourceId → use source label
    if (parts.length === 1 && path.startsWith('§')) {
      const srcId = path.slice(1);
      name = sourceLabels.get(srcId) ?? srcId;
    }

    const node: TreeNode = { name, path, count: folderTree.get(path) ?? 0, children: [] };
    nodeMap.set(path, node);

    if (parts.length === 1) {
      roots.push(node);
    } else {
      const parentPath = parts.slice(0, -1).join('/');
      const parent = nodeMap.get(parentPath);
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }
  }

  return roots;
}

export function Sidebar({
  view, onViewChange, photoCount, sources,
  onAddSource, onRescanSource,
  onToggleSourceVisibility, hiddenSources,
  scanning, photoCountBySource,
  folderTree, folderFilter, onFolderFilterChange,
  collections, activeCollectionId, onSelectCollection,
  onAddCollection, onDeleteCollection, onRenameCollection, onUpdateSmartRules,
  disconnectedIds, onReconnectSource,
  faceGroups, facesScanning, onFaceScan, onFaceRename, onSelectPerson, getDisplayUrl, allPhotos,
  presets, onApplyPreset, onSavePreset, onDeletePreset, onExportPreset, onImportPreset,
  onOpenBench,
  onShowAbout, onShowSettings, focusSection,
}: SidebarProps) {
  const { t } = useTranslation();
  const brand = useBrand();
  const [failedWordmarkPath, setFailedWordmarkPath] = useState<string | null>(null);
  const wordmarkFailed = failedWordmarkPath === brand.wordmarkPath;
  const [sourcesExpanded, setSourcesExpanded] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEYS.sidebarSourcesExpanded) !== 'false'; } catch { return true; }
  });
  const [treeExpanded, setTreeExpanded] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEYS.sidebarTreeExpanded) !== 'false'; } catch { return true; }
  });

  useEffect(() => { try { localStorage.setItem(STORAGE_KEYS.sidebarSourcesExpanded, String(sourcesExpanded)); } catch { /* unavailable */ } }, [sourcesExpanded]);
  useEffect(() => { try { localStorage.setItem(STORAGE_KEYS.sidebarTreeExpanded, String(treeExpanded)); } catch { /* unavailable */ } }, [treeExpanded]);
  const tree = useMemo(() => buildTree(folderTree.tree, folderTree.sourceLabels), [folderTree]);
  const [treeMenu, setTreeMenu] = useState<{ x: number; y: number; sourceId: string | null } | null>(null);

  // Every folder path is rooted at its source ("§<sourceId>/..."), so the tree
  // entry itself says which source a refresh has to talk to.
  const openTreeMenu = useCallback((event: ReactMouseEvent, path: string | null) => {
    event.preventDefault();
    const sourceId = path?.startsWith('§') ? path.slice(1).split('/')[0] : null;
    setTreeMenu({ x: event.clientX, y: event.clientY, sourceId });
  }, []);
  const disconnectedSet = useMemo(() => new Set(disconnectedIds ?? []), [disconnectedIds]);
  const sourcesSectionRef = useRef<HTMLDivElement>(null);
  const collectionsSectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = focusSection === 'collections' ? collectionsSectionRef.current : sourcesSectionRef.current;
    target?.scrollIntoView({ block: 'start' });
  }, [focusSection]);

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h1>
          {brand.wordmarkPath && !wordmarkFailed ? (
            <img
              src={brand.wordmarkPath}
              alt={brand.name}
              className="sidebar-wordmark"
              onError={() => setFailedWordmarkPath(brand.wordmarkPath ?? null)}
            />
          ) : (
            brand.name
          )}
          <AlphaBadge />
        </h1>
      </div>

      <div className="sidebar-scroll">
        <nav className="sidebar-nav">
          <button
            className={`nav-item ${view === 'grid' ? 'active' : ''}`}
            aria-current={view === 'grid' ? 'page' : undefined}
            onClick={() => onViewChange('grid')}
          >
            <GridIcon />
            <span>{t('sidebar.library')}</span>
            <span className="badge">{photoCount}</span>
          </button>
          <button
            className={`nav-item ${view === 'editor' ? 'active' : ''}`}
            aria-current={view === 'editor' ? 'page' : undefined}
            onClick={() => onViewChange('editor')}
          >
            <EditIcon />
            <span>{t('sidebar.develop')}</span>
          </button>
        </nav>

        {/* Sources stay above the potentially long folder tree so they remain visible. */}
        {view !== 'editor' && <div className="sidebar-section" ref={sourcesSectionRef}>
          <div className="section-header-row">
            <button
              className="section-header"
              aria-expanded={sourcesExpanded}
              onClick={() => setSourcesExpanded(!sourcesExpanded)}
            >
              <Chevron open={sourcesExpanded} />
              <span>{t('sidebar.sources')}</span>
              <span className="badge">{sources.length}</span>
            </button>
            <button
              className="section-header-action"
              onClick={onAddSource}
              title={t('sidebar.addSource')}
              aria-label={t('sidebar.addSource')}
            >
              <PlusIcon />
            </button>
          </div>

          {sourcesExpanded && (
            <div className="source-list">
              {disconnectedIds && disconnectedIds.length > 0 && onReconnectSource && (
                <button className="reconnect-banner" onClick={async () => {
                  for (const id of disconnectedIds) await onReconnectSource(id);
                }}>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M2 6a4 4 0 1 1 1.17 2.83" /><path d="M2 9V6h3" />
                  </svg>
                  {t('sidebar.sourcesCount', { count: disconnectedIds.length })}
                </button>
              )}
              {sources.length === 0 && (
                <button className="source-empty source-empty-action" onClick={onAddSource}>
                  <PlusIcon />
                  <span>{t('sidebar.emptyNoSources')}</span>
                </button>
              )}
              {sources.map((s) => {
                const hidden = hiddenSources.has(s.id);
                const disconnected = disconnectedSet.has(s.id);
                const sourcePath = `§${s.id}`;
                const active = folderFilter === sourcePath || folderFilter?.startsWith(`${sourcePath}/`) === true;
                return (
                  <div className={`source-item ${active ? 'active' : ''} ${hidden ? 'hidden-source' : ''} ${disconnected ? 'disconnected' : ''}`} key={s.id}>
                    <button
                      className={`source-visibility-btn ${hidden ? 'off' : ''}`}
                      title={hidden ? t('sidebar.showSource') : t('sidebar.hideSource')}
                      onClick={() => {
                        onToggleSourceVisibility(s.id);
                        if (!hidden && (folderFilter === sourcePath || folderFilter?.startsWith(`${sourcePath}/`))) {
                          onFolderFilterChange(null);
                        }
                      }}
                    >
                      {hidden ? <EyeOffIcon /> : <EyeIcon />}
                    </button>
                    <button
                      className="source-select-btn"
                      onClick={() => onFolderFilterChange(active ? null : sourcePath)}
                      title={t('sidebar.selectSource', { name: s.label })}
                    >
                      <SourceTypeIcon type={s.type} />
                      <span className="source-info">
                        <span className="source-name" title={s.label}>{s.label}</span>
                        <span className="source-count">
                          {sourceTypeLabel(s.type)} · {t('sidebar.photosCount', { count: photoCountBySource[s.id] ?? 0 })}
                        </span>
                      </span>
                    </button>
                    {disconnected && onReconnectSource ? (
                      <button
                        className="source-action-btn reconnect"
                        onClick={() => { void onReconnectSource(s.id); }}
                        title={t('sidebar.reconnectSource')}
                        aria-label={t('sidebar.reconnectSource')}
                      >
                        <ReconnectIcon />
                      </button>
                    ) : (
                      <button
                        className="source-action-btn"
                        onClick={() => onRescanSource(s.id)}
                        disabled={scanning}
                        title={t('sidebar.rescanSource')}
                        aria-label={t('sidebar.rescanSource')}
                      >
                        <RefreshIcon />
                      </button>
                    )}
                  </div>
                );
              })}
              {onShowSettings && (
                <button className="source-manage-btn" onClick={onShowSettings}>
                  {t('sidebar.manageSources')}
                </button>
              )}
            </div>
          )}
        </div>}

        {/* Folder Tree Section (library only) */}
        {view !== 'editor' && tree.length > 0 && <div className="sidebar-section">
          <button
            className="section-header"
            aria-expanded={treeExpanded}
            onClick={() => setTreeExpanded(!treeExpanded)}
          >
            <Chevron open={treeExpanded} />
            <span>{t('sidebar.folders')}</span>
          </button>

          {treeExpanded && (
            <div className="tree-container">
              <button
                className={`tree-item ${folderFilter === null ? 'active' : ''}`}
                onClick={() => onFolderFilterChange(null)}
                onContextMenu={(event) => openTreeMenu(event, null)}
              >
                <TreeFolderIcon />
                <span>{t('sidebar.allFolders')}</span>
              </button>
              {tree.map((node) => (
                <FolderTreeNode
                  key={node.path}
                  node={node}
                  depth={0}
                  activeFilter={folderFilter}
                  onSelect={onFolderFilterChange}
                  onContextMenu={openTreeMenu}
                />
              ))}
            </div>
          )}
        </div>}

        {/* Collections (library only) */}
        {view !== 'editor' && collections && onSelectCollection && onAddCollection && onDeleteCollection && onRenameCollection && onUpdateSmartRules && (
          <div className="sidebar-section" ref={collectionsSectionRef}>
            <Panel title={t('sidebar.collectionsTitle')}>
              <CollectionsPanel
                collections={collections}
                activeCollectionId={activeCollectionId ?? null}
                onSelect={onSelectCollection}
                onAdd={onAddCollection}
                onDelete={onDeleteCollection}
                onRename={onRenameCollection}
                onUpdateSmartRules={onUpdateSmartRules}
              />
            </Panel>
          </div>
        )}

        {/* Presets (library only) */}
        {view !== 'editor' && presets && onApplyPreset && (
          <div className="sidebar-section">
            <Panel title={t('sidebar.presetsTitle')}>
              <PresetsPanel
                presets={presets}
                onApply={(preset) => onApplyPreset(preset)}
                onSave={onSavePreset ?? (() => {})}
                onDelete={onDeletePreset ?? (() => {})}
                onExport={onExportPreset ?? (() => {})}
                onImport={onImportPreset ?? (() => {})}
                onOpenBench={onOpenBench}
                showStrength={false}
              />
            </Panel>
          </div>
        )}

        {/* People (library only) */}
        {view !== 'editor' && faceGroups && onFaceScan && onFaceRename && onSelectPerson && getDisplayUrl && allPhotos && (
          <div className="sidebar-section">
            <Panel title={t('sidebar.peopleTitle')}>
              <PeoplePanel
                groups={faceGroups}
                scanning={facesScanning ?? false}
                onScan={onFaceScan}
                onRename={onFaceRename}
                onSelectPerson={onSelectPerson}
                getDisplayUrl={getDisplayUrl}
                photos={allPhotos}
              />
            </Panel>
          </div>
        )}

      </div>

      {view !== 'editor' && <div className="sidebar-footer">
        {onShowSettings && (
          <button className="settings-footer-btn" onClick={onShowSettings}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
              <circle cx="6" cy="6" r="2" /><path d="M6 1v1.5M6 9.5V11M1 6h1.5M9.5 6H11M2.1 2.1l1.1 1.1M8.8 8.8l1.1 1.1M2.1 9.9l1.1-1.1M8.8 3.2l1.1-1.1" />
            </svg>
            {t('sidebar.settings')}
          </button>
        )}
        {onShowAbout && (
          <button className="about-btn" onClick={onShowAbout}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><circle cx="6" cy="6" r="5" /><path d="M6 5v4M6 3v.5" /></svg>
            {t('sidebar.infoAndImprint')}
          </button>
        )}
      </div>}

      {treeMenu && (
        <ContextMenu
          x={treeMenu.x}
          y={treeMenu.y}
          onClose={() => setTreeMenu(null)}
          items={[
            ...(treeMenu.sourceId ? [{
              label: t('sidebar.refreshFolderSource'),
              disabled: scanning,
              onClick: () => onRescanSource(treeMenu.sourceId!),
            }] : []),
            {
              label: t('sidebar.refreshAllSources'),
              disabled: scanning || sources.length === 0,
              onClick: () => { for (const source of sources) onRescanSource(source.id); },
            },
          ]}
        />
      )}
    </aside>
  );
}

/* ─── Folder Tree Node (recursive) ─── */
function FolderTreeNode({ node, depth, activeFilter, onSelect, onContextMenu }: {
  node: TreeNode; depth: number; activeFilter: string | null;
  onSelect: (path: string | null) => void;
  onContextMenu: (event: ReactMouseEvent, path: string) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const hasChildren = node.children.length > 0;
  const isActive = activeFilter === node.path;
  const isSourceRoot = depth === 0 && node.path.startsWith('§');

  return (
    <>
      <button
        className={`tree-item ${isActive ? 'active' : ''} ${isSourceRoot ? 'source-root' : ''}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => onSelect(isActive ? null : node.path)}
        onContextMenu={(event) => onContextMenu(event, node.path)}
      >
        {hasChildren ? (
          <span className="tree-toggle" onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
            <Chevron open={open} />
          </span>
        ) : (
          <span className="tree-toggle-spacer" />
        )}
        {isSourceRoot ? <TreeDriveIcon /> : <TreeFolderIcon />}
        <span className="tree-label">{node.name}</span>
        <span className="tree-count">{node.count}</span>
      </button>
      {open && hasChildren && node.children.map((child) => (
        <FolderTreeNode
          key={child.path}
          node={child}
          depth={depth + 1}
          activeFilter={activeFilter}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
        />
      ))}
    </>
  );
}

/* ─── Icons ─── */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`section-chevron ${open ? 'open' : ''}`} width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 2l4 3-4 3" />
    </svg>
  );
}

function TreeDriveIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" className="tree-folder-icon">
      <rect x="1" y="3" width="12" height="8" rx="2" />
      <circle cx="10" cy="7" r="1" fill="currentColor" />
      <path d="M3 7h4" />
    </svg>
  );
}

function TreeFolderIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" className="tree-folder-icon">
      <path d="M1 3.5V11a1 1 0 001 1h10a1 1 0 001-1V5a1 1 0 00-1-1H7L5.5 2.5H2A1 1 0 001 3.5z" />
    </svg>
  );
}

function SourceTypeIcon({ type }: { type: string }) {
  if (type === 'local' || type === 'local-files') return <TreeFolderIcon />;
  if (type === 's3' || type === 'dropbox' || type === 'google-drive' || type === 'onedrive' || type === 'google-photos') {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" className="source-icon">
        <path d="M4.2 11.5h6.1a2.2 2.2 0 00.3-4.4A3.8 3.8 0 003.3 6a2.8 2.8 0 00.9 5.5z" />
      </svg>
    );
  }
  return <TreeDriveIcon />;
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M6 2v8M2 6h8" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 6a4 4 0 111.17 2.83" /><path d="M2 9V6h3" />
    </svg>
  );
}

function ReconnectIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 6a4 4 0 111.17 2.83" /><path d="M2 9V6h3" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="M1 7s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" />
      <circle cx="7" cy="7" r="2" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="M1 7s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" />
      <path d="M2 12L12 2" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <rect x="1" y="1" width="6" height="6" rx="1" />
      <rect x="9" y="1" width="6" height="6" rx="1" />
      <rect x="1" y="9" width="6" height="6" rx="1" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="5" />
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}
