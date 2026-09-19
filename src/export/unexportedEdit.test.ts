import { describe, expect, it } from 'vitest';
import { shouldWarnUnexportedEdit, type UnexportedEditFacts } from './unexportedEdit';

/** An edit that was exported, and then edited further. The warning case. */
const BEHIND: UnexportedEditFacts = {
  reminderEnabled: true,
  sourceWritable: true,
  hasEdit: true,
  editStackHash: 'bbbb',
  lastExportedStackHash: 'aaaa',
};

describe('shouldWarnUnexportedEdit', () => {
  it('warns when the edit moved on after the last export', () => {
    expect(shouldWarnUnexportedEdit(BEHIND)).toBe(true);
  });

  it('warns when the ledger knows no export for this photo', () => {
    expect(shouldWarnUnexportedEdit({ ...BEHIND, lastExportedStackHash: null })).toBe(true);
  });

  it('stays quiet when the ledger matches what the editor would render', () => {
    expect(shouldWarnUnexportedEdit({ ...BEHIND, lastExportedStackHash: 'bbbb' })).toBe(false);
  });

  it('stays quiet without an edit, even with nothing in the ledger', () => {
    expect(shouldWarnUnexportedEdit({
      ...BEHIND, hasEdit: false, lastExportedStackHash: null,
    })).toBe(false);
  });

  it('stays quiet when the source cannot be written to', () => {
    expect(shouldWarnUnexportedEdit({ ...BEHIND, sourceWritable: false })).toBe(false);
    expect(shouldWarnUnexportedEdit({
      ...BEHIND, sourceWritable: false, lastExportedStackHash: null,
    })).toBe(false);
  });

  it('stays quiet once the reminder is switched off', () => {
    expect(shouldWarnUnexportedEdit({ ...BEHIND, reminderEnabled: false })).toBe(false);
    expect(shouldWarnUnexportedEdit({
      ...BEHIND, reminderEnabled: false, lastExportedStackHash: null,
    })).toBe(false);
  });

  it('does not nag when the current hash is unknown but an export exists', () => {
    expect(shouldWarnUnexportedEdit({ ...BEHIND, editStackHash: null })).toBe(false);
  });

  it('still warns when the current hash is unknown and nothing was exported', () => {
    expect(shouldWarnUnexportedEdit({
      ...BEHIND, editStackHash: null, lastExportedStackHash: null,
    })).toBe(true);
  });

  it('treats every gate as a veto on its own', () => {
    const vetoes: Partial<UnexportedEditFacts>[] = [
      { reminderEnabled: false },
      { sourceWritable: false },
      { hasEdit: false },
    ];
    for (const veto of vetoes) {
      expect(shouldWarnUnexportedEdit({ ...BEHIND, ...veto })).toBe(false);
    }
  });
});
