import { afterEach, describe, expect, it } from 'vitest';
import {
  backgroundThumbnailAvailable,
  bulkOriginalReadAllowed,
  hoverPrefetchAllowed,
} from './sourcePolicy';
import { stubOnlineBuild, stubSelfhostBuild, unstubBuild } from '../../test/build';

afterEach(unstubBuild);

describe('hoverPrefetchAllowed', () => {
  it('allows the dwell only where a server renders the preview', () => {
    stubSelfhostBuild();
    // Immich is proxied: the backend turns the upload into a Smart Preview.
    expect(hoverPrefetchAllowed('immich', true)).toBe(true);
    expect(hoverPrefetchAllowed('lychee', true)).toBe(true);
    // A browser-owned folder decodes locally; the dwell would buy a download
    // of the original that nothing reads.
    expect(hoverPrefetchAllowed('local', true)).toBe(false);
    expect(hoverPrefetchAllowed('local-files', true)).toBe(false);
  });

  it('refuses every source in a build without a backend', () => {
    stubOnlineBuild();
    expect(hoverPrefetchAllowed('immich', true)).toBe(false);
    expect(hoverPrefetchAllowed('immich-v3', true)).toBe(false);
    expect(hoverPrefetchAllowed('lychee', true)).toBe(false);
    expect(hoverPrefetchAllowed('local', true)).toBe(false);
  });

  it('refuses a device without hover, where mouseenter is the tap', () => {
    stubSelfhostBuild();
    expect(hoverPrefetchAllowed('immich', false)).toBe(false);
    expect(hoverPrefetchAllowed('lychee', false)).toBe(false);
  });

  it('refuses a source type it does not know', () => {
    stubSelfhostBuild();
    expect(hoverPrefetchAllowed(undefined, true)).toBe(false);
    expect(hoverPrefetchAllowed(null, true)).toBe(false);
    expect(hoverPrefetchAllowed('not-a-source', true)).toBe(false);
  });
});

describe('bulkOriginalReadAllowed', () => {
  it('lets a pass over the whole library read only what is already on the device', () => {
    stubSelfhostBuild();
    expect(bulkOriginalReadAllowed('local')).toBe(true);
    expect(bulkOriginalReadAllowed('local-files')).toBe(true);
    // Every one of these answers over the network, so the original is the
    // expensive way to a 300 px JPEG. S3 is in the list on purpose: it has no
    // thumbnail endpoint either, and the answer is still no - a library-wide
    // download is not the price of a placeholder.
    expect(bulkOriginalReadAllowed('immich')).toBe(false);
    expect(bulkOriginalReadAllowed('immich-v3')).toBe(false);
    expect(bulkOriginalReadAllowed('lychee')).toBe(false);
    expect(bulkOriginalReadAllowed('photoprism')).toBe(false);
    expect(bulkOriginalReadAllowed('s3')).toBe(false);
  });

  it('gives the same answer in a build without a backend - the bytes decide, not the proxy', () => {
    stubOnlineBuild();
    expect(bulkOriginalReadAllowed('local')).toBe(true);
    expect(bulkOriginalReadAllowed('immich')).toBe(false);
  });

  it('refuses a source type it does not know', () => {
    expect(bulkOriginalReadAllowed(undefined)).toBe(false);
    expect(bulkOriginalReadAllowed(null)).toBe(false);
    expect(bulkOriginalReadAllowed('not-a-source')).toBe(false);
  });
});

describe('backgroundThumbnailAvailable', () => {
  it('keeps local file lists on their existing original route and skips S3 planning', () => {
    expect(backgroundThumbnailAvailable('local')).toBe(true);
    expect(backgroundThumbnailAvailable('local-files')).toBe(true);
    expect(backgroundThumbnailAvailable('immich')).toBe(true);
    expect(backgroundThumbnailAvailable('s3')).toBe(false);
  });

  it('does not plan a route for an unknown source type', () => {
    expect(backgroundThumbnailAvailable(undefined)).toBe(false);
    expect(backgroundThumbnailAvailable('not-a-source')).toBe(false);
  });
});
