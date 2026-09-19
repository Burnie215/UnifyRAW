import { useCallback, useMemo, useState } from 'react';
import type { SpotRemoval } from '../engine/Mask';
import type { DocumentUpdate, PhotoDocument } from '../engine/DocumentModel';
import { addRetouchSpot, removeRetouchSpot } from '../engine/documentRetouch';

/**
 * The retouch tool, written against the document.
 *
 * The spots used to live in a `useState` here. The editor is mounted with
 * `key={photo.id}` (App.tsx), so switching photo threw them away - and
 * nothing else ever saw them either: not the canvas, not the export, not the
 * thumbnail, not the sidecar, not the sync (F009). Writing them through
 * `setDocument` instead puts them where the document already goes, which is
 * all of those plus undo and redo, without a line of code per surface.
 *
 * What stays local is what is genuinely UI: which mode the tool is in and how
 * big the brush is. Neither survives a photo switch, and neither should.
 */
export function useRetouchController(
  document: PhotoDocument,
  setDocument: (next: DocumentUpdate) => void,
) {
  const [retouchMode, setRetouchMode] = useState<'heal' | 'clone' | null>(null);
  const [retouchRadius, setRetouchRadius] = useState(20);

  // A stable empty list: the document omits the field while there is nothing
  // to retouch, and a fresh `[]` per render would re-run every memo below it.
  const retouchSpots = useMemo(() => document.retouch ?? [], [document.retouch]);

  const addSpot = useCallback((spot: Omit<SpotRemoval, 'id'>) => {
    // The id is minted here so the edit itself stays pure and testable.
    const id = crypto.randomUUID();
    setDocument((prev) => addRetouchSpot(prev, spot, id));
  }, [setDocument]);

  const deleteSpot = useCallback((id: string) => {
    setDocument((prev) => removeRetouchSpot(prev, id));
  }, [setDocument]);

  return {
    retouchMode, setRetouchMode,
    retouchSpots,
    retouchRadius, setRetouchRadius,
    addSpot,
    deleteSpot,
  };
}
