import type { RenderPass } from './RenderPass';

/**
 * Color Grading: tint shadows, midtones, highlights with separate hue/saturation.
 * Includes per-zone saturation and luminance arc adjustments.
 */
export const ColorGradingPass: RenderPass = {
  name: 'colorGrading',
  uniforms: [
    'u_cg_shadow_h', 'u_cg_shadow_s', 'u_cg_shadow_satAdj', 'u_cg_shadow_lumAdj',
    'u_cg_mid_h', 'u_cg_mid_s', 'u_cg_mid_satAdj', 'u_cg_mid_lumAdj',
    'u_cg_high_h', 'u_cg_high_s', 'u_cg_high_satAdj', 'u_cg_high_lumAdj',
    'u_cg_balance', 'u_cg_blending',
  ],
  fragmentShader: `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture;
uniform float u_cg_shadow_h, u_cg_shadow_s, u_cg_shadow_satAdj, u_cg_shadow_lumAdj;
uniform float u_cg_mid_h, u_cg_mid_s, u_cg_mid_satAdj, u_cg_mid_lumAdj;
uniform float u_cg_high_h, u_cg_high_s, u_cg_high_satAdj, u_cg_high_lumAdj;
uniform float u_cg_balance, u_cg_blending;

vec3 hueToRGB(float hue) {
  float h = hue / 360.0;
  float r = abs(h * 6.0 - 3.0) - 1.0;
  float g = 2.0 - abs(h * 6.0 - 2.0);
  float b = 2.0 - abs(h * 6.0 - 4.0);
  return clamp(vec3(r, g, b), 0.0, 1.0);
}

vec3 rgb2hsl(vec3 c) {
  float mx = max(max(c.r, c.g), c.b);
  float mn = min(min(c.r, c.g), c.b);
  float l = (mx + mn) * 0.5;
  if (mx == mn) return vec3(0.0, 0.0, l);
  float d = mx - mn;
  float s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
  float h;
  if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
  else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
  else h = (c.r - c.g) / d + 4.0;
  return vec3(h / 6.0, s, l);
}

float hue2rgb(float p, float q, float t) {
  if (t < 0.0) t += 1.0;
  if (t > 1.0) t -= 1.0;
  if (t < 1.0/6.0) return p + (q - p) * 6.0 * t;
  if (t < 1.0/2.0) return q;
  if (t < 2.0/3.0) return p + (q - p) * (2.0/3.0 - t) * 6.0;
  return p;
}

vec3 hsl2rgb(vec3 hsl) {
  if (hsl.y == 0.0) return vec3(hsl.z);
  float q = hsl.z < 0.5 ? hsl.z * (1.0 + hsl.y) : hsl.z + hsl.y - hsl.z * hsl.y;
  float p = 2.0 * hsl.z - q;
  return vec3(
    hue2rgb(p, q, hsl.x + 1.0/3.0),
    hue2rgb(p, q, hsl.x),
    hue2rgb(p, q, hsl.x - 1.0/3.0)
  );
}

void main() {
  vec4 color = texture(u_texture, v_texCoord);
  vec3 c = color.rgb;

  float lum = dot(c, vec3(0.299, 0.587, 0.114));

  float balanceShift = u_cg_balance / 200.0;
  float blend = u_cg_blending / 100.0;

  // Zone masks
  float shadowMask = smoothstep(0.5 + balanceShift, 0.0 + balanceShift, lum) * blend + (1.0 - blend) * step(lum, 0.33 + balanceShift);
  float highlightMask = smoothstep(0.5 - balanceShift, 1.0 - balanceShift, lum) * blend + (1.0 - blend) * step(0.67 - balanceShift, lum);
  float midMask = max(1.0 - shadowMask - highlightMask, 0.0);

  // Apply hue tints
  if (u_cg_shadow_s > 0.01) {
    vec3 tint = hueToRGB(u_cg_shadow_h);
    c = mix(c, c * mix(vec3(1.0), tint, u_cg_shadow_s / 100.0), shadowMask);
  }
  if (u_cg_mid_s > 0.01) {
    vec3 tint = hueToRGB(u_cg_mid_h);
    c = mix(c, c * mix(vec3(1.0), tint, u_cg_mid_s / 100.0), midMask * 0.5);
  }
  if (u_cg_high_s > 0.01) {
    vec3 tint = hueToRGB(u_cg_high_h);
    c = mix(c, c * mix(vec3(1.0), tint, u_cg_high_s / 100.0), highlightMask);
  }

  // Apply per-zone saturation + luminance adjustments (arc sliders)
  vec3 hsl = rgb2hsl(c);

  // Shadows satAdj/lumAdj
  hsl.y = clamp(hsl.y + u_cg_shadow_satAdj * shadowMask, 0.0, 1.0);
  hsl.z = clamp(hsl.z + u_cg_shadow_lumAdj * shadowMask * 0.5, 0.0, 1.0);

  // Midtones satAdj/lumAdj
  hsl.y = clamp(hsl.y + u_cg_mid_satAdj * midMask, 0.0, 1.0);
  hsl.z = clamp(hsl.z + u_cg_mid_lumAdj * midMask * 0.5, 0.0, 1.0);

  // Highlights satAdj/lumAdj
  hsl.y = clamp(hsl.y + u_cg_high_satAdj * highlightMask, 0.0, 1.0);
  hsl.z = clamp(hsl.z + u_cg_high_lumAdj * highlightMask * 0.5, 0.0, 1.0);

  c = hsl2rgb(hsl);

  fragColor = vec4(clamp(c, 0.0, 1.0), color.a);
}`,
};
