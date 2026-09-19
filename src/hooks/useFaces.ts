import { useState, useEffect, useCallback, useRef } from 'react';
import { useRepos, useStorageRevisions } from '../contexts/StorageContext';
import type { FaceRow, PhotoRow } from '../storage/repos';

export interface FaceGroup {
  clusterId: number;
  name: string | null;
  faces: FaceRow[];
  /** Representative face (highest confidence) */
  representative: FaceRow;
}

/**
 * Manage face detection, clustering, and naming.
 */
export function useFaces(photos: PhotoRow[]) {
  const repos = useRepos();
  const revisions = useStorageRevisions();
  const [faces, setFaces] = useState<FaceRow[]>([]);
  const [groups, setGroups] = useState<FaceGroup[]>([]);
  const [scanning, setScanning] = useState(false);
  const scannedRef = useRef(new Set<number>());

  useEffect(() => {
    const all = repos.faces.listAll();
    setFaces(all);
    buildGroups(all);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos, revisions.faces]);

  const buildGroups = useCallback((allFaces: FaceRow[]) => {
    const byCluster = new Map<number, FaceRow[]>();
    const ungrouped: FaceRow[] = [];

    for (const face of allFaces) {
      if (face.clusterId != null) {
        const arr = byCluster.get(face.clusterId) ?? [];
        arr.push(face);
        byCluster.set(face.clusterId, arr);
      } else {
        ungrouped.push(face);
      }
    }

    const result: FaceGroup[] = [];
    for (const [clusterId, members] of byCluster) {
      const sorted = members.sort((a, b) => b.confidence - a.confidence);
      result.push({
        clusterId,
        name: members.find((f) => f.name)?.name ?? null,
        faces: members,
        representative: sorted[0],
      });
    }

    for (const face of ungrouped) {
      result.push({
        clusterId: -(face.id ?? 0),
        name: face.name ?? null,
        faces: [face],
        representative: face,
      });
    }

    result.sort((a, b) => b.faces.length - a.faces.length);
    setGroups(result);
  }, []);

  const scanPhotos = useCallback(async (
    photoIds: number[] | undefined,
    getDisplayUrl: (photo: PhotoRow) => Promise<string | null>,
  ) => {
    if (scanning) return;
    setScanning(true);

    try {
      const existingFacePhotoIds = new Set(repos.faces.listAll().map((f) => f.photoId));
      const toScan = (photoIds
        ? photos.filter((p) => photoIds.includes(p.id))
        : photos
      ).filter((p) => !existingFacePhotoIds.has(p.id) && !scannedRef.current.has(p.id));

      const { detectFacesWithEmbeddings } = await import('../engine/ai');

      for (const photo of toScan) {
        scannedRef.current.add(photo.id);

        try {
          const url = await getDisplayUrl(photo);
          if (!url) continue;

          const detected = await detectFacesWithEmbeddings(url);
          if (detected.length === 0) continue;

          repos.faces.bulkAdd(detected.map((face) => ({
            photoId: photo.id,
            x: face.x,
            y: face.y,
            width: face.width,
            height: face.height,
            confidence: face.confidence,
            embedding: face.embedding.length > 0 ? face.embedding : null,
            clusterId: null,
            name: null,
            createdAt: Date.now(),
          })));
        } catch {
          // Non-critical — skip this photo
        }
      }

      const allFaces = repos.faces.listAll();
      await recluster(allFaces);
      setFaces(allFaces);
    } finally {
      setScanning(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning, photos, repos]);

  const recluster = useCallback(async (allFaces: FaceRow[]) => {
    const { clusterFaces } = await import('../engine/ai');
    const withEmbeddings = allFaces.filter((f) => f.embedding && f.embedding.length > 0);
    if (withEmbeddings.length === 0) { buildGroups(allFaces); return; }

    const clusters = clusterFaces(withEmbeddings as (FaceRow & { embedding: number[] })[]);

    const updates: { id: number; clusterId: number }[] = [];
    for (const [clusterId, indices] of clusters) {
      for (const idx of indices) {
        const face = withEmbeddings[idx];
        if (face.clusterId !== clusterId) {
          updates.push({ id: face.id, clusterId });
          face.clusterId = clusterId;
        }
      }
    }

    if (updates.length > 0) repos.faces.bulkUpdateCluster(updates);
    buildGroups(allFaces);
  }, [buildGroups, repos]);

  const renamePerson = useCallback((clusterId: number, name: string) => {
    const clusterFaces = faces.filter((f) => f.clusterId === clusterId);
    for (const f of clusterFaces) repos.faces.updateName(f.id, name);
    const updated = faces.map((f) => f.clusterId === clusterId ? { ...f, name } : f);
    setFaces(updated);
    buildGroups(updated);
  }, [faces, buildGroups, repos]);

  const getFacesForPhoto = useCallback((photoId: number): FaceRow[] => {
    return faces.filter((f) => f.photoId === photoId);
  }, [faces]);

  const getPhotosForPerson = useCallback((clusterId: number): number[] => {
    return [...new Set(faces.filter((f) => f.clusterId === clusterId).map((f) => f.photoId))];
  }, [faces]);

  return {
    faces,
    groups,
    scanning,
    scanPhotos,
    renamePerson,
    getFacesForPhoto,
    getPhotosForPerson,
  };
}
