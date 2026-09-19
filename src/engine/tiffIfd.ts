/**
 * The hand-written TIFF container: typed IFD fields plus the offset arithmetic
 * that turns them into a file header.
 *
 * It exists because DNG is a TIFF. `TiffEncoder` and `DngEncoder` disagree
 * about every tag and about what a sample even is, but they agree byte for
 * byte on the header, the entry table, where a payload larger than four bytes
 * lives, and how strip offsets resolve once the compressed sizes are known.
 * That agreement lives here once instead of twice.
 */

export const TIFF_TYPE = {
  BYTE: 1,
  ASCII: 2,
  SHORT: 3,
  LONG: 4,
  RATIONAL: 5,
  UNDEFINED: 7,
  SRATIONAL: 10,
} as const;

export type TiffFieldType = (typeof TIFF_TYPE)[keyof typeof TIFF_TYPE];

const TYPE_SIZE: Record<TiffFieldType, number> = {
  [TIFF_TYPE.BYTE]: 1,
  [TIFF_TYPE.ASCII]: 1,
  [TIFF_TYPE.SHORT]: 2,
  [TIFF_TYPE.LONG]: 4,
  [TIFF_TYPE.RATIONAL]: 8,
  [TIFF_TYPE.UNDEFINED]: 1,
  [TIFF_TYPE.SRATIONAL]: 8,
};

export const TIFF_HEADER_SIZE = 8;
export const TIFF_STRIP_OFFSETS = 273;
export const TIFF_STRIP_BYTE_COUNTS = 279;

/** A payload of at most four bytes lives in the entry itself, not after it. */
const INLINE_LIMIT = 4;

export interface TiffField {
  readonly tag: number;
  readonly type: TiffFieldType;
  readonly count: number;
  /** Exactly `count * sizeof(type)` bytes, already little-endian. */
  readonly bytes: Uint8Array;
}

export interface TiffLayout {
  /** Header, entry table, external payloads and padding — everything before strip 0. */
  directory: Uint8Array;
  /** File offset of every strip, each one word-aligned. */
  stripOffsets: number[];
}

function makeField(
  tag: number,
  type: TiffFieldType,
  count: number,
  bytes: Uint8Array,
): TiffField {
  if (bytes.length !== count * TYPE_SIZE[type]) {
    throw new Error(`tiffIfd: tag ${tag} payload is ${bytes.length} bytes, not ${count * TYPE_SIZE[type]}`);
  }
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error(`tiffIfd: tag ${tag} needs at least one value`);
  }
  return { tag, type, count, bytes };
}

export function byteField(tag: number, values: ArrayLike<number>): TiffField {
  const bytes = Uint8Array.from(values as ArrayLike<number>);
  return makeField(tag, TIFF_TYPE.BYTE, bytes.length, bytes);
}

export function undefinedField(tag: number, bytes: Uint8Array): TiffField {
  return makeField(tag, TIFF_TYPE.UNDEFINED, bytes.length, bytes);
}

/** ASCII fields are NUL-terminated and the terminator counts (TIFF 6.0 p. 15). */
export function asciiField(tag: number, text: string): TiffField {
  const encoded = new TextEncoder().encode(text);
  if (encoded.includes(0)) throw new Error(`tiffIfd: tag ${tag} ASCII value contains a NUL`);
  if (encoded.some((byte) => byte > 0x7f)) {
    throw new Error(`tiffIfd: tag ${tag} ASCII value is not 7-bit`);
  }
  const bytes = new Uint8Array(encoded.length + 1);
  bytes.set(encoded);
  return makeField(tag, TIFF_TYPE.ASCII, bytes.length, bytes);
}

export function shortField(tag: number, values: readonly number[]): TiffField {
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      throw new Error(`tiffIfd: tag ${tag} SHORT value ${value} is out of range`);
    }
    view.setUint16(index * 2, value, true);
  });
  return makeField(tag, TIFF_TYPE.SHORT, values.length, bytes);
}

export function longField(tag: number, values: readonly number[]): TiffField {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new Error(`tiffIfd: tag ${tag} LONG value ${value} is out of range`);
    }
    view.setUint32(index * 4, value, true);
  });
  return makeField(tag, TIFF_TYPE.LONG, values.length, bytes);
}

/**
 * TIFF has no floating point field type, so every real number is written as a
 * fraction over a fixed denominator. The denominator is the caller's choice
 * because it is the written precision.
 */
export function rationalField(
  tag: number,
  values: readonly number[],
  denominator: number,
): TiffField {
  return fractionField(tag, TIFF_TYPE.RATIONAL, values, denominator);
}

export function srationalField(
  tag: number,
  values: readonly number[],
  denominator: number,
): TiffField {
  return fractionField(tag, TIFF_TYPE.SRATIONAL, values, denominator);
}

function fractionField(
  tag: number,
  type: typeof TIFF_TYPE.RATIONAL | typeof TIFF_TYPE.SRATIONAL,
  values: readonly number[],
  denominator: number,
): TiffField {
  if (!Number.isInteger(denominator) || denominator < 1 || denominator > 0x7fffffff) {
    throw new Error(`tiffIfd: tag ${tag} needs a positive integer denominator`);
  }
  const signed = type === TIFF_TYPE.SRATIONAL;
  const bytes = new Uint8Array(values.length * 8);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) {
      throw new Error(`tiffIfd: tag ${tag} value ${value} is not finite`);
    }
    const numerator = Math.round(value * denominator);
    if (!signed && numerator < 0) {
      throw new Error(`tiffIfd: tag ${tag} is unsigned but value ${value} is negative`);
    }
    if (Math.abs(numerator) > (signed ? 0x7fffffff : 0xffffffff)) {
      throw new Error(`tiffIfd: tag ${tag} value ${value} overflows its numerator`);
    }
    if (signed) view.setInt32(index * 8, numerator, true);
    else view.setUint32(index * 8, numerator, true);
    view.setUint32(index * 8 + 4, denominator, true);
  });
  return makeField(tag, type, values.length, bytes);
}

/**
 * Assemble everything that precedes the pixel data. The strip byte counts have
 * to be final — they are what decides where strip 0 starts, so the caller
 * compresses first and lays out afterwards.
 *
 * `StripOffsets` and `StripByteCounts` are written here, not by the caller:
 * their values are a property of this layout, not of the image.
 */
export function buildTiffLayout(
  fields: readonly TiffField[],
  stripByteCounts: readonly number[],
): TiffLayout {
  if (stripByteCounts.length < 1) throw new Error('buildTiffLayout: a TIFF needs at least one strip');
  for (const tag of [TIFF_STRIP_OFFSETS, TIFF_STRIP_BYTE_COUNTS]) {
    if (fields.some((f) => f.tag === tag)) {
      throw new Error(`buildTiffLayout: tag ${tag} is written by the layout, not by the caller`);
    }
  }
  const stripOffsetBytes = new Uint8Array(stripByteCounts.length * 4);
  const entries = [
    ...fields,
    makeField(TIFF_STRIP_OFFSETS, TIFF_TYPE.LONG, stripByteCounts.length, stripOffsetBytes),
    longField(TIFF_STRIP_BYTE_COUNTS, stripByteCounts),
  ].sort((a, b) => a.tag - b.tag);
  for (let index = 1; index < entries.length; index++) {
    if (entries[index].tag === entries[index - 1].tag) {
      throw new Error(`buildTiffLayout: duplicate tag ${entries[index].tag}`);
    }
  }

  const ifdSize = 2 + entries.length * 12 + 4;
  let cursor = TIFF_HEADER_SIZE + ifdSize;
  const externalOffsets = new Map<number, number>();
  for (const entry of entries) {
    if (entry.bytes.length <= INLINE_LIMIT) continue;
    externalOffsets.set(entry.tag, cursor);
    cursor = alignEven(cursor + entry.bytes.length);
  }

  const stripOffsets: number[] = [];
  let fileOffset = alignEven(cursor);
  for (const byteLength of stripByteCounts) {
    stripOffsets.push(fileOffset);
    fileOffset = alignEven(fileOffset + byteLength);
  }
  if (fileOffset > 0xffffffff) {
    throw new Error('buildTiffLayout: output exceeds the 4 GiB classic TIFF limit');
  }
  const stripOffsetView = new DataView(stripOffsetBytes.buffer);
  stripOffsets.forEach((offset, index) => stripOffsetView.setUint32(index * 4, offset, true));

  const directory = new Uint8Array(stripOffsets[0]);
  const view = new DataView(directory.buffer);
  view.setUint16(0, 0x4949, true);
  view.setUint16(2, 42, true);
  view.setUint32(4, TIFF_HEADER_SIZE, true);

  let position = TIFF_HEADER_SIZE;
  view.setUint16(position, entries.length, true);
  position += 2;
  for (const entry of entries) {
    view.setUint16(position, entry.tag, true);
    view.setUint16(position + 2, entry.type, true);
    view.setUint32(position + 4, entry.count, true);
    if (entry.bytes.length <= INLINE_LIMIT) directory.set(entry.bytes, position + 8);
    else view.setUint32(position + 8, externalOffsets.get(entry.tag)!, true);
    position += 12;
  }
  view.setUint32(position, 0, true);

  for (const entry of entries) {
    const offset = externalOffsets.get(entry.tag);
    if (offset !== undefined) directory.set(entry.bytes, offset);
  }
  return { directory, stripOffsets };
}

/** Strip data must start on a word boundary, so an odd strip gets one pad byte. */
export const TIFF_PAD_BYTE = new Uint8Array(1);

export function alignEven(value: number): number {
  return value + (value % 2);
}

/** Preserve owned buffers; copy only a view that Blob's strict DOM type rejects. */
export function toBlobPart(bytes: Uint8Array): ArrayBuffer {
  if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 &&
      bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}
