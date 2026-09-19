import { describe, expect, it } from 'vitest';
import { CATALOG_PICKER_OPTIONS, CHROME_BLOCKED_PICKER_ROOTS } from './createStorage';

describe('catalog folder picker', () => {
  // Opening the dialog in a folder Chrome refuses made "confirm the suggested
  // location" end in a second pick.
  it('does not open in a folder Chrome refuses to hand out', () => {
    const startIn = (CATALOG_PICKER_OPTIONS as { startIn?: string }).startIn;
    expect(CHROME_BLOCKED_PICKER_ROOTS as readonly string[]).not.toContain(startIn);
  });

  it('asks for write access in the same prompt and remembers the last folder', () => {
    expect(CATALOG_PICKER_OPTIONS).toMatchObject({ mode: 'readwrite', id: 'photolib-catalog' });
  });
});
