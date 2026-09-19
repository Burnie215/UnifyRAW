import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { sourceManager } from '../sources';
import { setOnSidecarThumbWritten } from './useBackgroundThumbnails';
import type { SourceRow, PhotoView } from '../storage/repos';
import { useRepos } from '../contexts/StorageContext';
import type { SidecarSourceInfo } from '../components/SettingsDialog';
import type { LocalSource } from '../sources/LocalSource';
import { generateThumbnailBlob, THUMB_LONG_EDGE } from '../engine/thumbnail/generateThumbnailBlob';

export function useSidecarManager(
  sources: SourceRow[],
  photos: PhotoView[],
  showSettings: boolean,
) {
  const repos = useRepos();
  const [sidecarBusy, setSidecarBusy] = useState(false);
  const [sidecarSources, setSidecarSources] = useState<SidecarSourceInfo[]>([]);
  const [cachedThumbCount, setCachedThumbCount] = useState(0);

  // Thumb count: only .dat persistent count
  const thumbCountRef = useRef({ count: 0 });
  const lastCountedPhotosLen = useRef(0);
  useEffect(() => {
    if (sources.length === 0 || photos.length === 0) return;
    if (photos.length === lastCountedPhotosLen.current) return;
    lastCountedPhotosLen.current = photos.length;

    (async () => {
      try {
        let total = 0;
        for (const s of sources) {
          const sp = sourceManager.get(s.id);
          if (sp && 'sidecarThumbCount' in sp) {
            total += await (sp as LocalSource).sidecarThumbCount();
          }
        }
        thumbCountRef.current.count = total;
        setCachedThumbCount(total);
      } catch { /* */ }
    })();
  }, [sources, photos.length]);

  // Wire up sidecar thumb callback — read actual count (sync, no I/O)
  const refreshThumbCount = useCallback(() => {
    let total = 0;
    for (const s of sources) {
      const sp = sourceManager.get(s.id);
      if (sp && 'sidecarThumbCountSync' in sp) {
        total += (sp as unknown as { sidecarThumbCountSync: number }).sidecarThumbCountSync;
      }
    }
    thumbCountRef.current.count = total;
    setCachedThumbCount(total);
  }, [sources]);
  setOnSidecarThumbWritten(refreshThumbCount);

  // Build sidecar info when settings open
  useEffect(() => {
    if (!showSettings) return;
    let cancelled = false;

    (async () => {
      const infos: SidecarSourceInfo[] = [];

      for (const source of sources) {
        if (cancelled) break;
        const sp = sourceManager.get(source.id);
        if (!sp || !('getDirHandle' in sp)) continue;
        const localSp = sp as LocalSource;
        const store = localSp.store;

        const info: SidecarSourceInfo = {
          sourceId: source.id, label: source.label,
          thumbCount: 0, thumbSizeKB: 0, editCount: 0, editSizeKB: 0, paths: [],
        };

        if (store) {
          try {
            const index = await store.getIndex();
            for (const entry of Object.values(index)) {
              if (entry.t) info.thumbCount++;
              if (entry.e) info.editCount++;
            }
            const dirHandle = localSp.getDirHandle();
            if (dirHandle) {
              try {
                const plDir = await dirHandle.getDirectoryHandle('.photolib');
                // Try V2 index.json size
                try {
                  const indexFile = await (await plDir.getFileHandle('index.json')).getFile();
                  info.thumbSizeKB += Math.round(indexFile.size / 1024);
                } catch { /* */ }
                // Try thumbs/ directory size
                try {
                  const thumbsDir = await plDir.getDirectoryHandle('thumbs');
                  for await (const entry of thumbsDir.values()) {
                    if (entry.kind === 'file') {
                      const file = await (entry as FileSystemFileHandle).getFile();
                      info.thumbSizeKB += Math.round(file.size / 1024);
                    }
                  }
                } catch { /* */ }
              } catch { /* */ }
            }
          } catch { /* */ }
        }

        infos.push(info);
      }

      if (!cancelled) {
        setSidecarSources(infos);
        const datTotal = infos.reduce((s, x) => s + x.thumbCount, 0);
        if (datTotal > thumbCountRef.current.count) {
          thumbCountRef.current.count = datTotal;
          setCachedThumbCount(datTotal);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [showSettings, sources]);

  const handleRegenerateSidecarThumbs = useCallback(async (filterSourceId?: string) => {
    setSidecarBusy(true);
    try {
      const targetPhotos = filterSourceId ? photos.filter((p) => p.sourceId === filterSourceId) : photos;
      for (const photo of targetPhotos) {
        if (!photo.id) continue;
        const sp = sourceManager.get(photo.sourceId);
        if (!sp || !('writeSidecarThumb' in sp)) continue;
        const ref = { sourcePhotoId: photo.sourcePhotoId, sourceId: photo.sourceId, name: photo.name };
        try {
          const file = await sp.getFile(ref);
          if (!file) continue;
          const blob = await generateThumbnailBlob(file, THUMB_LONG_EDGE, 0.7);
          await (sp as unknown as { writeSidecarThumb: (r: typeof ref, b: Blob) => Promise<boolean> }).writeSidecarThumb(ref, blob);
        } catch { /* */ }
      }
    } finally {
      setSidecarBusy(false);
    }
  }, [photos]);

  const handleDeleteSidecarThumbs = useCallback(async (filterSourceId?: string) => {
    setSidecarBusy(true);
    try {
      const targetSources = filterSourceId ? sources.filter((s) => s.id === filterSourceId) : sources;
      for (const source of targetSources) {
        const sp = sourceManager.get(source.id);
        if (!sp || !('getDirHandle' in sp)) continue;
        await (sp as LocalSource).deleteSidecarData();
      }
      thumbCountRef.current.count = 0;
      setCachedThumbCount(0);
      repos.photos.bulkUpdate(repos.photos.listRaw().map((p) => ({ id: p.id, patch: { blurHash: null } })));
    } finally {
      setSidecarBusy(false);
    }
  }, [sources, repos.photos]);

  // Count photos from sources that USE the sidecar (= LocalSource with
  // a .photolib directory). Photos from remote sources like Immich/Lychee
  // serve thumbnails directly + never populate the sidecar counter, so they
  // shouldn't be in the IndexingStatus denominator either — otherwise an
  // Immich-only library shows 0% forever.
  const sidecarPhotoCount = useMemo(() => {
    const sidecarSourceIds = new Set<string>();
    for (const s of sources) {
      const sp = sourceManager.get(s.id);
      if (sp && 'sidecarThumbCount' in sp) sidecarSourceIds.add(s.id);
    }
    if (sidecarSourceIds.size === 0) return 0;
    let n = 0;
    for (const p of photos) {
      if (sidecarSourceIds.has(p.sourceId)) n++;
    }
    return n;
  }, [sources, photos]);

  return {
    sidecarBusy,
    sidecarSources,
    cachedThumbCount,
    sidecarPhotoCount,
    handleRegenerateSidecarThumbs,
    handleDeleteSidecarThumbs,
  };
}
