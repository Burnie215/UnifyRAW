import { describe, expect, it } from 'vitest';
import { formatShutterSpeed } from './statusBarFormatting';

describe('formatShutterSpeed', () => {
  it('adds the seconds unit to fractional exposure times', () => {
    expect(formatShutterSpeed('1/250')).toBe('1/250s');
  });

  it('does not duplicate an existing unit', () => {
    expect(formatShutterSpeed('2s')).toBe('2s');
    expect(formatShutterSpeed('1 sec')).toBe('1 sec');
  });

  it('omits missing exposure values', () => {
    expect(formatShutterSpeed(undefined)).toBeNull();
  });
});
