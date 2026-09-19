import type { RenderPass } from './RenderPass';

/**
 * Terminal crop: maps the smaller output framebuffer over the selected part
 * of the fully transformed/composited input image.
 */
export const CropPass: RenderPass = {
  name: 'crop',
  uniforms: ['u_cropOrigin', 'u_cropSize'],
  fragmentShader: `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture;
uniform vec2 u_cropOrigin;
uniform vec2 u_cropSize;

void main() {
  vec2 uv = u_cropOrigin + v_texCoord * u_cropSize;
  fragColor = texture(u_texture, uv);
}`,
};
