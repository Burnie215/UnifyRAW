import type { RenderPass } from './RenderPass';

/**
 * Levels (Tonwerte) adjustment.
 * Per-channel input/output levels with gamma correction.
 * Formula: output = outBlack + (outWhite - outBlack) * pow(clamp((input - inBlack) / (inWhite - inBlack), 0, 1), 1/gamma)
 * RGB channel is applied first, then individual R/G/B channels.
 */

const channels = ['rgb', 'red', 'green', 'blue'];
const uniforms: string[] = [];
for (const ch of channels) {
  uniforms.push(
    `u_lev_${ch}_inBlack`, `u_lev_${ch}_inWhite`, `u_lev_${ch}_gamma`,
    `u_lev_${ch}_outBlack`, `u_lev_${ch}_outWhite`,
  );
}

export const LevelsPass: RenderPass = {
  name: 'levels',
  uniforms,
  fragmentShader: `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture;

// RGB master
uniform float u_lev_rgb_inBlack, u_lev_rgb_inWhite, u_lev_rgb_gamma;
uniform float u_lev_rgb_outBlack, u_lev_rgb_outWhite;
// Per-channel
uniform float u_lev_red_inBlack, u_lev_red_inWhite, u_lev_red_gamma;
uniform float u_lev_red_outBlack, u_lev_red_outWhite;
uniform float u_lev_green_inBlack, u_lev_green_inWhite, u_lev_green_gamma;
uniform float u_lev_green_outBlack, u_lev_green_outWhite;
uniform float u_lev_blue_inBlack, u_lev_blue_inWhite, u_lev_blue_gamma;
uniform float u_lev_blue_outBlack, u_lev_blue_outWhite;

float applyLevels(float val, float inB, float inW, float gamma, float outB, float outW) {
  // Skip if default (optimization)
  if (inB < 0.001 && abs(inW - 1.0) < 0.001 && abs(gamma - 1.0) < 0.001
      && outB < 0.001 && abs(outW - 1.0) < 0.001) return val;
  // Input remap
  float t = clamp((val - inB) / max(inW - inB, 0.001), 0.0, 1.0);
  // Gamma
  t = pow(t, 1.0 / max(gamma, 0.01));
  // Output remap
  return outB + (outW - outB) * t;
}

void main() {
  vec4 color = texture(u_texture, v_texCoord);

  // Apply RGB master levels first
  color.r = applyLevels(color.r, u_lev_rgb_inBlack, u_lev_rgb_inWhite, u_lev_rgb_gamma, u_lev_rgb_outBlack, u_lev_rgb_outWhite);
  color.g = applyLevels(color.g, u_lev_rgb_inBlack, u_lev_rgb_inWhite, u_lev_rgb_gamma, u_lev_rgb_outBlack, u_lev_rgb_outWhite);
  color.b = applyLevels(color.b, u_lev_rgb_inBlack, u_lev_rgb_inWhite, u_lev_rgb_gamma, u_lev_rgb_outBlack, u_lev_rgb_outWhite);

  // Then per-channel
  color.r = applyLevels(color.r, u_lev_red_inBlack, u_lev_red_inWhite, u_lev_red_gamma, u_lev_red_outBlack, u_lev_red_outWhite);
  color.g = applyLevels(color.g, u_lev_green_inBlack, u_lev_green_inWhite, u_lev_green_gamma, u_lev_green_outBlack, u_lev_green_outWhite);
  color.b = applyLevels(color.b, u_lev_blue_inBlack, u_lev_blue_inWhite, u_lev_blue_gamma, u_lev_blue_outBlack, u_lev_blue_outWhite);

  fragColor = vec4(clamp(color.rgb, 0.0, 1.0), color.a);
}`,
};
