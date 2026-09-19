import type { RenderPass } from './RenderPass';

/**
 * Vibrance + Saturation (global).
 * Per-channel HSL would need 24 uniforms — kept separate for now.
 */
export const HSLPass: RenderPass = {
  name: 'hsl',
  uniforms: ['u_vibrance', 'u_saturation'],
  fragmentShader: `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture;
uniform float u_vibrance;
uniform float u_saturation;

void main() {
  vec4 color = texture(u_texture, v_texCoord);
  vec3 c = color.rgb;

  float lum = dot(c, vec3(0.299, 0.587, 0.114));

  // Saturation
  c = mix(vec3(lum), c, 1.0 + u_saturation);

  // Vibrance: smart saturation — boosts less-saturated colors more
  float maxC = max(c.r, max(c.g, c.b));
  float minC = min(c.r, min(c.g, c.b));
  float sat = (maxC > 0.0) ? (maxC - minC) / maxC : 0.0;
  float vibranceFactor = 1.0 + u_vibrance * (1.0 - sat);
  c = mix(vec3(lum), c, vibranceFactor);

  fragColor = vec4(clamp(c, 0.0, 1.0), color.a);
}`,
};
