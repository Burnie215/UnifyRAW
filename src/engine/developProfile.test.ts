import { describe, expect, it } from 'vitest';
import { defaultAdjustments, type Adjustments } from '../types';
import {
  describeProfileScope,
  toBaseProfileAdjustments,
  extensionKey,
  normaliseCameraKey,
  selectDevelopProfile,
  type DevelopProfile,
} from './developProfile';

function profile(p: Partial<DevelopProfile> & Pick<DevelopProfile, 'scope' | 'key'>): DevelopProfile {
  return {
    syncId: `${p.scope}:${p.key}:${p.isoFrom ?? ''}`,
    name: 'p',
    isoFrom: null,
    isoTo: null,
    adjustments: {},
    updatedAt: 1,
    ...p,
  };
}

describe('normaliseCameraKey', () => {
  it('folds case and spacing so two spellings of one body agree', () => {
    expect(normaliseCameraKey('  FUJIFILM   X-T5 ')).toBe('fujifilm x-t5');
  });

  it('drops a make the model repeats', () => {
    // Immich writes "Make Model" and the model already carries the make.
    expect(normaliseCameraKey('NIKON CORPORATION NIKON Z 8')).toBe('nikon z 8');
  });

  it('drops a bare "corporation" suffix', () => {
    expect(normaliseCameraKey('NIKON CORPORATION D850')).toBe('nikon d850');
  });

  it('treats a missing camera as no key at all', () => {
    expect(normaliseCameraKey(null)).toBe('');
    expect(normaliseCameraKey('   ')).toBe('');
  });
});

describe('extensionKey', () => {
  it('reads the extension in lower case', () => {
    expect(extensionKey('DSCF1234.RAF')).toBe('raf');
  });
  it('returns nothing for a name without one', () => {
    expect(extensionKey('scan')).toBe('');
  });
});

describe('selectDevelopProfile', () => {
  const byExtension = profile({ scope: 'extension', key: 'raf' });
  const byCamera = profile({ scope: 'camera', key: 'fujifilm x-t5' });
  const byCameraHighIso = profile({ scope: 'camera', key: 'fujifilm x-t5', isoFrom: 3200, isoTo: null });

  const subject = { name: 'DSCF1.RAF', camera: 'FUJIFILM X-T5', iso: 200 };

  it('covers a photo by its format when nothing more specific exists', () => {
    expect(selectDevelopProfile([byExtension], subject)?.key).toBe('raf');
  });

  it('lets the body beat the format', () => {
    expect(selectDevelopProfile([byExtension, byCamera], subject)?.key).toBe('fujifilm x-t5');
  });

  it('lets an ISO band beat the body, but only inside the band', () => {
    const all = [byExtension, byCamera, byCameraHighIso];
    expect(selectDevelopProfile(all, { ...subject, iso: 6400 })).toBe(byCameraHighIso);
    expect(selectDevelopProfile(all, { ...subject, iso: 200 })).toBe(byCamera);
  });

  it('still covers a photo whose provider indexed no camera name', () => {
    // Dropbox and SmugMug write no camera at all - a camera-keyed profile
    // cannot match, and without the format floor the photo would get nothing.
    const found = selectDevelopProfile([byExtension, byCamera], { name: 'a.raf', camera: null, iso: null });
    expect(found).toBe(byExtension);
  });

  it('does not apply an ISO-banded profile to a photo with no ISO recorded', () => {
    expect(selectDevelopProfile([byCameraHighIso], { ...subject, iso: null })).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(selectDevelopProfile([byExtension], { name: 'a.cr2', camera: 'Canon R5', iso: 100 })).toBeNull();
  });

  it('breaks a tie by which profile was touched last', () => {
    const older = profile({ scope: 'camera', key: 'fujifilm x-t5', updatedAt: 10 });
    const newer = profile({ scope: 'camera', key: 'fujifilm x-t5', updatedAt: 20, syncId: 'newer' });
    expect(selectDevelopProfile([older, newer], subject)).toBe(newer);
    expect(selectDevelopProfile([newer, older], subject)).toBe(newer);
  });
});

describe('describeProfileScope', () => {
  it('says what a profile covers', () => {
    expect(describeProfileScope(profile({ scope: 'extension', key: 'raf' }))).toBe('alle .RAF');
    expect(describeProfileScope(profile({ scope: 'camera', key: 'canon r5', isoFrom: 3200 })))
      .toBe('CANON R5, ISO 3200 und höher');
    expect(describeProfileScope(profile({ scope: 'camera', key: 'canon r5', isoFrom: 100, isoTo: 800 })))
      .toBe('CANON R5, ISO 100-800');
  });
});

describe('toBaseProfileAdjustments', () => {
  it('keeps only what the base stage can render', () => {
    const neutral = { ...defaultAdjustments };
    const tuned: Adjustments = {
      ...defaultAdjustments,
      exposure: 15,
      saturation: -20,
      // None of these have a base: node - storing them would be a promise the
      // renderer never keeps.
      vignette: -40,
      rotation: 5,
      bwEnabled: true,
    };
    const saved = toBaseProfileAdjustments(tuned, neutral);
    expect(saved).toEqual({ exposure: 15, saturation: -20 });
  });

  it('drops values that are already neutral', () => {
    const saved = toBaseProfileAdjustments({ ...defaultAdjustments }, { ...defaultAdjustments });
    expect(Object.keys(saved)).toHaveLength(0);
  });

  it('keeps a changed curve, which is an object rather than a number', () => {
    const tuned: Adjustments = {
      ...defaultAdjustments,
      toneCurve: { ...defaultAdjustments.toneCurve, rgb: [{ x: 0, y: 0.1 }, { x: 1, y: 1 }] },
    };
    expect(toBaseProfileAdjustments(tuned, { ...defaultAdjustments }).toneCurve).toBeDefined();
  });
});
