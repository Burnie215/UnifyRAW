/** Integer RGB TIFF encoder with ICC, multi-strip and Adobe Deflate support. */

import { deflateParts } from './PngChunks';
import {
  asciiField,
  buildTiffLayout,
  byteField,
  longField,
  rationalField,
  shortField,
  toBlobPart,
  undefinedField,
  TIFF_PAD_BYTE,
  type TiffField,
} from './tiffIfd';
import { asciiText, exifDateTime, type ExportMetadata } from './exportMetadata';

export type TiffCompression = 'deflate' | 'none';

export interface TiffEncodeWarning {
  code: 'deflate-unavailable';
  requestedCompression: 'deflate';
  actualCompression: 'none';
  message: string;
}

export interface TiffEncodeOptions {
  width: number;
  height: number;
  bits: 8 | 16;
  compression: TiffCompression;
  /** Called when a requested, optional feature has to degrade honestly. */
  onWarning?: (warning: TiffEncodeWarning) => void;
  /** Software, capture time and the XMP link that names the original. */
  metadata?: ExportMetadata;
}

export interface TiffStripPlan {
  bytesPerRow: number;
  rowsPerStrip: number;
  stripCount: number;
  /** Largest uncompressed RGB strip; one row can never be split. */
  maxStripBytes: number;
}

export const TIFF_TARGET_STRIP_BYTES = 4 * 1024 * 1024;

/**
 * The allocation contract behind large TIFF exports. It is public so a
 * 45-MP geometry can be checked without allocating a 360-MB RGBA fixture.
 */
export function planTiffStrips(width: number, height: number, bits: 8 | 16): TiffStripPlan {
  assertDimensions(width, height);
  const bytesPerRow = width * 3 * (bits / 8);
  const rowsPerStrip = Math.max(1, Math.min(
    Math.floor(TIFF_TARGET_STRIP_BYTES / bytesPerRow),
    height,
  ));
  return {
    bytesPerRow,
    rowsPerStrip,
    stripCount: Math.ceil(height / rowsPerStrip),
    maxStripBytes: rowsPerStrip * bytesPerRow,
  };
}

/**
 * Encode RGBA input as chunky RGB strips. Strips are packed and compressed
 * one at a time; the encoder never materializes a second full-size RGB frame
 * or one giant compressed buffer. The IFD is assembled only after every
 * strip's actual byte count is known.
 */
export async function encodeTiff(
  pixels: Uint8Array | Uint8ClampedArray | Uint16Array,
  options: TiffEncodeOptions,
  iccProfile?: Uint8Array,
): Promise<Blob> {
  const { width, height, bits } = options;
  assertInput(pixels, width, height, bits, options.compression);
  const stripPlan = planTiffStrips(width, height, bits);
  const compression = effectiveCompression(options);
  const strips: EncodedStrip[] = [];

  for (let firstRow = 0; firstRow < height; firstRow += stripPlan.rowsPerStrip) {
    const rowCount = Math.min(stripPlan.rowsPerStrip, height - firstRow);
    const raw = packRgbStrip(pixels, width, firstRow, rowCount, bits);
    const parts = compression === 'deflate' ? await deflateParts([raw]) : [raw];
    const byteLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
    if (byteLength === 0) throw new Error('encodeTiff: compression produced an empty strip');
    strips.push({ blob: new Blob(parts.map(toBlobPart)), byteLength });
  }

  const layout = buildTiffLayout(
    directoryFields(width, height, bits, compression, stripPlan, iccProfile, options.metadata),
    strips.map((strip) => strip.byteLength),
  );
  const blobParts: BlobPart[] = [toBlobPart(layout.directory)];
  for (const strip of strips) {
    blobParts.push(strip.blob);
    if (strip.byteLength % 2 !== 0) blobParts.push(toBlobPart(TIFF_PAD_BYTE));
  }
  return new Blob(blobParts, { type: 'image/tiff' });
}

interface EncodedStrip {
  blob: Blob;
  byteLength: number;
}

const PHOTOMETRIC_RGB = 2;
const RESOLUTION_UNIT_INCH = 2;
const SAMPLE_FORMAT_UINT = 1;

function directoryFields(
  width: number,
  height: number,
  bits: 8 | 16,
  compression: TiffCompression,
  stripPlan: TiffStripPlan,
  iccProfile?: Uint8Array,
  metadata?: ExportMetadata,
): TiffField[] {
  const fields: TiffField[] = [
    shortField(256, [width]),
    shortField(257, [height]),
    shortField(258, [bits, bits, bits]),
    shortField(259, [compression === 'deflate' ? 8 : 1]),
    shortField(262, [PHOTOMETRIC_RGB]),
    shortField(277, [3]),
    longField(278, [stripPlan.rowsPerStrip]),
    rationalField(282, [72], 1),
    rationalField(283, [72], 1),
    shortField(296, [RESOLUTION_UNIT_INCH]),
  ];
  if (bits === 16) fields.push(shortField(339, [SAMPLE_FORMAT_UINT, SAMPLE_FORMAT_UINT, SAMPLE_FORMAT_UINT]));
  const software = asciiText(metadata?.software);
  if (software) fields.push(asciiField(305, software));
  const dateTime = exifDateTime(metadata?.dateTaken);
  if (dateTime) fields.push(asciiField(306, dateTime));
  // Adobe's ApplicationNotes tag. BYTE, not UNDEFINED: that is what ExifTool
  // and Adobe write, and what readers look for in a .tif.
  if (metadata?.xmp) fields.push(byteField(700, new TextEncoder().encode(metadata.xmp)));
  if (iccProfile) fields.push(undefinedField(34675, iccProfile));
  return fields;
}

function packRgbStrip(
  pixels: Uint8Array | Uint8ClampedArray | Uint16Array,
  width: number,
  firstRow: number,
  rowCount: number,
  bits: 8 | 16,
): Uint8Array {
  const bytes = new Uint8Array(width * rowCount * 3 * (bits / 8));
  const view = bits === 16 ? new DataView(bytes.buffer) : null;
  const firstSource = firstRow * width * 4;
  const sourceEnd = firstSource + rowCount * width * 4;
  let destination = 0;
  for (let source = firstSource; source < sourceEnd; source += 4) {
    for (let channel = 0; channel < 3; channel++) {
      if (view) {
        view.setUint16(destination, pixels[source + channel], true);
        destination += 2;
      } else {
        bytes[destination++] = pixels[source + channel];
      }
    }
  }
  return bytes;
}

function effectiveCompression(options: TiffEncodeOptions): TiffCompression {
  if (options.compression !== 'deflate' || typeof CompressionStream !== 'undefined') {
    return options.compression;
  }
  const warning: TiffEncodeWarning = {
    code: 'deflate-unavailable',
    requestedCompression: 'deflate',
    actualCompression: 'none',
    message: 'Deflate compression is unavailable; the TIFF was written uncompressed.',
  };
  console.warn(`[TiffEncoder] ${warning.message}`);
  options.onWarning?.(warning);
  return 'none';
}

function assertInput(
  pixels: Uint8Array | Uint8ClampedArray | Uint16Array,
  width: number,
  height: number,
  bits: 8 | 16,
  compression: TiffCompression,
): void {
  assertDimensions(width, height);
  if (compression !== 'none' && compression !== 'deflate') {
    throw new Error('encodeTiff: unsupported compression');
  }
  if (pixels.length !== width * height * 4) {
    throw new Error('encodeTiff: RGBA pixel count does not match geometry');
  }
  if (bits === 16 && !(pixels instanceof Uint16Array)) {
    throw new Error('encodeTiff: 16-bit output requires Uint16Array pixels');
  }
  if (bits === 8 && pixels instanceof Uint16Array) {
    throw new Error('encodeTiff: 8-bit output requires byte pixels');
  }
}

function assertDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 || width > 0xffff || height > 0xffff) {
    throw new Error('encodeTiff: dimensions are outside the supported TIFF range');
  }
}
