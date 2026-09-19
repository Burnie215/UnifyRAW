export interface NumberInputRange {
  min: number;
  max: number;
  /** Used when the field is empty or holds something that is not a number. */
  fallback: number;
}

/**
 * Turn what someone typed into a stored number.
 *
 * A settings field is edited character by character: "", "-", "12e" are all
 * legal states on the way to a value. Committing every keystroke would turn an
 * empty field into the fallback and a half-typed "15" into 1 and then 15, so
 * the caller keeps the raw string while typing and calls this on blur or Enter.
 */
export function normalizeNumberInput(raw: string, range: NumberInputRange): number {
  const parsed = Number(raw.trim());
  if (raw.trim() === '' || !Number.isFinite(parsed)) return range.fallback;
  return Math.max(range.min, Math.min(range.max, Math.round(parsed)));
}
