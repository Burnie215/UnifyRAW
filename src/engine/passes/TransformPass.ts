import type { RenderPass } from './RenderPass';

/**
 * Transform pass: Rotation, Flip, Perspective Correction, Distortion.
 */
export const TransformPass: RenderPass = {
  name: 'transform',
  uniforms: ['u_rotation', 'u_flipH', 'u_flipV', 'u_perspH', 'u_perspV', 'u_distortion', 'u_resolution'],
  fragmentShader: `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture;
uniform float u_rotation;
uniform float u_flipH;
uniform float u_flipV;
uniform float u_perspH;   // Horizontal perspective -1..1
uniform float u_perspV;   // Vertical perspective -1..1
uniform float u_distortion; // Barrel/pincushion -1..1
uniform vec2 u_resolution;  // Image size in pixels - needed to rotate squarely

void main() {
  vec2 uv = v_texCoord;

  // Flip
  uv.x = (u_flipH < 0.0) ? 1.0 - uv.x : uv.x;
  uv.y = (u_flipV < 0.0) ? 1.0 - uv.y : uv.y;

  // Work in pixel-square coordinates for every geometric operation. Texture
  // coordinates run 0..1 on both axes, so raw uv distances are stretched by
  // the image aspect ratio and make perspective/distortion direction-dependent.
  uv -= 0.5;
  float aspect = max(u_resolution.x, 1.0) / max(u_resolution.y, 1.0);
  vec2 p = vec2(uv.x * aspect, uv.y);

  // Perspective correction (projective transform)
  if (abs(u_perspH) > 0.001 || abs(u_perspV) > 0.001) {
    float ph = u_perspH * 0.5;
    float pv = u_perspV * 0.5;
    // Projective warp: divide by linear depth function
    float w = 1.0 + ph * p.x + pv * p.y;
    p = p / max(w, 0.1);
  }

  // Barrel/Pincushion distortion
  if (abs(u_distortion) > 0.001) {
    float r2 = dot(p, p);
    float factor = 1.0 + u_distortion * r2;
    p *= factor;
  }

  // Rotation around center, in aspect-corrected space.
  //
  // Texture coordinates run 0..1 on both axes, so one unit of u is a different
  // number of pixels than one unit of v on anything but a square image. Turning
  // the raw uv vector therefore rotates the picture by atan(aspect * tan(angle))
  // instead of by the angle asked for - visibly too much on a portrait frame,
  // too little on a wide one - and shears it on the way.
  //
  // The sign is negated because this is an inverse map: the fragment asks
  // "which texel do I show?", so turning the *lookup* by +angle turns the
  // *picture* by -angle. u_rotation is the angle the picture should turn,
  // clockwise-positive in image space (v grows downward, matching the CSS
  // rotate() fallback), which is what the straighten tool and the slider mean.
  if (abs(u_rotation) > 0.001) {
    float s = sin(-u_rotation);
    float co = cos(-u_rotation);
    p = vec2(co * p.x - s * p.y, s * p.x + co * p.y);
  }

  uv = vec2(p.x / aspect, p.y);
  uv += 0.5;

  // Clamp to bounds
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
  } else {
    fragColor = texture(u_texture, uv);
  }
}`,
};
