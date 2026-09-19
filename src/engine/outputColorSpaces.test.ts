/**
 * Which spaces an export may be offered in.
 *
 * The export renders IN the chosen space and then has to say so, so a space
 * without an ICC profile cannot be offered: the file would go out untagged
 * and be read as sRGB. Before 2026-09-12 the dialog offered ProPhoto and
 * embedded the sRGB profile with it (Exporter.ts:195).
 */
import { describe, expect, it } from 'vitest';

import {
  exportableColorSpaces, iccProfileFor, OUTPUT_COLOR_SPACES,
  type OutputColorSpaceId,
} from './outputColorSpaces';
import { COLOR_SPACES } from './ColorSpace';

describe('exportable output colour spaces', () => {
  it('uses the output-space ids for every shared conversion space', () => {
    expect(Object.keys(COLOR_SPACES)).toEqual(['srgb', 'adobe-rgb', 'prophoto']);
    for (const [id, profile] of Object.entries(COLOR_SPACES)) {
      expect(profile.id).toBe(id);
      expect(id in OUTPUT_COLOR_SPACES).toBe(true);
    }
  });

  it('offers exactly the spaces that have a profile on file', () => {
    const offered = exportableColorSpaces().map((cs) => cs.id);
    expect(offered).toEqual(['srgb', 'adobe-rgb']);
    for (const id of Object.keys(OUTPUT_COLOR_SPACES) as OutputColorSpaceId[]) {
      expect(iccProfileFor(id) !== null).toBe(offered.includes(id));
    }
  });

  it('hands out real profile bytes, and a fresh copy each time', () => {
    const a = iccProfileFor('adobe-rgb')!;
    const b = iccProfileFor('adobe-rgb')!;
    expect(a.byteLength).toBeGreaterThan(100);
    expect(a).not.toBe(b);
    expect([...a.subarray(0, 4)]).toEqual([...b.subarray(0, 4)]);
  });

  it('has no profile for the wide-gamut spaces, which is why they are not offered', () => {
    expect(iccProfileFor('prophoto')).toBeNull();
    expect(iccProfileFor('display-p3')).toBeNull();
    expect(iccProfileFor('rec2020')).toBeNull();
  });
});
