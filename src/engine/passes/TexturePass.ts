import type { RenderPass } from './RenderPass';

/**
 * Texture slider: enhances or reduces medium-frequency detail.
 * Uses a bandpass filter approach (difference of two blurs).
 */
export const TexturePass: RenderPass = {
  name: 'texture',
  uniforms: ['u_texture_amount', 'u_resolution'],
  fragmentShader: `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture;
uniform float u_texture_amount;
uniform vec2 u_resolution;

void main() {
  vec4 color = texture(u_texture, v_texCoord);

  if (abs(u_texture_amount) < 0.01) {
    fragColor = color;
    return;
  }

  vec2 texel = 1.0 / u_resolution;

  // Small blur (2px radius) — removes fine detail
  vec3 blurSmall = vec3(0.0);
  float wSmall = 0.0;
  for (int x = -2; x <= 2; x++) {
    for (int y = -2; y <= 2; y++) {
      float w = exp(-float(x*x + y*y) / 4.0);
      blurSmall += texture(u_texture, v_texCoord + vec2(float(x), float(y)) * texel).rgb * w;
      wSmall += w;
    }
  }
  blurSmall /= wSmall;

  // Large blur (6px radius) — removes medium detail
  vec3 blurLarge = vec3(0.0);
  float wLarge = 0.0;
  for (int x = -3; x <= 3; x++) {
    for (int y = -3; y <= 3; y++) {
      float w = exp(-float(x*x + y*y) / 18.0);
      blurLarge += texture(u_texture, v_texCoord + vec2(float(x), float(y)) * texel * 2.0).rgb * w;
      wLarge += w;
    }
  }
  blurLarge /= wLarge;

  // Bandpass = difference between small and large blur = medium frequencies
  vec3 medium = blurSmall - blurLarge;

  // Soft light blend
  vec3 result = color.rgb + medium * u_texture_amount * 2.0;

  fragColor = vec4(clamp(result, 0.0, 1.0), color.a);
}`,
};
