import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useRepos, useStorageRevisions } from '../contexts/StorageContext';
import type { EditRow, PhotoMetaRow, Repositories } from '../storage/repos';
import type { Adjustments } from '../types';
import {
  type DocumentUpdate,
  type PhotoDocument,
  createDocument,
  adjustmentsToDocument,
  documentToAdjustments,
  applyAdjustmentsToDocument,
} from '../engine/DocumentModel';
import { queueEditThumbnail } from '../engine/ThumbnailRenderer';
import { buildSidecar, parseSidecar, mergeSidecar, serializeSidecar } from '../engine/Sidecar';
import { perfLog } from '../platform/perfLog';
import { loadDocument, migrateAdjustments } from '../engine/loadEditDocument';
import { normalizeLoadedDocument } from '../engine/layerMasks';
import { createDocumentWriter } from './documentWriter';
import { historyStep } from './editHistory';

export function loadEditHistory(
  edit: { history?: Adjustments[]; documentHistory?: PhotoDocument[] | null },
): PhotoDocument[] {
  if (edit.documentHistory?.length) return edit.documentHistory.map(normalizeLoadedDocument);
  if (!edit.history?.length) return [];
  return edit.history.map((adj) => adjustmentsToDocument(migrateAdjustments(adj)));
}

export function historyForPersistence(hist: PhotoDocument[]): {
  history: Adjustments[];
  documentHistory: PhotoDocument[];
} {
  const documentHistory = hist.slice(-50);
  return {
    history: [],
    documentHistory,
  };
}

function metaForSidecar(row: PhotoMetaRow | null) {
  if (!row) return undefined;
  return {
    rating: row.rating ?? undefined,
    flag: row.flag,
    colorLabel: row.colorLabel,
    keywords: row.keywords,
  };
}

export interface SidecarCallbacks {
  readSidecar: () => Promise<string | null>;
  writeSidecar: (data: string) => Promise<boolean>;
}

/**
 * Take a source's sidecar into the catalog: every virtual copy the sidecar has
 * newer than the local one, and the four metadata fields when the sidecar as a
 * whole is newer than every local edit. `localEdits` is the state BEFORE this
 * call - mergeSidecar dates the metadata against it.
 */
export function applySidecar(
  raw: string,
  contentHash: string,
  localEdits: { copyIndex: number; updatedAt: number }[],
  repos: Pick<Repositories, 'edits' | 'photoMeta'>,
): { editsApplied: number; metaApplied: boolean } {
  const parsed = parseSidecar(raw);
  if (!parsed || parsed.contentHash !== contentHash) return { editsApplied: 0, metaApplied: false };

  const { editsToApply, metaToApply } = mergeSidecar(parsed, localEdits);
  for (const se of editsToApply) {
    repos.edits.upsert({
      contentHash,
      copyIndex: se.copyIndex,
      copyName: se.copyName,
      adjustments: se.adjustments,
      document: se.document,
      history: [],
      documentHistory: [],
    });
  }

  const patch: Partial<Pick<PhotoMetaRow, 'rating' | 'flag' | 'colorLabel' | 'keywords'>> = {};
  if (metaToApply) {
    if (parsed.rating !== undefined) patch.rating = parsed.rating;
    if (parsed.flag !== undefined) patch.flag = parsed.flag;
    if (parsed.colorLabel !== undefined) patch.colorLabel = parsed.colorLabel;
    if (parsed.keywords !== undefined) patch.keywords = parsed.keywords;
  }
  const metaApplied = Object.keys(patch).length > 0;
  if (metaApplied) repos.photoMeta.set(contentHash, patch);

  return { editsApplied: editsToApply.length, metaApplied };
}

export function usePhotoEdits(
  contentHash: string | null,
  sidecar?: SidecarCallbacks | null,
  /** Called after every write, so callers can mirror parts of it elsewhere. */
  onPersisted?: (contentHash: string, document: PhotoDocument) => void,
) {
  const repos = useRepos();
  const revisions = useStorageRevisions();
  // Every edit resolves against the writer's newest document, so two writes in
  // one handler both land. History push and persist timer run in the sink, not
  // inside a setState updater: React may call an updater twice (StrictMode),
  // and every side effect in it would run twice with it.
  const commitRef = useRef<(next: PhotoDocument, prev: PhotoDocument) => void>(() => {});
  const [writer] = useState(() => createDocumentWriter(createDocument(), (next, prev) => commitRef.current(next, prev)));
  const [document, setDocumentState] = useState<PhotoDocument>(() => writer.current);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<PhotoDocument[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [copyIndex, setCopyIndex] = useState(0);
  const [availableCopies, setAvailableCopies] = useState<{ index: number; name?: string }[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dirtyRef = useRef(false);
  const handledEditsRevisionRef = useRef(revisions.edits);
  const editsRevisionRef = useRef(revisions.edits);
  editsRevisionRef.current = revisions.edits;
  const copyIndexRef = useRef(copyIndex);
  copyIndexRef.current = copyIndex;

  const historyRef = useRef(history);
  const historyIndexRef = useRef(historyIndex);
  historyRef.current = history;
  historyIndexRef.current = historyIndex;

  const adjustments = useMemo(() => documentToAdjustments(document), [document]);

  /** A document that did not come from an edit: a load, a copy switch, a step through the history. */
  const adopt = useCallback((doc: PhotoDocument) => {
    writer.replace(doc);
    setDocumentState(doc);
  }, [writer]);

  useEffect(() => {
    dirtyRef.current = false;
    handledEditsRevisionRef.current = editsRevisionRef.current;
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = undefined;
    }
    adopt(createDocument());
    setHistory([]);
    setHistoryIndex(-1);
    setCopyIndex(0);
    setAvailableCopies([]);

    if (!contentHash) return;
    let cancelled = false;
    (async () => {
      const allEdits = repos.edits.listForHash(contentHash);
      perfLog.mark('image-load', `edits query (${allEdits.length} found)`);
      if (cancelled) return;

      const copies = allEdits.map((e) => ({ index: e.copyIndex, name: e.copyName ?? undefined })).sort((a, b) => a.index - b.index);
      setAvailableCopies(copies);

      const edit = allEdits.find((e) => e.copyIndex === 0) ?? allEdits[0];
      if (edit) {
        adopt(loadDocument(edit));
        const hist = loadEditHistory(edit);
        setHistory(hist);
        setHistoryIndex(hist.length);
        setCopyIndex(edit.copyIndex);
      } else {
        adopt(createDocument());
        setHistory([]);
        setHistoryIndex(0);
      }

      if (sidecar?.readSidecar && !cancelled) {
        try {
          const raw = await sidecar.readSidecar();
          perfLog.mark('image-load', `sidecar read (${raw ? raw.length + ' bytes' : 'none'})`);
          if (raw && !cancelled) {
            const localSummary = allEdits.map((e) => ({ copyIndex: e.copyIndex, updatedAt: e.updatedAt }));
            const { editsApplied } = applySidecar(raw, contentHash, localSummary, repos);
            if (editsApplied > 0 && !cancelled) {
              const refreshed = repos.edits.listForHash(contentHash);
              const master = refreshed.find((e) => e.copyIndex === 0) ?? refreshed[0];
              if (master) adopt(loadDocument(master));
            }
          }
        } catch { /* */ }
      }
    })();
    return () => { cancelled = true; };
  }, [contentHash, repos, sidecar, adopt]);

  useEffect(() => {
    if (handledEditsRevisionRef.current === revisions.edits) return;
    handledEditsRevisionRef.current = revisions.edits;
    if (!contentHash || dirtyRef.current) return;

    const allEdits = repos.edits.listForHash(contentHash);
    setAvailableCopies(allEdits
      .map((edit) => ({ index: edit.copyIndex, name: edit.copyName ?? undefined }))
      .sort((a, b) => a.index - b.index));
    const edit = allEdits.find((row) => row.copyIndex === copyIndexRef.current)
      ?? allEdits.find((row) => row.copyIndex === 0)
      ?? allEdits[0];
    if (edit) {
      adopt(loadDocument(edit));
      const hist = loadEditHistory(edit);
      setHistory(hist);
      setHistoryIndex(hist.length);
      setCopyIndex(edit.copyIndex);
    } else {
      adopt(createDocument());
      setHistory([]);
      setHistoryIndex(0);
      setCopyIndex(0);
    }
  }, [adopt, contentHash, repos, revisions.edits]);

  const persistToDb = useCallback(
    (doc: PhotoDocument, hist: PhotoDocument[]) => {
      if (!contentHash) return;
      setSaving(true);
      try {
        const adj = documentToAdjustments(doc);
        repos.edits.upsert({
          contentHash,
          copyIndex,
          adjustments: adj,
          document: doc,
          ...historyForPersistence(hist),
        });
        dirtyRef.current = false;
        queueEditThumbnail(contentHash, adj, doc);
        onPersisted?.(contentHash, doc);
      } finally {
        setSaving(false);
      }
    },
    [contentHash, copyIndex, onPersisted, repos],
  );

  const exportSidecar = useCallback(async () => {
    if (!contentHash || !sidecar?.writeSidecar) return false;
    try {
      const allEdits = repos.edits.listForHash(contentHash);
      const sidecarData = buildSidecar(
        contentHash,
        allEdits.map((e: EditRow) => ({
          copyIndex: e.copyIndex,
          copyName: e.copyName ?? undefined,
          adjustments: e.adjustments,
          document: e.document ?? undefined,
          updatedAt: e.updatedAt,
        })),
        metaForSidecar(repos.photoMeta.get(contentHash)),
        repos.exports.listForHash(contentHash).map((entry) => ({
          targetAssetId: entry.targetAssetId,
          targetSourceId: entry.targetSourceId,
          format: entry.format,
          editStackHash: entry.editStackHash,
          filename: entry.filename,
          uploadedAt: entry.uploadedAt,
          bytes: entry.bytes,
        })),
      );
      return await sidecar.writeSidecar(serializeSidecar(sidecarData));
    } catch {
      return false;
    }
  }, [contentHash, sidecar, repos]);

  const persistLater = useCallback((doc: PhotoDocument, hist: PhotoDocument[]) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => persistToDb(doc, hist), 500);
  }, [persistToDb]);

  commitRef.current = (next, prev) => {
    dirtyRef.current = true;
    const newHist = [...historyRef.current.slice(0, historyIndexRef.current), prev];
    setHistory(newHist);
    setHistoryIndex(newHist.length);
    setDocumentState(next);
    persistLater(next, newHist);
  };

  const setAdjustments = useCallback((adj: Adjustments) => {
    writer.write((prev) => applyAdjustmentsToDocument(prev, adj));
  }, [writer]);

  const setDocument = useCallback((next: DocumentUpdate) => {
    writer.write(next);
  }, [writer]);

  const stepTo = useCallback((target: number) => {
    const step = historyStep(
      { entries: historyRef.current, index: historyIndexRef.current },
      writer.current,
      target,
    );
    if (!step) return;
    dirtyRef.current = true;
    // Refs first: a second undo before the next render must see this one.
    historyRef.current = step.entries;
    historyIndexRef.current = step.index;
    setHistory(step.entries);
    setHistoryIndex(step.index);
    adopt(step.show);
    persistLater(step.show, step.persisted);
  }, [adopt, persistLater, writer]);

  const undo = useCallback(() => stepTo(historyIndexRef.current - 1), [stepTo]);
  const redo = useCallback(() => stepTo(historyIndexRef.current + 1), [stepTo]);
  const restoreToIndex = useCallback((index: number) => stepTo(index), [stepTo]);

  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < history.length;

  const createVirtualCopy = useCallback((name?: string) => {
    if (!contentHash) return;
    const newIndex = repos.edits.appendCopy({
      contentHash,
      copyName: name ?? `Kopie ${(availableCopies.length > 0 ? Math.max(...availableCopies.map((c) => c.index)) : 0) + 1}`,
      adjustments: documentToAdjustments(document),
      document,
    });
    setAvailableCopies((prev) => [...prev, { index: newIndex, name: name ?? `Kopie ${newIndex}` }]);
    setCopyIndex(newIndex);
  }, [contentHash, document, availableCopies, repos]);

  const switchCopy = useCallback((targetIndex: number) => {
    if (!contentHash || targetIndex === copyIndex) return;
    const edit = repos.edits.getCopy(contentHash, targetIndex);
    if (edit) {
      adopt(loadDocument(edit));
      const hist = loadEditHistory(edit);
      setHistory(hist);
      setHistoryIndex(hist.length);
      setCopyIndex(targetIndex);
    }
  }, [contentHash, copyIndex, repos, adopt]);

  const deleteVirtualCopy = useCallback((targetIndex: number) => {
    if (!contentHash || targetIndex === 0) return;
    repos.edits.softDelete(contentHash, targetIndex);
    setAvailableCopies((prev) => prev.filter((c) => c.index !== targetIndex));
    if (copyIndex === targetIndex) switchCopy(0);
  }, [contentHash, copyIndex, switchCopy, repos]);

  const adjustmentsHistory = useMemo(
    () => history.map(documentToAdjustments),
    [history],
  );

  return {
    adjustments,
    setAdjustments,
    document,
    setDocument,
    saving,
    history: adjustmentsHistory,
    undo,
    redo,
    canUndo,
    canRedo,
    restoreToIndex,
    copyIndex,
    availableCopies,
    createVirtualCopy,
    switchCopy,
    deleteVirtualCopy,
    exportSidecar,
  };
}
