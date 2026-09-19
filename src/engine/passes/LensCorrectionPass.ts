import type { RenderPass } from './RenderPass';

/**
 * Lens correction pass: distortion, vignetting, chromatic aberration.
 * Uses Brown-Conrady model for radial distortion.
 * Should run BEFORE other adjustments (first in pipeline) or last before transform.
 */
export const LensCorrectionPass: RenderPass = {
  name: 'lensCorrection',
  uniforms: [
    'u_lc_enabled',
    'u_lc_k1', 'u_lc_k2', 'u_lc_k3',
    'u_lc_v1', 'u_lc_v2', 'u_lc_v3',
    'u_lc_ca_r', 'u_lc_ca_b',
    'u_lc_strength',
  ],
  fragmentShader: `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture;
uniform float u_lc_enabled;
uniform float u_lc_k1, u_lc_k2, u_lc_k3;
uniform float u_lc_v1, u_lc_v2, u_lc_v3;
uniform float u_lc_ca_r, u_lc_ca_b;
uniform float u_lc_strength;

vec2 distort(vec2 uv, float k1, float k2, float k3) {
  vec2 centered = uv - 0.5;
  float r2 = dot(centered, centered);
  float r4 = r2 * r2;
  float r6 = r4 * r2;
  float factor = 1.0 + k1 * r2 + k2 * r4 + k3 * r6;
  return centered * factor + 0.5;
}

void main() {
  if (u_lc_enabled < 0.5) {
    fragColor = texture(u_texture, v_texCoord);
    return;
  }

  float strength = u_lc_strength;

  // Chromatic aberration: sample R and B with slightly different distortion
  vec2 uvR = distort(v_texCoord, u_lc_k1 * strength + u_lc_ca_r, u_lc_k2 * strength, u_lc_k3);
  vec2 uvG = distort(v_texCoord, u_lc_k1 * strength, u_lc_k2 * strength, u_lc_k3);
  vec2 uvB = distort(v_texCoord, u_lc_k1 * strength + u_lc_ca_b, u_lc_k2 * strength, u_lc_k3);

  float r = texture(u_texture, uvR).r;
  float g = texture(u_texture, uvG).g;
  float b = texture(u_texture, uvB).b;
  float a = texture(u_texture, uvG).a;
  vec3 c = vec3(r, g, b);

  // Vignetting correction
  vec2 centered = v_texCoord - 0.5;
  float r2 = dot(centered, centered) * 4.0; // normalized to 0-1 at corners
  float vigCorr = 1.0 + (u_lc_v1 * r2 + u_lc_v2 * r2 * r2 + u_lc_v3 * r2 * r2 * r2) * strength * 0.1;
  c *= vigCorr;

  fragColor = vec4(clamp(c, 0.0, 1.0), a);
}`,
};
