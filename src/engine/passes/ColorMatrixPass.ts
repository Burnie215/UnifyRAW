import type { RenderPass } from './RenderPass';

/**
 * Apply 3×3 color matrix transforming Camera-RGB → Working-Space (linear sRGB).
 *
 * Matrix is supplied via uniforms `u_cm_r0..u_cm_b2` (row-major: row 0 = r,
 * row 1 = g, row 2 = b). Default (identity matrix) = pass-through.
 *
 * Real cameras have a Camera→XYZ matrix in their DNG profile. We pre-multiply
 * by XYZ→sRGB on the CPU side so this pass just does Camera→sRGB in one step.
 */
export const ColorMatrixPass: RenderPass = {
  name: 'colorMatrix',
  uniforms: [
    'u_cm_r0', 'u_cm_r1', 'u_cm_r2',
    'u_cm_g0', 'u_cm_g1', 'u_cm_g2',
    'u_cm_b0', 'u_cm_b1', 'u_cm_b2',
  ],
  fragmentShader: `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture;
uniform float u_cm_r0; uniform float u_cm_r1; uniform float u_cm_r2;
uniform float u_cm_g0; uniform float u_cm_g1; uniform float u_cm_g2;
uniform float u_cm_b0; uniform float u_cm_b1; uniform float u_cm_b2;

void main() {
  vec4 color = texture(u_texture, v_texCoord);
  vec3 c = color.rgb;
  float r = u_cm_r0 * c.r + u_cm_r1 * c.g + u_cm_r2 * c.b;
  float g = u_cm_g0 * c.r + u_cm_g1 * c.g + u_cm_g2 * c.b;
  float b = u_cm_b0 * c.r + u_cm_b1 * c.g + u_cm_b2 * c.b;
  fragColor = vec4(r, g, b, color.a);
}`,
};
