import type { RenderPass } from './RenderPass';

/**
 * Clarity (local contrast) + Brilliance (`dehaze` is the persisted legacy key).
 * Approximation: Highpass filter via subtraction from blurred.
 * True local contrast would need multi-pass blur, but this single-pass
 * approximation using neighbor sampling gives a decent result.
 */
export const ClarityPass: RenderPass = {
  name: 'clarity',
  uniforms: ['u_clarity', 'u_dehaze', 'u_resolution'],
  fragmentShader: `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture;
uniform float u_clarity;
uniform float u_dehaze;
uniform vec2 u_resolution;

void main() {
  vec4 color = texture(u_texture, v_texCoord);
  vec3 c = color.rgb;

  if (abs(u_clarity) > 0.01 || abs(u_dehaze) > 0.01) {
    // Simple box blur 5x5 for local contrast reference
    vec2 texel = 1.0 / u_resolution;
    vec3 blur = vec3(0.0);
    for (int x = -2; x <= 2; x++) {
      for (int y = -2; y <= 2; y++) {
        blur += texture(u_texture, v_texCoord + vec2(float(x), float(y)) * texel * 3.0).rgb;
      }
    }
    blur /= 25.0;

    // Clarity: add highpass (original - blur) weighted
    vec3 highpass = c - blur;
    c += highpass * u_clarity * 1.5;

    // Brilliance: lift darker areas and increase their colour density.
    float lum = dot(c, vec3(0.299, 0.587, 0.114));
    float hazeMask = 1.0 - smoothstep(0.0, 0.7, lum);
    c = mix(c, c * (1.0 + u_dehaze * 0.5), hazeMask);
    float lumAfter = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(lumAfter), c, 1.0 + u_dehaze * 0.3);
  }

  fragColor = vec4(clamp(c, 0.0, 1.0), color.a);
}`,
};
