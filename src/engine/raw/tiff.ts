// @ts-expect-error — utif ships as plain JS with no types
import * as UTIF from 'utif';

export interface DecodedTiff {
  width: number;
  height: number;
  /** Pixel data. For 16-bit images: Uint16Array; for 8-bit: Uint8Array. */
  data: Uint8Array | Uint16Array;
  /** Bits per channel: 8 or 16. */
  bits: 8 | 16;
  /** Channels per pixel: typically 3 (RGB) or 4 (RGBA). */
  channels: 3 | 4;
}

/**
 * Decode a TIFF buffer (typically from /api/raw/smart-preview) to typed pixel
 * data. Supports 8-bit and 16-bit RGB/RGBA. LZW + uncompressed compression.
 *
 * The returned `data` is a single contiguous typed array in RGB(A) row-major
 * interleaved layout — suitable for direct upload to a WebGL texture via
 * `texImage2D(..., gl.HALF_FLOAT, data)` after a float-conversion step.
 */
export function decodeTiff(buf: ArrayBuffer): DecodedTiff {
  const ifds = UTIF.decode(buf);
  if (!ifds || ifds.length === 0) throw new Error('TIFF decode: no IFDs');
  const ifd = ifds[0];
  UTIF.decodeImage(buf, ifd, ifds);

  const width = ifd.width as number;
  const height = ifd.height as number;
  const bps = ifd.t258 as number[] | undefined; // BitsPerSample
  const spp = (ifd.t277 as number[] | undefined)?.[0] ?? 3; // SamplesPerPixel

  if (!width || !height) {
    throw new Error(`TIFF decode: zero dims (${width}x${height})`);
  }
  if (!bps || bps.length === 0) {
    throw new Error('TIFF decode: missing BitsPerSample');
  }

  const bitsPerSample = bps[0];
  if (bitsPerSample !== 8 && bitsPerSample !== 16) {
    throw new Error(`TIFF decode: unsupported bits per sample ${bitsPerSample}`);
  }
  if (spp !== 3 && spp !== 4) {
    throw new Error(`TIFF decode: unsupported samples per pixel ${spp}`);
  }

  // utif returns the decoded buffer as an array of bytes in ifd.data.
  // For 16-bit images, two adjacent bytes are one sample (little-endian per TIFF byteorder).
  const raw = ifd.data as Uint8Array;
  let data: Uint8Array | Uint16Array;
  if (bitsPerSample === 16) {
    // Always interpret as Uint16 — utif honors the TIFF byte-order during decode.
    data = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  } else {
    data = raw;
  }

  return {
    width,
    height,
    data,
    bits: bitsPerSample as 8 | 16,
    channels: spp as 3 | 4,
  };
}
