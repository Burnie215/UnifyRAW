import type { RenderPass } from './RenderPass';

/**
 * Combined tone pass: Exposure, Contrast, Highlights, Shadows, Whites, Blacks
 */
export const TonePass: RenderPass = {
  name: 'tone',
  uniforms: ['u_exposure', 'u_contrast', 'u_highlights', 'u_shadows', 'u_whites', 'u_blacks'],
  fragmentShader: `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture;
uniform float u_exposure;
uniform float u_contrast;
uniform float u_highlights;
uniform float u_shadows;
uniform float u_whites;
uniform float u_blacks;

void main() {
  vec4 color = texture(u_texture, v_texCoord);
  vec3 c = color.rgb;

  // Exposure (EV stops)
  c *= pow(2.0, u_exposure * 2.0);

  // Blacks/Whites (lift/gain)
  c = c + u_blacks * 0.1;
  c = c * (1.0 + u_whites * 0.15);

  // Highlights/Shadows (tone-targeted)
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  float shadowMask = 1.0 - smoothstep(0.0, 0.5, lum);
  float highlightMask = smoothstep(0.5, 1.0, lum);
  c += c * u_shadows * 0.5 * shadowMask;
  c += c * u_highlights * 0.5 * highlightMask;

  // Contrast (S-curve around mid-gray)
  c = mix(vec3(0.5), c, 1.0 + u_contrast);

  c = clamp(c, 0.0, 1.0);
  fragColor = vec4(c, color.a);
}`,
};
