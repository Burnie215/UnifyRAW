export interface Raw16Frame {
  data: Uint16Array;
  width: number;
  height: number;
  channels: 3 | 4;
}

/**
 * Resize scene-linear 16-bit RGB(A) pixels to a preview-sized long edge.
 * Bilinear interpolation happens before display encoding, so the result stays
 * suitable for the HDR graph instead of becoming an 8-bit/JPEG surrogate.
 */
export function resizeRaw16LongEdge(
  source: Raw16Frame,
  maxLongEdge: number,
): Raw16Frame {
  const sourceLongEdge = Math.max(source.width, source.height);
  const targetLongEdge = Math.max(1, Math.round(maxLongEdge));
  if (sourceLongEdge <= targetLongEdge) {
    return { ...source, data: new Uint16Array(source.data) };
  }

  const scale = targetLongEdge / sourceLongEdge;
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const output = new Uint16Array(width * height * source.channels);
  const xScale = source.width / width;
  const yScale = source.height / height;

  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.max(0, Math.min(source.height - 1, (y + 0.5) * yScale - 0.5));
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(y0 + 1, source.height - 1);
    const fy = sourceY - y0;

    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.max(0, Math.min(source.width - 1, (x + 0.5) * xScale - 0.5));
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(x0 + 1, source.width - 1);
      const fx = sourceX - x0;
      const topLeft = (y0 * source.width + x0) * source.channels;
      const topRight = (y0 * source.width + x1) * source.channels;
      const bottomLeft = (y1 * source.width + x0) * source.channels;
      const bottomRight = (y1 * source.width + x1) * source.channels;
      const destination = (y * width + x) * source.channels;

      for (let channel = 0; channel < source.channels; channel += 1) {
        const top = source.data[topLeft + channel]
          + (source.data[topRight + channel] - source.data[topLeft + channel]) * fx;
        const bottom = source.data[bottomLeft + channel]
          + (source.data[bottomRight + channel] - source.data[bottomLeft + channel]) * fx;
        output[destination + channel] = Math.round(top + (bottom - top) * fy);
      }
    }
  }

  return { data: output, width, height, channels: source.channels };
}

/**
 * Cut a square out of scene-linear 16-bit pixels without resampling.
 *
 * The bench's loupe needs pixels at their own scale, not at tile scale, and
 * for a RAW that scale is the smart preview the editor itself works at. A
 * resize here would defeat the purpose - the point is to see the samples as
 * the pipeline will sharpen and denoise them.
 */
export function cropRaw16(
  source: Raw16Frame,
  left: number,
  top: number,
  edge: number,
): Raw16Frame {
  const size = Math.max(1, Math.min(edge, source.width, source.height));
  const x0 = Math.max(0, Math.min(source.width - size, Math.round(left)));
  const y0 = Math.max(0, Math.min(source.height - size, Math.round(top)));
  const { channels } = source;
  const output = new Uint16Array(size * size * channels);

  for (let y = 0; y < size; y += 1) {
    const from = ((y0 + y) * source.width + x0) * channels;
    output.set(source.data.subarray(from, from + size * channels), y * size * channels);
  }

  return { data: output, width: size, height: size, channels };
}
