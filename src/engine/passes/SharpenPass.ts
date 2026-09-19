import type { RenderPass } from './RenderPass';

/**
 * Unsharp Mask sharpening.
 * Uses a 3x3 Laplacian approximation for speed.
 */
export const SharpenPass: RenderPass = {
  name: 'sharpen',
  uniforms: ['u_sharpness', 'u_resolution'],
  fragmentShader: `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture;
uniform float u_sharpness;
uniform vec2 u_resolution;

void main() {
  vec4 color = texture(u_texture, v_texCoord);

  if (u_sharpness > 0.01) {
    vec2 texel = 1.0 / u_resolution;

    // Sample neighbors for Laplacian
    vec3 n = texture(u_texture, v_texCoord + vec2(0.0, -texel.y)).rgb;
    vec3 s = texture(u_texture, v_texCoord + vec2(0.0, texel.y)).rgb;
    vec3 e = texture(u_texture, v_texCoord + vec2(texel.x, 0.0)).rgb;
    vec3 w = texture(u_texture, v_texCoord + vec2(-texel.x, 0.0)).rgb;

    vec3 laplacian = color.rgb * 4.0 - n - s - e - w;

    // Apply sharpening
    vec3 c = color.rgb + laplacian * u_sharpness * 1.5;

    fragColor = vec4(clamp(c, 0.0, 1.0), color.a);
  } else {
    fragColor = color;
  }
}`,
};
