import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { PhotoView } from '../storage/repos';
import { buildKeywordTree, getKeywordDisplayName, createChildPath, type KeywordAggregation, type KeywordNode } from '../data/keywordTree';
import './KeywordsPanel.css';

interface KeywordsPanelProps {
  selectedPhotos: PhotoView[];
  onAddKeywords: (photoIds: number[], keywords: string[]) => void;
  onRemoveKeyword: (photoIds: number[], keyword: string) => void;
  allKeywords: KeywordAggregation[];
  onKeywordFilter?: (keyword: string) => void;
  activeKeyword?: string | null;
}

export function KeywordsPanel({ selectedPhotos, onAddKeywords, onRemoveKeyword, allKeywords, onKeywordFilter, activeKeyword }: KeywordsPanelProps) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [parentPath, setParentPath] = useState(''); // For adding child keywords
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  const photoIds = useMemo(() => selectedPhotos.map((p) => p.id!).filter(Boolean), [selectedPhotos]);

  const commonKeywords = useMemo(() => {
    if (selectedPhotos.length === 0) return [];
    const sets = selectedPhotos.map((p) => new Set(p.keywords ?? []));
    const first = sets[0];
    return Array.from(first).filter((k) => sets.every((s) => s.has(k))).sort();
  }, [selectedPhotos]);

  const partialKeywords = useMemo(() => {
    if (selectedPhotos.length <= 1) return [];
    const allKw = new Set<string>();
    selectedPhotos.forEach((p) => (p.keywords ?? []).forEach((k) => allKw.add(k)));
    return Array.from(allKw).filter((k) => !commonKeywords.includes(k)).sort();
  }, [selectedPhotos, commonKeywords]);

  // Build tree from all keywords
  const keywordTree = useMemo(() => buildKeywordTree(allKeywords), [allKeywords]);

  const suggestions = useMemo(() => {
    if (!input.trim()) return [];
    const q = input.toLowerCase();
    return allKeywords
      .filter((k) => k.keyword.toLowerCase().includes(q) && !commonKeywords.includes(k.keyword))
      .slice(0, 8);
  }, [input, allKeywords, commonKeywords]);

  const handleAdd = useCallback((keyword?: string) => {
    const raw = (keyword ?? input).trim();
    if (!raw || photoIds.length === 0) return;
    const fullPath = parentPath ? createChildPath(parentPath, raw) : raw;
    onAddKeywords(photoIds, [fullPath]);
    setInput('');
    setParentPath('');
    setShowSuggestions(false);
  }, [input, parentPath, photoIds, onAddKeywords]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); handleAdd(); }
    if (e.key === 'Escape') { setShowSuggestions(false); setInput(''); setParentPath(''); }
  }, [handleAdd]);

  const toggleExpanded = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }, []);

  // Start adding a child keyword under a parent
  const startAddChild = useCallback((parentPath: string) => {
    setParentPath(parentPath);
    setInput('');
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!showSuggestions) return;
    const handler = () => setShowSuggestions(false);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [showSuggestions]);

  const hasSelection = selectedPhotos.length > 0;

  return (
    <div className="kw-panel">
      {hasSelection ? (
        <>
          <div className="kw-input-row" onClick={(e) => e.stopPropagation()}>
            {parentPath && (
              <span className="kw-parent-badge" onClick={() => setParentPath('')}>
                {getKeywordDisplayName(parentPath)} &gt;
              </span>
            )}
            <input
              ref={inputRef}
              className="kw-input"
              placeholder={parentPath ? t('panels.keywords.subPlaceholder') : t('panels.keywords.addPlaceholder')}
              value={input}
              onChange={(e) => { setInput(e.target.value); setShowSuggestions(true); }}
              onKeyDown={handleKeyDown}
              onFocus={() => setShowSuggestions(true)}
            />
            <button className="kw-add-btn" onClick={() => handleAdd()} disabled={!input.trim()}>+</button>
          </div>

          {showSuggestions && suggestions.length > 0 && (
            <div className="kw-suggestions" onClick={(e) => e.stopPropagation()}>
              {suggestions.map((s) => (
                <button key={s.keyword} className="kw-suggestion" onClick={() => handleAdd(s.keyword)}>
                  {getKeywordDisplayName(s.keyword)} <span className="kw-count">{s.count}</span>
                </button>
              ))}
            </div>
          )}

          {(commonKeywords.length > 0 || partialKeywords.length > 0) && (
            <div className="kw-pills">
              {commonKeywords.map((k) => (
                <span key={k} className="kw-pill">
                  {getKeywordDisplayName(k)}
                  <button className="kw-pill-x" onClick={() => onRemoveKeyword(photoIds, k)}>×</button>
                </span>
              ))}
              {partialKeywords.map((k) => (
                <span key={k} className="kw-pill kw-pill-partial" title={t('panels.keywords.partialTitle')}>
                  {getKeywordDisplayName(k)}
                  <button className="kw-pill-x" onClick={() => onRemoveKeyword(photoIds, k)}>×</button>
                </span>
              ))}
            </div>
          )}

          {commonKeywords.length === 0 && partialKeywords.length === 0 && (
            <div className="kw-hint">{t('panels.keywords.noKeywords')}</div>
          )}
        </>
      ) : (
        <div className="kw-hint">{t('panels.keywords.selectPhotoHint')}</div>
      )}

      {/* Keyword tree */}
      {keywordTree.length > 0 && (
        <div className="kw-list">
          <div className="kw-list-header">{t('panels.keywords.allKeywords')}</div>
          <div className="kw-list-scroll">
            {keywordTree.map((node) => (
              <KeywordTreeNode
                key={node.path}
                node={node}
                depth={0}
                expanded={expandedPaths}
                onToggle={toggleExpanded}
                onClick={onKeywordFilter}
                activeKeyword={activeKeyword}
                onAddChild={hasSelection ? startAddChild : undefined}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function KeywordTreeNode({ node, depth, expanded, onToggle, onClick, onAddChild, activeKeyword }: {
  node: KeywordNode; depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onClick?: (keyword: string) => void;
  onAddChild?: (parentPath: string) => void;
  activeKeyword?: string | null;
}) {
  const { t } = useTranslation();
  const isExpanded = expanded.has(node.path);
  const hasChildren = node.children.length > 0;
  const active = activeKeyword === node.path;

  return (
    <>
      <div className={`kw-tree-item ${active ? 'active' : ''}`} style={{ paddingLeft: 8 + depth * 16 }}>
        {hasChildren ? (
          <button className="kw-tree-toggle" onClick={(e) => { e.stopPropagation(); onToggle(node.path); }}>
            {isExpanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="kw-tree-spacer" />
        )}
        <button className="kw-tree-select" onClick={() => onClick?.(active ? '' : node.path)} aria-pressed={active}>
          <span className="kw-tree-name">{node.name}</span>
          <span className="kw-tree-count">{node.totalCount}</span>
        </button>
        {onAddChild && (
          <button className="kw-tree-add" onClick={(e) => { e.stopPropagation(); onAddChild(node.path); }} title={t('panels.keywords.addChild')}>+</button>
        )}
      </div>
      {isExpanded && hasChildren && node.children.map((child) => (
        <KeywordTreeNode
          key={child.path}
          node={child}
          depth={depth + 1}
          expanded={expanded}
          onToggle={onToggle}
          onClick={onClick}
          onAddChild={onAddChild}
          activeKeyword={activeKeyword}
        />
      ))}
    </>
  );
}
