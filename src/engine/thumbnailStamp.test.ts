import { describe, it, expect, beforeEach } from 'vitest';
import { thumbnailStampFor } from './thumbnailStamp';
import { setDevelopProfiles } from './developProfileStore';
import { setLensProfiles } from './lensProfileStore';
import { editThumbnailKey } from '../cache/editThumbnailKey';
import type { DevelopProfile } from './developProfile';
import type { MeasuredLensProfile } from './lensProfile';

const developProfile = (over: Partial<DevelopProfile> = {}): DevelopProfile => ({
  syncId: 'dp-1',
  name: 'Fuji base',
  scope: 'extension',
  key: 'raf',
  isoFrom: null,
  isoTo: null,
  adjustments: { exposure: -60 },
  updatedAt: 1000,
  ...over,
});

const lensProfile = (over: Partial<MeasuredLensProfile> = {}): MeasuredLensProfile => ({
  syncId: 'lp-1',
  name: 'XF 23mm',
  key: 'xf23mmf14r',
  focalFrom: null,
  focalTo: null,
  updatedAt: 2000,
  k1: 0.01, k2: 0, k3: 0,
  v1: 0, v2: 0, v3: 0,
  caR: 0, caB: 0,
  ...over,
});

describe('thumbnailStampFor', () => {
  beforeEach(() => {
    setDevelopProfiles([]);
    setLensProfiles([]);
  });

  it('is null when nothing develops the photo, so the key stays what it was', () => {
    expect(thumbnailStampFor({ name: 'a.raf' })).toBeNull();
    expect(editThumbnailKey('hash', thumbnailStampFor({ name: 'a.raf' }))).toBe('edit:hash');
  });

  it('is null for a non-RAW even while profiles exist', () => {
    setDevelopProfiles([developProfile()]);
    setLensProfiles([lensProfile()]);
    // The lens profile matches by name and knows nothing about RAW, so this
    // is the case that would otherwise retire a JPEG thumbnail for nothing.
    expect(thumbnailStampFor({ name: 'a.jpg', lens: 'XF 23mm F1.4 R' })).toBeNull();
  });

  it('appears once a profile covers the photo', () => {
    setDevelopProfiles([developProfile()]);
    const stamp = thumbnailStampFor({ name: 'a.raf' });
    expect(stamp).not.toBeNull();
    expect(editThumbnailKey('hash', stamp)).toBe(`edit:${stamp}:hash`);
  });

  it('moves when the profile is edited, which is what retires the old thumbnail', () => {
    setDevelopProfiles([developProfile()]);
    const before = thumbnailStampFor({ name: 'a.raf' });
    setDevelopProfiles([developProfile({ updatedAt: 1001, adjustments: { exposure: -20 } })]);
    expect(thumbnailStampFor({ name: 'a.raf' })).not.toBe(before);
  });

  it('does not move when an unrelated profile is added', () => {
    setDevelopProfiles([developProfile()]);
    const before = thumbnailStampFor({ name: 'a.raf' });
    setDevelopProfiles([developProfile(), developProfile({ syncId: 'dp-2', key: 'nef' })]);
    expect(thumbnailStampFor({ name: 'a.raf' })).toBe(before);
  });

  it('is stable across repeated reads - a reload must not discard thumbnails', () => {
    setDevelopProfiles([developProfile()]);
    const first = thumbnailStampFor({ name: 'a.raf' });
    setDevelopProfiles([developProfile()]);
    expect(thumbnailStampFor({ name: 'a.raf' })).toBe(first);
  });

  it('covers the lens profile too', () => {
    const subject = { name: 'a.raf', lens: 'XF 23mm F1.4 R' };
    setLensProfiles([lensProfile()]);
    const before = thumbnailStampFor(subject);
    expect(before).not.toBeNull();
    setLensProfiles([lensProfile({ updatedAt: 2001, k1: 0.02 })]);
    expect(thumbnailStampFor(subject)).not.toBe(before);
  });

  it('separates a develop-only photo from a lens-only one', () => {
    setDevelopProfiles([developProfile()]);
    setLensProfiles([lensProfile()]);
    const both = thumbnailStampFor({ name: 'a.raf', lens: 'XF 23mm F1.4 R' });
    const developOnly = thumbnailStampFor({ name: 'a.raf', lens: 'Some Other Lens' });
    expect(both).not.toBe(developOnly);
  });
});
