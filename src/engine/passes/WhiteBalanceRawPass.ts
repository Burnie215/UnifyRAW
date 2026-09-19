import type { RenderPass } from './RenderPass';

/**
 * Apply per-channel WB multipliers to scene-linear RAW data.
 *
 * The base multipliers come from source calibration when it is available;
 * user-driven temperature/tint corrections are combined with them before
 * this pass. Locally decoded LibRaw pixels already include the camera WB, so
 * their base multipliers are identity and only the relative correction is
 * applied here.
 *
 * Default (multipliers = 1,1,1): pass-through.
 */
export const WhiteBalanceRawPass: RenderPass = {
  name: 'whiteBalanceRaw',
  uniforms: ['u_wb_r', 'u_wb_g', 'u_wb_b'],
  fragmentShader: `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture;
uniform float u_wb_r;
uniform float u_wb_g;
uniform float u_wb_b;

void main() {
  vec4 color = texture(u_texture, v_texCoord);
  fragColor = vec4(color.r * u_wb_r, color.g * u_wb_g, color.b * u_wb_b, color.a);
}`,
};
