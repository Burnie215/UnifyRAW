import { describe, expect, it } from 'vitest';
import exifr from 'exifr';

import { adjustmentsToXMP, originalSourceUri } from '../data/xmp';
import { defaultAdjustments } from '../types';
import { buildExifBlock, exifDateTime, metadataFor, type ExportMetadata } from './exportMetadata';
import { embedExifInJpeg, embedIccInJpeg, embedXmpInJpeg } from './JpegSegments';
import { encodeFrame, type RenderedFrame16 } from './Exporter';
import { embedExifInPng, embedXmpInPng } from './PngChunks';
import { encodePng16 } from './PngEncoder';
import { encodeTiff } from './TiffEncoder';

const DATE_TAKEN = new Date(2024, 4, 17, 9, 41, 12).getTime();
const SOURCE_URI = originalSourceUri('immich-1', 'asset-42');
const EDIT_STACK_HASH = 'a3f8c1d2e5b40917a3f8c1d2e5b40917a3f8c1d2e5b40917a3f8c1d2e5b40917';
const ORIGINAL_CHECKSUM = '0123456789abcdef0123456789abcdef';

function linkedMetadata(): ExportMetadata {
  return {
    dateTaken: DATE_TAKEN,
    software: 'UnifyRAW',
    xmp: adjustmentsToXMP(defaultAdjustments, {
      source: SOURCE_URI,
      editStackHash: EDIT_STACK_HASH,
      originalChecksum: ORIGINAL_CHECKSUM,
    }),
  };
}

/** SOI, an empty scan, EOI. Enough structure for a segment reader. */
function minimalJpeg(): Blob {
  return new Blob([new Uint8Array([0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9])], {
    type: 'image/jpeg',
  });
}

/** The export order from `encodeFrame`: each writer inserts at the front. */
async function exportedJpeg(metadata: ExportMetadata): Promise<Uint8Array> {
  let blob = await embedIccInJpeg(minimalJpeg(), new Uint8Array([1, 2, 3, 4]));
  if (metadata.xmp) blob = await embedXmpInJpeg(blob, metadata.xmp);
  blob = await embedExifInJpeg(blob, metadata);
  return new Uint8Array(await blob.arrayBuffer());
}

async function exportedPng(metadata: ExportMetadata): Promise<Uint8Array> {
  let blob = await encodePng16(new Uint16Array([0, 0, 0, 65535]), {
    width: 1, height: 1, channels: 4,
  });
  if (metadata.xmp) blob = await embedXmpInPng(blob, metadata.xmp);
  blob = await embedExifInPng(blob, metadata);
  return new Uint8Array(await blob.arrayBuffer());
}

async function exportedTiff(metadata: ExportMetadata): Promise<Uint8Array> {
  const blob = await encodeTiff(new Uint8Array([10, 20, 30, 255]), {
    width: 1, height: 1, bits: 8, compression: 'none', metadata,
  });
  return new Uint8Array(await blob.arrayBuffer());
}

interface ReadBack {
  ifd0?: { Software?: string; ModifyDate?: Date };
  exif?: { DateTimeOriginal?: Date };
  dc?: { source?: string };
  unifyraw?: { editStackHash?: string; originalChecksum?: string };
}

/** Grouped by block and namespace, so a field is checked where it belongs. */
function readBack(bytes: Uint8Array): Promise<ReadBack> {
  return exifr.parse(bytes, { xmp: true, mergeOutput: false }) as Promise<ReadBack>;
}

function frame16(): RenderedFrame16 {
  return {
    width: 1, height: 1, pixels: new Uint16Array([0, 0, 0, 65535]),
    bitDepth: 16, colorSpace: 'srgb',
  };
}

function asLatin1(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes);
}

describe('export metadata', () => {
  it('writes EXIF dates as local wall-clock time', () => {
    expect(exifDateTime(DATE_TAKEN)).toBe('2024:05:17 09:41:12');
    expect(exifDateTime(null)).toBeNull();
    expect(exifDateTime(Number.NaN)).toBeNull();
  });

  it('builds no EXIF block when neither date nor software is known', () => {
    expect(buildExifBlock({ xmp: '<x:xmpmeta/>' })).toBeNull();
    expect(buildExifBlock({ software: '   ' })).toBeNull();
  });

  it('drops EXIF but keeps the XMP link when metadata is excluded', () => {
    const kept = metadataFor(linkedMetadata(), false);
    expect(kept?.dateTaken).toBeUndefined();
    expect(kept?.software).toBeUndefined();
    expect(kept?.xmp).toContain(EDIT_STACK_HASH);
    expect(metadataFor(linkedMetadata(), true)?.software).toBe('UnifyRAW');
    expect(metadataFor({ dateTaken: DATE_TAKEN }, false)).toBeUndefined();
    expect(metadataFor(undefined, true)).toBeUndefined();
  });

  it('names the original by source and asset', () => {
    expect(originalSourceUri('immich-1', 'asset-42'))
      .toBe('unifyraw://source/immich-1/asset/asset-42');
    expect(originalSourceUri('a b', 'c/d')).toBe('unifyraw://source/a%20b/asset/c%2Fd');
  });

  it('leaves the sidecar packet untouched without a link', () => {
    expect(adjustmentsToXMP(defaultAdjustments)).not.toContain('xmlns:dc=');
    expect(adjustmentsToXMP(defaultAdjustments)).not.toContain('unifyraw:');
  });

  it('escapes link values that would otherwise break the packet', () => {
    const xmp = adjustmentsToXMP(defaultAdjustments, { source: 'a&b"<c>' });
    expect(xmp).toContain('dc:source="a&amp;b&quot;&lt;c&gt;"');
  });

  it('reads the five fields back out of a JPEG', async () => {
    const bytes = await exportedJpeg(linkedMetadata());
    const tags = await readBack(bytes);
    expect(tags.ifd0?.Software).toBe('UnifyRAW');
    expect(tags.exif?.DateTimeOriginal?.getTime()).toBe(DATE_TAKEN);
    expect(tags.dc?.source).toBe(SOURCE_URI);
    expect(tags.unifyraw?.editStackHash).toBe(EDIT_STACK_HASH);
    expect(tags.unifyraw?.originalChecksum).toBe(ORIGINAL_CHECKSUM);

    // EXIF APP1, XMP APP1, ICC APP2 - in that order, right after SOI.
    const text = asLatin1(bytes);
    expect(text.indexOf('Exif\0\0')).toBeLessThan(text.indexOf('http://ns.adobe.com/xap/1.0/'));
    expect(text.indexOf('http://ns.adobe.com/xap/1.0/')).toBeLessThan(text.indexOf('ICC_PROFILE'));
  });

  it('reads the five fields back out of a TIFF', async () => {
    const tags = await readBack(await exportedTiff(linkedMetadata()));
    expect(tags.ifd0?.Software).toBe('UnifyRAW');
    // TIFF carries the capture time as DateTime (306), its own IFD's tag.
    expect(tags.ifd0?.ModifyDate?.getTime()).toBe(DATE_TAKEN);
    expect(tags.dc?.source).toBe(SOURCE_URI);
    expect(tags.unifyraw?.editStackHash).toBe(EDIT_STACK_HASH);
    expect(tags.unifyraw?.originalChecksum).toBe(ORIGINAL_CHECKSUM);
  });

  it('reads the five fields back out of a PNG', async () => {
    const tags = await readBack(await exportedPng(linkedMetadata()));
    expect(tags.ifd0?.Software).toBe('UnifyRAW');
    expect(tags.exif?.DateTimeOriginal?.getTime()).toBe(DATE_TAKEN);
    expect(tags.dc?.source).toBe(SOURCE_URI);
    expect(tags.unifyraw?.editStackHash).toBe(EDIT_STACK_HASH);
    expect(tags.unifyraw?.originalChecksum).toBe(ORIGINAL_CHECKSUM);
  });

  it('carries the metadata from encodeFrame into the container', async () => {
    for (const format of ['tiff', 'png'] as const) {
      const blob = await encodeFrame(frame16(), { format, quality: 100, metadata: linkedMetadata() });
      const tags = await readBack(new Uint8Array(await blob.arrayBuffer()));
      expect(tags.ifd0?.Software, format).toBe('UnifyRAW');
      expect(tags.dc?.source, format).toBe(SOURCE_URI);
      expect(tags.unifyraw?.editStackHash, format).toBe(EDIT_STACK_HASH);
    }
  });

  it('writes no EXIF at all when the metadata carries only the link', async () => {
    const linkOnly = metadataFor(linkedMetadata(), false)!;

    const jpeg = await exportedJpeg(linkOnly);
    expect(asLatin1(jpeg)).not.toContain('Exif\0\0');
    expect((await readBack(jpeg)).dc?.source).toBe(SOURCE_URI);

    const png = await exportedPng(linkOnly);
    expect(asLatin1(png)).not.toContain('eXIf');
    expect((await readBack(png)).dc?.source).toBe(SOURCE_URI);

    const tiff = await exportedTiff(linkOnly);
    const tiffTags = await readBack(tiff);
    expect(tiffTags.ifd0?.Software).toBeUndefined();
    expect(tiffTags.ifd0?.ModifyDate).toBeUndefined();
    expect(tiffTags.dc?.source).toBe(SOURCE_URI);
  });
});
