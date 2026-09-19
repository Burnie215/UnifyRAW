/**
 * Leaving the editor with an edit the source has never seen.
 *
 * The question is asked at every exit out of the editor, so the answer has to
 * be one function and nothing but data: no React, no catalog handle, no
 * source object. The caller collects the five facts, this decides.
 *
 * The export ledger (table `exports`, written in `handleExport`) is the only
 * record of what left the app. There is deliberately no second marker: a
 * "dirty since export" flag would have to be kept in step with the ledger and
 * would drift the first time an export is recorded from anywhere else.
 */

export interface UnexportedEditFacts {
  /** The `exportReminder` preference. False silences the question entirely. */
  reminderEnabled: boolean;
  /**
   * Can we push back to the source at all? A read-only source has no export
   * to be behind on, so there is nothing to warn about.
   */
  sourceWritable: boolean;
  /** Is there an edit? An untouched photo never gets asked about. */
  hasEdit: boolean;
  /**
   * Fingerprint of what the editor would render right now
   * (`editStackHash(editStackFingerprint(document, adjustments))`), or null
   * when it could not be computed.
   */
  editStackHash: string | null;
  /**
   * `editStackHash` of the newest ledger entry for this photo, copy and
   * source, or null when the ledger has none.
   */
  lastExportedStackHash: string | null;
}

/**
 * True when the user should be asked before leaving.
 *
 * Two ways to be behind: the ledger knows no export at all, or it knows one
 * of a different edit stack. A hash we could not compute is treated as "do
 * not nag": the photo was exported once, and an unprovable difference is a
 * worse reason to interrupt someone than no difference at all.
 */
export function shouldWarnUnexportedEdit(facts: UnexportedEditFacts): boolean {
  if (!facts.reminderEnabled) return false;
  if (!facts.sourceWritable) return false;
  if (!facts.hasEdit) return false;
  if (facts.lastExportedStackHash === null) return true;
  if (facts.editStackHash === null) return false;
  return facts.lastExportedStackHash !== facts.editStackHash;
}
