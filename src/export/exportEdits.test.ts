import { describe, expect, it } from 'vitest';
import { exportEditsFor, type OpenEditorState } from './exportEdits';
import { adjustmentsToDocument } from '../engine/DocumentModel';
import { defaultAdjustments, type Adjustments } from '../types';

const OPEN_ADJ: Adjustments = { ...defaultAdjustments, exposure: 55 };
const OPEN: OpenEditorState = { photoId: 1, adjustments: OPEN_ADJ, document: adjustmentsToDocument(OPEN_ADJ) };

const STORED: Record<string, { adjustments: Adjustments; document?: ReturnType<typeof adjustmentsToDocument> | null }> = {
  'hash-doc': {
    adjustments: { ...defaultAdjustments },
    document: adjustmentsToDocument({ ...defaultAdjustments, contrast: 12 }),
  },
  'hash-legacy': { adjustments: { ...defaultAdjustments, exposure: 30 }, document: null },
};
const getMaster = (hash: string) => STORED[hash] ?? null;

describe('exportEditsFor', () => {
  it('exports the open photo with the editor state, not its stored row', () => {
    const result = exportEditsFor({ id: 1, contentHash: 'hash-doc' }, OPEN, getMaster);
    expect(result.adjustments.exposure).toBe(55);
    expect(result.document).toBe(OPEN.document);
  });

  it('exports every other photo with its own stored document', () => {
    const result = exportEditsFor({ id: 2, contentHash: 'hash-doc' }, OPEN, getMaster);
    expect(result.adjustments.contrast).toBe(12);
    expect(result.adjustments.exposure).toBe(0);
    expect(result.document).toBe(STORED['hash-doc'].document);
  });

  it('builds the document of a row that only has adjustments', () => {
    const result = exportEditsFor({ id: 3, contentHash: 'hash-legacy' }, OPEN, getMaster);
    expect(result.adjustments.exposure).toBe(30);
    expect(result.document).not.toBeNull();
  });

  it('exports an unedited photo with the defaults, whatever is open', () => {
    for (const photo of [{ id: 4, contentHash: null }, { id: 5, contentHash: 'unknown' }]) {
      const result = exportEditsFor(photo, OPEN, getMaster);
      expect(result.adjustments).toEqual(defaultAdjustments);
      expect(result.document).toBeNull();
    }
  });

  it('treats no open photo as no open photo', () => {
    const result = exportEditsFor({ id: 2, contentHash: 'hash-legacy' }, { ...OPEN, photoId: undefined }, getMaster);
    expect(result.adjustments.exposure).toBe(30);
  });
});
