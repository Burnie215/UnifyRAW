import { describe, expect, it } from 'vitest';
import { normalizeNumberInput } from './numberInput';

const GRID_BUFFER = { min: 1, max: 20, fallback: 3 };

describe('normalizeNumberInput', () => {
  it('takes a value inside the range as it stands', () => {
    expect(normalizeNumberInput('7', GRID_BUFFER)).toBe(7);
    expect(normalizeNumberInput(' 7 ', GRID_BUFFER)).toBe(7);
  });

  it('clamps to the range instead of storing what was typed', () => {
    expect(normalizeNumberInput('99', GRID_BUFFER)).toBe(20);
    expect(normalizeNumberInput('0', GRID_BUFFER)).toBe(1);
    expect(normalizeNumberInput('-4', GRID_BUFFER)).toBe(1);
  });

  it('rounds a fractional entry', () => {
    expect(normalizeNumberInput('7.4', GRID_BUFFER)).toBe(7);
    expect(normalizeNumberInput('7.6', GRID_BUFFER)).toBe(8);
  });

  /**
   * The field is briefly empty while someone replaces its content. Committing
   * on every keystroke turned that empty moment into the fallback and made the
   * value jump back under the cursor; the draft is only normalized on
   * blur/Enter, and only then does the fallback apply.
   */
  it('falls back for an empty or unparsable entry', () => {
    expect(normalizeNumberInput('', GRID_BUFFER)).toBe(3);
    expect(normalizeNumberInput('   ', GRID_BUFFER)).toBe(3);
    expect(normalizeNumberInput('abc', GRID_BUFFER)).toBe(3);
    expect(normalizeNumberInput('1e', GRID_BUFFER)).toBe(3);
    expect(normalizeNumberInput('Infinity', GRID_BUFFER)).toBe(3);
  });

  it('uses the range of the field it is given', () => {
    const cacheMax = { min: 50, max: 2000, fallback: 200 };
    expect(normalizeNumberInput('49', cacheMax)).toBe(50);
    expect(normalizeNumberInput('5000', cacheMax)).toBe(2000);
    expect(normalizeNumberInput('', cacheMax)).toBe(200);
  });
});
