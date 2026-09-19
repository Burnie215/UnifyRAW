import { describe, expect, it } from 'vitest';
import { DEFAULT_PRESETS } from './defaultPresets';

describe('PhotoLib default presets', () => {
  it('ships a unique, categorized starter collection', () => {
    expect(DEFAULT_PRESETS).toHaveLength(21);
    expect(new Set(DEFAULT_PRESETS.map((preset) => preset.syncId)).size).toBe(DEFAULT_PRESETS.length);
    expect(new Set(DEFAULT_PRESETS.map((preset) => preset.category))).toEqual(new Set([
      '01 · Stimmung',
      '02 · Anlässe & People',
      '03 · Landschaft',
      '04 · Farbe',
      '05 · Film-Looks',
    ]));
  });

  it('contains the requested creative directions', () => {
    const names = DEFAULT_PRESETS.map((preset) => preset.name).join(' ');
    expect(names).toMatch(/Moody/);
    expect(names).toMatch(/Sunset/);
    expect(names).toMatch(/Wedding/);
    expect(names).toMatch(/Landscape/);
    expect(names).toMatch(/Teal & Orange/);
    expect(names).toMatch(/Golden 200/);
    expect(names).toMatch(/Fuji Look/);
  });
});
