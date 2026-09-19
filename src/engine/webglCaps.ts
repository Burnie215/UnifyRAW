/**
 * WebGL2 capability probe — checks which features are usable in the current
 * browser. Used by the rendering pipeline to decide between 16-bit float
 * (full RAW editing) and 8-bit (legacy fallback) modes.
 */

export interface WebGLCaps {
  /** WebGL2 is available at all */
  webgl2: boolean;
  /** RGBA16F textures can be rendered to (color attachment in FBO). Requires
   *  EXT_color_buffer_half_float (Mozilla quirk on some mobile, otherwise
   *  widely supported). */
  rgba16fRender: boolean;
  /** Reason the 16-bit path is unavailable, if any. */
  reason: string | null;
}

let cached: WebGLCaps | null = null;

export function detectWebGLCaps(): WebGLCaps {
  if (cached) return cached;
  cached = detect();
  return cached;
}

/**
 * Phase 1.D: shorthand gate for "can the editor even mount?" — the editor
 * pipeline requires WebGL2 + RGBA16F renderability (for the HDR/RAW chain).
 * Used by PhotoEditor at mount time to bail with a clear message instead
 * of crashing inside the worker.
 */
export function editorIsSupported(): boolean {
  const c = detectWebGLCaps();
  return c.webgl2 && c.rgba16fRender;
}

/** Human-readable summary for the capability-gate UI. */
export function editorUnsupportedMessage(): string {
  const c = detectWebGLCaps();
  if (c.webgl2 && c.rgba16fRender) return '';
  if (!c.webgl2) return 'WebGL2 nicht unterstützt. Der Editor benötigt einen modernen Browser mit WebGL2.';
  return 'WebGL2 vorhanden, aber EXT_color_buffer_half_float fehlt. RAW + HDR-Editing ist deaktiviert.';
}

/** Worker contexts are independent of the main-thread capability probe. */
export function requireHalfFloatColorBuffer(gl: WebGL2RenderingContext): void {
  if (!gl.getExtension('EXT_color_buffer_half_float')) {
    throw new Error(
      'WebGL2: EXT_color_buffer_half_float is required for RGBA16F rendering',
    );
  }
}

function detect(): WebGLCaps {
  if (typeof document === 'undefined') {
    return { webgl2: false, rgba16fRender: false, reason: 'no document' };
  }
  let canvas: HTMLCanvasElement | OffscreenCanvas;
  try {
    canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(1, 1)
      : document.createElement('canvas');
  } catch (e) {
    return { webgl2: false, rgba16fRender: false, reason: `canvas create failed: ${e}` };
  }
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
  } catch (e) {
    return { webgl2: false, rgba16fRender: false, reason: `webgl2 init failed: ${e}` };
  }
  if (!gl) {
    return { webgl2: false, rgba16fRender: false, reason: 'webgl2 not supported' };
  }

  const ext = gl.getExtension('EXT_color_buffer_half_float');
  if (!ext) {
    return {
      webgl2: true,
      rgba16fRender: false,
      reason: 'EXT_color_buffer_half_float not available — 16-bit FBO rendering disabled',
    };
  }

  // Probe an actual FBO attachment to verify the runtime accepts RGBA16F.
  // Some old driver/browser combos report the extension but fail at bind time.
  const tex = gl.createTexture();
  const fbo = gl.createFramebuffer();
  let renderable = false;
  try {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 4, 4, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    renderable = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  } catch { /* ignore */ }
  finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    if (tex) gl.deleteTexture(tex);
    if (fbo) gl.deleteFramebuffer(fbo);
  }

  if (!renderable) {
    return {
      webgl2: true,
      rgba16fRender: false,
      reason: 'EXT_color_buffer_half_float present but FBO probe failed',
    };
  }

  return { webgl2: true, rgba16fRender: true, reason: null };
}
