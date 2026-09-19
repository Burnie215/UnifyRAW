/**
 * The promise a batch push makes: five differently edited photos become five
 * different assets in the source.
 *
 * The chain that keeps it is `exportEditsFor` (each photo's own stored edit)
 * → `editStackFingerprint` → `editStackHash` → `buildExportFilename`. The
 * source dedups on the filename, so two photos whose filenames collide would
 * land as one asset - which is exactly what the batch export bug did when
 * every entry was rendered from the open editor's document.
 */
import { describe, expect, it } from 'vitest';
import { exportEditsFor, type OpenEditorState } from './exportEdits';
import { editStackFingerprint, editStackHash, shortEditStackHash } from './editStackHash';
import { buildExportFilename } from './filename';
import { adjustmentsToDocument, type PhotoDocument } from '../engine/DocumentModel';
import { defaultAdjustments, type Adjustments } from '../types';

type StoredEdit = { adjustments: Adjustments; document?: PhotoDocument | null };

/** Five photos, five edits, none of them the one open in the editor. */
const EXPOSURES = [-40, -10, 5, 25, 60];
const PHOTOS = EXPOSURES.map((_, i) => ({
  id: i + 2,
  name: `DSC_000${i + 1}.NEF`,
  contentHash: `hash-${i + 1}`,
}));
const STORED: Record<string, StoredEdit> = Object.fromEntries(
  EXPOSURES.map((exposure, i) => {
    const adjustments = { ...defaultAdjustments, exposure };
    return [`hash-${i + 1}`, { adjustments, document: adjustmentsToDocument(adjustments) }];
  }),
);
const getMaster = (hash: string): StoredEdit | null => STORED[hash] ?? null;

// A sixth photo IS open, with a sixth edit. A batch must not borrow it.
const OPEN_ADJ: Adjustments = { ...defaultAdjustments, exposure: 99 };
const OPEN: OpenEditorState = { photoId: 1, adjustments: OPEN_ADJ, document: adjustmentsToDocument(OPEN_ADJ) };

async function pushFilenames(photos: typeof PHOTOS): Promise<string[]> {
  const names: string[] = [];
  for (const photo of photos) {
    const { adjustments, document } = exportEditsFor(photo, OPEN, getMaster);
    const hash = await editStackHash(editStackFingerprint(document, adjustments));
    names.push(buildExportFilename(photo.name, 'jpg', shortEditStackHash(hash)));
  }
  return names;
}

describe('batch push to source', () => {
  it('gives five differently edited photos five different assets', async () => {
    const names = await pushFilenames(PHOTOS);
    expect(names).toHaveLength(5);
    expect(new Set(names).size).toBe(5);
  });

  it('names no asset after the photo that happens to be open', async () => {
    const openHash = await editStackHash(editStackFingerprint(OPEN.document, OPEN.adjustments));
    const openSuffix = `_edit_${shortEditStackHash(openHash)}.jpg`;
    for (const name of await pushFilenames(PHOTOS)) {
      expect(name.endsWith(openSuffix)).toBe(false);
    }
  });

  it('gives the same edit the same asset name twice, so a re-push dedups', async () => {
    expect(await pushFilenames(PHOTOS)).toEqual(await pushFilenames(PHOTOS));
  });

  it('keeps each asset under its own original stem', async () => {
    const names = await pushFilenames(PHOTOS);
    names.forEach((name, i) => expect(name.startsWith(`DSC_000${i + 1}_edit_`)).toBe(true));
  });
});
