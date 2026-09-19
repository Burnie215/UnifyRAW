import { describe, expect, it } from 'vitest';
import { resetLookPreferences, type UiPreferences } from './useUiPreferences';

const CUSTOM: UiPreferences = {
  fontSize: 'lg',
  accent: 'red',
  theme: 'light',
  compact: true,
  sidebarWidth: 'wide',
  exportReminder: false,
};

describe('resetLookPreferences', () => {
  it('restores every look setting', () => {
    const next = resetLookPreferences(CUSTOM);
    expect(next.fontSize).toBe('md');
    expect(next.accent).toBe('blue');
    expect(next.theme).toBe('dark');
    expect(next.compact).toBe(false);
    expect(next.sidebarWidth).toBe('normal');
  });

  it('leaves the export reminder alone in both positions', () => {
    expect(resetLookPreferences(CUSTOM).exportReminder).toBe(false);
    expect(resetLookPreferences({ ...CUSTOM, exportReminder: true }).exportReminder).toBe(true);
  });

  it('does not mutate what it was handed', () => {
    const before = { ...CUSTOM };
    resetLookPreferences(CUSTOM);
    expect(CUSTOM).toEqual(before);
  });
});
