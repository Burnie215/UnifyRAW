import type { RenderPass } from './RenderPass';

/**
 * White balance: Temperature (blue-yellow) + Tint (green-magenta)
 */
export const WhiteBalancePass: RenderPass = {
  name: 'whiteBalance',
  uniforms: ['u_temperature', 'u_tint'],
  fragmentShader: `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture;
uniform float u_temperature;
uniform float u_tint;

void main() {
  vec4 color = texture(u_texture, v_texCoord);
  vec3 c = color.rgb;

  // Temperature: shift blue-yellow axis
  c.r += u_temperature * 0.15;
  c.b -= u_temperature * 0.15;

  // Tint: shift green-magenta axis
  c.g += u_tint * 0.1;
  c.r -= u_tint * 0.05;
  c.b -= u_tint * 0.05;

  fragColor = vec4(clamp(c, 0.0, 1.0), color.a);
}`,
};
