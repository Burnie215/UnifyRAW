import { describe, expect, it } from 'vitest';
import { SIDECAR_DIR, photoDirOf, sidecarPathFor } from './sidecarPath';

describe('sidecarPathFor', () => {
  it('puts the sidecar in the photo folder', () => {
    expect(sidecarPathFor('a/b', 'x.jpg')).toBe('a/b/.photolib/x.jpg.json');
  });

  it('needs no leading slash at the root', () => {
    expect(sidecarPathFor('', 'x.jpg')).toBe('.photolib/x.jpg.json');
  });

  it('keeps the whole photo name, extension included', () => {
    expect(sidecarPathFor('Urlaub 2024', 'DSC_0042.CR3')).toBe('Urlaub 2024/.photolib/DSC_0042.CR3.json');
  });

  it('names the directory once', () => {
    expect(SIDECAR_DIR).toBe('.photolib');
  });
});

describe('photoDirOf', () => {
  it('cuts the file name off', () => {
    expect(photoDirOf('a/b/x.jpg')).toBe('a/b');
  });

  it('reports the root as an empty string, not as a slash', () => {
    expect(photoDirOf('x.jpg')).toBe('');
  });
});
