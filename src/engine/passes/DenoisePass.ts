import type { RenderPass } from './RenderPass';

/**
 * Luma/Chroma bilateral denoise in YCbCr (BT.709).
 *
 * Phase 1 of DENOISE_PLAN.md — classical, real-time, runs in the live
 * pipeline between TexturePass and SharpenPass (denoise BEFORE sharpen,
 * so sharpen does not amplify the noise it is meant to suppress).
 *
 * Separated Y and CbCr kernels: chroma noise is the visually dominant
 * artifact in high-ISO RAWs and survives heavier smoothing without
 * detail loss, so chroma uses a 7x7 kernel with wide sigmaColor. Luma
 * uses a 5x5 kernel and a detail slider that scales sigmaColor — higher
 * detail = smaller sigmaColor = stronger edge preservation.
 */
export const DenoisePass: RenderPass = {
  name: 'denoise',
  uniforms: ['u_denoise_luma', 'u_denoise_chroma', 'u_denoise_detail', 'u_resolution'],
  fragmentShader: `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture;
uniform float u_denoise_luma;     // 0..1
uniform float u_denoise_chroma;   // 0..1
uniform float u_denoise_detail;   // 0..1 — higher = preserve more luma edges
uniform vec2 u_resolution;

// BT.709 RGB <-> YCbCr (full-range, centered chroma)
vec3 rgb2ycbcr(vec3 c) {
  float y  = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float cb = (c.b - y) / 1.8556;
  float cr = (c.r - y) / 1.5748;
  return vec3(y, cb, cr);
}
vec3 ycbcr2rgb(vec3 c) {
  float y = c.x, cb = c.y, cr = c.z;
  float r = y + 1.5748 * cr;
  float g = y - 0.1873 * cb - 0.4681 * cr;
  float b = y + 1.8556 * cb;
  return vec3(r, g, b);
}

void main() {
  vec4 src = texture(u_texture, v_texCoord);
  vec3 c0 = rgb2ycbcr(src.rgb);

  // Early-out if both off — keeps render() identity-skip honest and saves
  // ~80 texture fetches per pixel when the user has the sliders at 0.
  if (u_denoise_luma < 0.001 && u_denoise_chroma < 0.001) {
    fragColor = src;
    return;
  }

  vec2 texel = 1.0 / u_resolution;

  // Sigma for luma range kernel: detail slider scales how aggressively we
  // smooth across edges. detail=1 → very narrow (preserve edges),
  // detail=0 → wide (more smoothing, risk of plastic look).
  float sigmaY = mix(0.18, 0.025, u_denoise_detail);
  float invSigmaY2 = 1.0 / (2.0 * sigmaY * sigmaY);
  // Chroma noise is large-scale and color-domain; wide sigma is fine.
  float sigmaC = 0.25;
  float invSigmaC2 = 1.0 / (2.0 * sigmaC * sigmaC);

  // Luma: 5x5 bilateral. Spatial sigma ~1.5 px (gaussian weights baked in).
  float ySum = 0.0;
  float yW = 0.0;
  for (int dy = -2; dy <= 2; dy++) {
    for (int dx = -2; dx <= 2; dx++) {
      vec2 off = vec2(float(dx), float(dy)) * texel;
      vec3 s = rgb2ycbcr(texture(u_texture, v_texCoord + off).rgb);
      float spatial = exp(-float(dx*dx + dy*dy) / (2.0 * 1.5 * 1.5));
      float range = exp(-(s.x - c0.x) * (s.x - c0.x) * invSigmaY2);
      float w = spatial * range;
      ySum += s.x * w;
      yW += w;
    }
  }
  float yDenoised = ySum / max(yW, 1e-6);

  // Chroma: 7x7 bilateral on (Cb, Cr) jointly. Spatial sigma ~2.5 px.
  vec2 cSum = vec2(0.0);
  float cW = 0.0;
  for (int dy = -3; dy <= 3; dy++) {
    for (int dx = -3; dx <= 3; dx++) {
      vec2 off = vec2(float(dx), float(dy)) * texel;
      vec3 s = rgb2ycbcr(texture(u_texture, v_texCoord + off).rgb);
      float spatial = exp(-float(dx*dx + dy*dy) / (2.0 * 2.5 * 2.5));
      vec2 dc = s.yz - c0.yz;
      float range = exp(-dot(dc, dc) * invSigmaC2);
      float w = spatial * range;
      cSum += s.yz * w;
      cW += w;
    }
  }
  vec2 cDenoised = cSum / max(cW, 1e-6);

  // Mix denoised channels back per user strength
  float yOut  = mix(c0.x,    yDenoised,    u_denoise_luma);
  vec2  cOut  = mix(c0.yz,   cDenoised,    u_denoise_chroma);

  vec3 rgb = ycbcr2rgb(vec3(yOut, cOut));
  fragColor = vec4(rgb, src.a);
}`,
};
