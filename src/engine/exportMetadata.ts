/**
 * What an exported file says about where it came from.
 *
 * Deliberately five fields, not a full EXIF copy from the original: capture
 * time and writer in EXIF, and the link back to the original plus the edit
 * that produced this file in XMP. The XMP packet itself is built by
 * `adjustmentsToXMP` (src/data/xmp.ts) and arrives here as a finished string,
 * so every container writes the same bytes.
 */

export interface ExportMetadata {
  /** EXIF DateTimeOriginal and TIFF DateTime, epoch ms of the original. */
  dateTaken?: number | null;
  /** EXIF/TIFF Software (tag 305) - who wrote this file. */
  software?: string | null;
  /** The complete XMP packet, already serialized. */
  xmp?: string | null;
}

/**
 * `includeMetadata: false` drops EXIF and keeps the XMP link: the link is the
 * function of this feature, not the metadata the checkbox is about. Returns
 * undefined when nothing is left to write, so callers can skip the work.
 */
export function metadataFor(
  metadata: ExportMetadata | undefined,
  includeMetadata: boolean,
): ExportMetadata | undefined {
  if (!metadata) return undefined;
  const kept: ExportMetadata = includeMetadata
    ? metadata
    : { xmp: metadata.xmp };
  return hasMetadata(kept) ? kept : undefined;
}

export function hasMetadata(metadata: ExportMetadata | undefined): boolean {
  if (!metadata) return false;
  return Boolean(exifDateTime(metadata.dateTaken) || asciiText(metadata.software) || metadata.xmp);
}

/** EXIF dates are local wall-clock time in `YYYY:MM:DD HH:MM:SS`. */
export function exifDateTime(epochMs: number | null | undefined): string | null {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return null;
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(date.getFullYear(), 4)}:${pad(date.getMonth() + 1)}:${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

const TYPE_ASCII = 2;
const TYPE_LONG = 4;
const TAG_SOFTWARE = 305;
const TAG_DATETIME = 306;
const TAG_EXIF_IFD = 34665;
const TAG_DATETIME_ORIGINAL = 36867;
const TIFF_HEADER_SIZE = 8;

interface TiffValue {
  tag: number;
  type: number;
  bytes: Uint8Array;
}

/**
 * The EXIF payload as a standalone little-endian TIFF block: IFD0 with
 * Software and DateTime, plus an Exif sub-IFD carrying DateTimeOriginal.
 *
 * Two containers embed exactly these bytes - JPEG behind the `Exif\0\0` APP1
 * header, PNG raw in an `eXIf` chunk. TIFF does not: there the same fields are
 * tags of the image's own IFD, written by TiffEncoder.
 */
export function buildExifBlock(metadata: ExportMetadata): Uint8Array | null {
  const software = asciiText(metadata.software);
  const dateTime = exifDateTime(metadata.dateTaken);
  if (!software && !dateTime) return null;

  const ifd0: TiffValue[] = [];
  if (software) ifd0.push({ tag: TAG_SOFTWARE, type: TYPE_ASCII, bytes: asciiValue(software) });
  if (dateTime) ifd0.push({ tag: TAG_DATETIME, type: TYPE_ASCII, bytes: asciiValue(dateTime) });
  const exifIfd: TiffValue[] = dateTime
    ? [{ tag: TAG_DATETIME_ORIGINAL, type: TYPE_ASCII, bytes: asciiValue(dateTime) }]
    : [];
  // The pointer is an IFD0 entry itself, so it has to be counted before the
  // sub-IFD's own offset can be known.
  if (exifIfd.length > 0) ifd0.push({ tag: TAG_EXIF_IFD, type: TYPE_LONG, bytes: new Uint8Array(4) });
  ifd0.sort((a, b) => a.tag - b.tag);

  const ifd0Size = directorySize(ifd0.length);
  const exifIfdOffset = TIFF_HEADER_SIZE + ifd0Size;
  const exifIfdSize = exifIfd.length > 0 ? directorySize(exifIfd.length) : 0;
  let dataOffset = exifIfdOffset + exifIfdSize;
  for (const value of [...ifd0, ...exifIfd]) {
    if (value.bytes.length > 4) dataOffset = alignEven(dataOffset + value.bytes.length);
  }

  const block = new Uint8Array(dataOffset);
  const view = new DataView(block.buffer);
  view.setUint16(0, 0x4949, true);
  view.setUint16(2, 42, true);
  view.setUint32(4, TIFF_HEADER_SIZE, true);

  const pointer = ifd0.find((value) => value.tag === TAG_EXIF_IFD);
  if (pointer) new DataView(pointer.bytes.buffer).setUint32(0, exifIfdOffset, true);

  let nextData = exifIfdOffset + exifIfdSize;
  nextData = writeDirectory(block, view, TIFF_HEADER_SIZE, ifd0, nextData);
  if (exifIfd.length > 0) writeDirectory(block, view, exifIfdOffset, exifIfd, nextData);
  return block;
}

function directorySize(entries: number): number {
  return 2 + entries * 12 + 4;
}

/** Writes one IFD at `offset`; oversized values go to `dataOffset` and on. */
function writeDirectory(
  block: Uint8Array,
  view: DataView,
  offset: number,
  values: TiffValue[],
  dataOffset: number,
): number {
  view.setUint16(offset, values.length, true);
  let position = offset + 2;
  let data = dataOffset;
  for (const value of values) {
    view.setUint16(position, value.tag, true);
    view.setUint16(position + 2, value.type, true);
    view.setUint32(position + 4, value.bytes.length / (value.type === TYPE_LONG ? 4 : 1), true);
    if (value.bytes.length <= 4) {
      block.set(value.bytes, position + 8);
    } else {
      view.setUint32(position + 8, data, true);
      block.set(value.bytes, data);
      data = alignEven(data + value.bytes.length);
    }
    position += 12;
  }
  view.setUint32(position, 0, true);
  return data;
}

/** A non-empty, writable one-line string, or null. */
export function asciiText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** EXIF ASCII values are NUL-terminated; non-ASCII has no representation. */
export function asciiValue(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length + 1);
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    bytes[index] = code >= 32 && code <= 126 ? code : 0x3f;
  }
  return bytes;
}

function alignEven(value: number): number {
  return value + (value % 2);
}
