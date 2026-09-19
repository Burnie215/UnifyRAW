import type { RenderPass } from './RenderPass';

/**
 * Black & White conversion with per-channel luminance mixing.
 * Only active when u_bw_enabled > 0.5.
 */
export const BWPass: RenderPass = {
  name: 'bw',
  uniforms: [
    'u_bw_enabled',
    'u_bw_red', 'u_bw_orange', 'u_bw_yellow', 'u_bw_green',
    'u_bw_aqua', 'u_bw_blue', 'u_bw_purple', 'u_bw_magenta',
  ],
  fragmentShader: `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture;
uniform float u_bw_enabled;
uniform float u_bw_red, u_bw_orange, u_bw_yellow, u_bw_green;
uniform float u_bw_aqua, u_bw_blue, u_bw_purple, u_bw_magenta;

float channelWeight(float hue, float center) {
  float d = abs(hue - center);
  d = min(d, 1.0 - d);
  return smoothstep(0.08, 0.0, d);
}

void main() {
  vec4 color = texture(u_texture, v_texCoord);

  if (u_bw_enabled < 0.5) {
    fragColor = color;
    return;
  }

  vec3 c = color.rgb;
  float maxC = max(c.r, max(c.g, c.b));
  float minC = min(c.r, min(c.g, c.b));
  float l = (maxC + minC) * 0.5;

  // Compute hue
  float d = maxC - minC;
  float h = 0.0;
  if (d > 0.001) {
    if (maxC == c.r) h = mod((c.g - c.b) / d, 6.0) / 6.0;
    else if (maxC == c.g) h = ((c.b - c.r) / d + 2.0) / 6.0;
    else h = ((c.r - c.g) / d + 4.0) / 6.0;
  }

  // Mix channels
  float adjustment = 0.0;
  adjustment += channelWeight(h, 0.0)   * u_bw_red / 100.0;
  adjustment += channelWeight(h, 0.083) * u_bw_orange / 100.0;
  adjustment += channelWeight(h, 0.167) * u_bw_yellow / 100.0;
  adjustment += channelWeight(h, 0.333) * u_bw_green / 100.0;
  adjustment += channelWeight(h, 0.5)   * u_bw_aqua / 100.0;
  adjustment += channelWeight(h, 0.667) * u_bw_blue / 100.0;
  adjustment += channelWeight(h, 0.75)  * u_bw_purple / 100.0;
  adjustment += channelWeight(h, 0.917) * u_bw_magenta / 100.0;

  float gray = clamp(l + adjustment * 0.3, 0.0, 1.0);
  fragColor = vec4(vec3(gray), color.a);
}`,
};
