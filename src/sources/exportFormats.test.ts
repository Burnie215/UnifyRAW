/**
 * Which write-back target accepts a linear DNG, source by source.
 *
 * The answer cannot be measured from here - it lives in somebody else's
 * upload validator - so it is a research result pinned as a test, with the
 * evidence in the comments next to each declaration. What this file does
 * enforce is that the answer is never given by accident: a source that says
 * nothing gets the old three formats, and DNG has to be granted on purpose.
 */
import { describe, expect, it } from 'vitest';

import { ImmichSource } from './ImmichSource';
import { ImmichV3Source } from './ImmichV3Source';
import { LycheeSource } from './LycheeSource';
import { planExportChoices } from '../export/exportChoices';

const immich = () => new ImmichSource('immich', 'Immich', {
  serverUrl: 'https://immich.example.test', apiKey: 'k', transport: 'browser-direct',
});
const immichV3 = () => new ImmichV3Source('immich', 'Immich', {
  serverUrl: 'https://immich.example.test', apiKey: 'k', transport: 'browser-direct',
});
const lychee = () => new LycheeSource('lychee', 'Lychee', {
  serverUrl: 'https://lychee.example.test', apiToken: 't', transport: 'browser-direct',
});

describe('who accepts a linear DNG', () => {
  it('Immich does: .dng is in its own asset extension map', () => {
    expect(immich().exportCapabilities.allowedFormats).toEqual(['jpg', 'tif', 'png', 'dng']);
  });

  it('Immich v3 inherits the same answer, being the same product', () => {
    expect(immichV3().exportCapabilities.allowedFormats)
      .toEqual(immich().exportCapabilities.allowedFormats);
  });

  it('Lychee does not: its accept-list needs Imagick or a hand-edited setting', () => {
    // `SUPPORTED_IMAGE_FILE_EXTENSIONS` has no .dng and no .tif;
    // `CONVERTIBLE_RAW_EXTENSIONS` has .dng but is only merged in when the
    // instance has Imagick. Not detectable from a browser.
    expect(lychee().exportCapabilities.allowedFormats).toEqual(['jpg', 'png']);
  });
});

describe('what that means in the dialog', () => {
  const request = {
    destination: 'source' as const,
    format: 'tiff' as const,
    bitDepth: 16 as const,
    sourceCanExport16Bit: true,
  };

  it('offers DNG for an Immich push and not for a Lychee one', () => {
    expect(planExportChoices({
      ...request, allowedSourceFormats: immich().exportCapabilities.allowedFormats,
    }).formats).toContain('dng');
    expect(planExportChoices({
      ...request, allowedSourceFormats: lychee().exportCapabilities.allowedFormats,
    }).formats).not.toContain('dng');
  });

  it('never grants DNG to a source that declared no formats at all', () => {
    // Most sources are read-only and have no `exportCapabilities`; the default
    // list stands in for them and must not quietly widen.
    expect(planExportChoices({ ...request, allowedSourceFormats: undefined }).formats)
      .not.toContain('dng');
  });
});
