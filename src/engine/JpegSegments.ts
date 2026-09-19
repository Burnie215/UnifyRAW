/**
 * The JPEG marker segments UnifyRAW writes into an exported file.
 *
 * All three go directly after SOI, and the order in the finished file is
 * EXIF APP1, XMP APP1, ICC APP2 - the order readers expect, and the reason
 * `encodeFrame` calls these in reverse (each one inserts at the front).
 */

import { buildExifBlock, type ExportMetadata } from './exportMetadata';

const ICC_MARKER = 'ICC_PROFILE';
const EXIF_MARKER = 'Exif';
const XMP_MARKER = 'http://ns.adobe.com/xap/1.0/';
const MAX_SEGMENT_BYTES = 65535;

/**
 * Embed an ICC profile into a JPEG blob.
 * Returns a new Blob with the ICC profile injected after the SOI marker.
 */
export async function embedIccInJpeg(jpegBlob: Blob, iccProfile: Uint8Array): Promise<Blob> {
  // Format: FF E2 [length] "ICC_PROFILE\0" [seq] [count] [profile data]
  const header = new TextEncoder().encode(ICC_MARKER);
  const payload = new Uint8Array(header.length + 3 + iccProfile.length);
  payload.set(header, 0);
  payload[header.length] = 0; // null terminator
  payload[header.length + 1] = 1; // sequence number
  payload[header.length + 2] = 1; // total count
  payload.set(iccProfile, header.length + 3);
  // A profile too large for a single segment would need chunking; skipping it
  // keeps the image valid rather than writing a truncated profile.
  return insertAfterSoi(jpegBlob, 0xE2, payload);
}

/**
 * Embed capture time and writer as an EXIF APP1 segment. No-op when the
 * metadata holds neither - `includeMetadata: false` takes this path.
 */
export async function embedExifInJpeg(jpegBlob: Blob, metadata: ExportMetadata): Promise<Blob> {
  const block = buildExifBlock(metadata);
  if (!block) return jpegBlob;
  // Format: FF E1 [length] "Exif\0\0" [TIFF block]
  const header = new TextEncoder().encode(EXIF_MARKER);
  const payload = new Uint8Array(header.length + 2 + block.length);
  payload.set(header, 0);
  payload.set(block, header.length + 2);
  return insertAfterSoi(jpegBlob, 0xE1, payload);
}

/** Embed an XMP packet as an APP1 segment with the Adobe namespace header. */
export async function embedXmpInJpeg(jpegBlob: Blob, xmp: string): Promise<Blob> {
  const header = new TextEncoder().encode(XMP_MARKER);
  const packet = new TextEncoder().encode(xmp);
  const payload = new Uint8Array(header.length + 1 + packet.length);
  payload.set(header, 0);
  payload[header.length] = 0; // null terminator
  payload.set(packet, header.length + 1);
  // Anything past 64 KB needs the ExtendedXMP split; UnifyRAW's packet is the
  // edit stack plus three link fields and stays far below it.
  return insertAfterSoi(jpegBlob, 0xE1, payload);
}

/**
 * Put one marker segment right behind the SOI. Returns the input unchanged
 * when it is not a JPEG or the payload does not fit a single segment - an
 * export must not fail over a missing profile or tag.
 */
async function insertAfterSoi(jpegBlob: Blob, marker: number, payload: Uint8Array): Promise<Blob> {
  const data = new Uint8Array(await jpegBlob.arrayBuffer());
  if (data[0] !== 0xFF || data[1] !== 0xD8) return jpegBlob;

  const segmentLength = payload.length + 2; // the length field counts itself
  if (segmentLength > MAX_SEGMENT_BYTES) return jpegBlob;

  const result = new Uint8Array(data.length + 4 + payload.length);
  result[0] = 0xFF;
  result[1] = 0xD8;
  result[2] = 0xFF;
  result[3] = marker;
  result[4] = (segmentLength >> 8) & 0xFF;
  result[5] = segmentLength & 0xFF;
  result.set(payload, 6);
  result.set(data.subarray(2), 6 + payload.length);
  return new Blob([result], { type: 'image/jpeg' });
}
