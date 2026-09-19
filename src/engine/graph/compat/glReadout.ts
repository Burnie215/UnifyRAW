/**
 * Browser-only helpers for the GL browser tests: build an ImageBitmap from a
 * synthetic pattern, and read a WebGLTexture back as top-row-first RGBA8 so
 * bitExactCompare can hold it against the fixture.
 *
 * Do not import in Node tests — uses OffscreenCanvas, WebGL2, ImageBitmap.
 */

/**
 * Reads pixels from a WebGLTexture by binding it to a temporary FBO.
 * WebGL's origin is bottom-left so the raw read is upside down;
 * the helper flips rows so the result matches the top-row-first
 * convention of ImageBitmap / ImageData.
 */
export function readPixelsFromTexture(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  width: number,
  height: number,
): Uint8Array {
  const fbo = gl.createFramebuffer();
  if (!fbo) throw new Error('readPixelsFromTexture: createFramebuffer null');
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const flipped = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, flipped);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);

  // Flip rows: WebGL is bottom-up, ImageData is top-down.
  const out = new Uint8Array(width * height * 4);
  const rowBytes = width * 4;
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * rowBytes;
    const dst = y * rowBytes;
    out.set(flipped.subarray(src, src + rowBytes), dst);
  }
  return out;
}

/** Builds an ImageBitmap from a synthetic RGBA8 pattern. */
export async function bitmapFromPixels(
  pixels: Uint8Array, width: number, height: number,
): Promise<ImageBitmap> {
  const clamped = new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  // TS DOM lib's ImageData ctor overload picks the wrong shape for typed
  // arrays unless we go via an explicit ImageData with separate alloc.
  const data = new ImageData(width, height);
  data.data.set(clamped);
  return createImageBitmap(data);
}
