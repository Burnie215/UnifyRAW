import type { RenderPass } from './RenderPass';

/**
 * Tone Curve pass using a 1D LUT texture (256 entries).
 * The LUT is pre-computed on the CPU from the flexible curve points
 * and uploaded as a 256x1 texture on texture unit 1.
 */
export const ToneCurvePass: RenderPass = {
  name: 'toneCurve',
  uniforms: ['u_curveEnabled'],
  textures: ['u_curveLut'],
  fragmentShader: `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture;
uniform sampler2D u_curveLut;
uniform float u_curveEnabled;

void main() {
  vec4 color = texture(u_texture, v_texCoord);
  if (u_curveEnabled > 0.5) {
    // LUT is packed: R=red channel curve, G=green, B=blue
    vec3 lut = vec3(
      texture(u_curveLut, vec2(color.r, 0.5)).r,
      texture(u_curveLut, vec2(color.g, 0.5)).g,
      texture(u_curveLut, vec2(color.b, 0.5)).b
    );
    color.rgb = lut;
  }
  fragColor = vec4(clamp(color.rgb, 0.0, 1.0), color.a);
}`,
};
