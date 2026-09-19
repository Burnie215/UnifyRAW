import type { RenderPass } from './RenderPass';

/**
 * Per-channel HSL adjustments for 8 color ranges.
 * Each channel has hue/saturation/luminance offsets passed as uniforms.
 * Uniform naming: u_hsl_{channel}_{axis} e.g. u_hsl_red_h, u_hsl_red_s, u_hsl_red_l
 */

const channels = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'];
const uniforms: string[] = [
  'u_view_sel_hue', 'u_view_sel_hw', 'u_view_sel_sat_min', 'u_view_sel_sat_max',
  'u_skin_ref_hue', 'u_skin_ref_sat', 'u_skin_ref_lum',
  'u_skin_uni_hue', 'u_skin_uni_sat', 'u_skin_uni_lum', 'u_skin_hw',
];
for (const ch of channels) {
  uniforms.push(`u_hsl_${ch}_h`, `u_hsl_${ch}_s`, `u_hsl_${ch}_l`);
}

export const HSLDetailPass: RenderPass = {
  name: 'hslDetail',
  uniforms,
  fragmentShader: `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture;

// Per-channel uniforms
uniform float u_hsl_red_h, u_hsl_red_s, u_hsl_red_l;
uniform float u_hsl_orange_h, u_hsl_orange_s, u_hsl_orange_l;
uniform float u_hsl_yellow_h, u_hsl_yellow_s, u_hsl_yellow_l;
uniform float u_hsl_green_h, u_hsl_green_s, u_hsl_green_l;
uniform float u_hsl_aqua_h, u_hsl_aqua_s, u_hsl_aqua_l;
uniform float u_hsl_blue_h, u_hsl_blue_s, u_hsl_blue_l;
uniform float u_hsl_purple_h, u_hsl_purple_s, u_hsl_purple_l;
uniform float u_hsl_magenta_h, u_hsl_magenta_s, u_hsl_magenta_l;

// View selected range: if u_view_sel_hue >= 0, desaturate pixels outside the range
uniform float u_view_sel_hue;      // -1 = off, 0-360 = center hue
uniform float u_view_sel_hw;       // half-width in degrees
uniform float u_view_sel_sat_min;  // 0-1, inner sat boundary (0 = off)
uniform float u_view_sel_sat_max;  // 0-1, outer sat boundary (0 = off)

// Skin tone uniformity: pull colors toward reference point
uniform float u_skin_ref_hue;  // reference hue (degrees, 0 is a valid red)
uniform float u_skin_ref_sat;  // reference saturation (0-100)
uniform float u_skin_ref_lum;  // reference lightness (0-100)
uniform float u_skin_uni_hue;  // uniformity strength hue (0-1)
uniform float u_skin_uni_sat;  // uniformity strength sat (0-1)
uniform float u_skin_uni_lum;  // uniformity strength lum (0-1)
uniform float u_skin_hw;       // hue half-width for skin range

vec3 rgb2hsl(vec3 c) {
  float maxC = max(c.r, max(c.g, c.b));
  float minC = min(c.r, min(c.g, c.b));
  float l = (maxC + minC) * 0.5;
  float d = maxC - minC;
  float s = (d < 0.001) ? 0.0 : d / (1.0 - abs(2.0 * l - 1.0));
  float h = 0.0;
  if (d > 0.001) {
    if (maxC == c.r) h = mod((c.g - c.b) / d, 6.0);
    else if (maxC == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
  }
  return vec3(h, s, l);
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
  float h = hsl.x, s = hsl.y, l = hsl.z;
  if (s < 0.001) return vec3(l);
  float q = (l < 0.5) ? l * (1.0 + s) : l + s - l * s;
  float p = 2.0 * l - q;
  return vec3(
    hue2rgb(p, q, h + 1.0/3.0),
    hue2rgb(p, q, h),
    hue2rgb(p, q, h - 1.0/3.0)
  );
}

// Get channel weight for a given hue (0..1)
// 8 channels spaced 45° apart, with smooth transitions
float channelWeight(float hue, float center) {
  float d = abs(hue - center);
  d = min(d, 1.0 - d); // wrap around
  return smoothstep(0.08, 0.0, d); // ~30° window
}

void main() {
  vec4 color = texture(u_texture, v_texCoord);
  vec3 hsl = rgb2hsl(color.rgb);

  // Save original hue for view-selected check (before any HSL shifts)
  float origHue = hsl.x * 360.0;
  float origSat = hsl.y;

  // Channel centers (hue 0..1): red=0, orange=0.083, yellow=0.167, green=0.333, aqua=0.5, blue=0.667, purple=0.75, magenta=0.917
  float hueShift = 0.0, satShift = 0.0, lumShift = 0.0;

  hueShift += channelWeight(hsl.x, 0.0)    * u_hsl_red_h / 360.0;
  hueShift += channelWeight(hsl.x, 0.083)  * u_hsl_orange_h / 360.0;
  hueShift += channelWeight(hsl.x, 0.167)  * u_hsl_yellow_h / 360.0;
  hueShift += channelWeight(hsl.x, 0.333)  * u_hsl_green_h / 360.0;
  hueShift += channelWeight(hsl.x, 0.5)    * u_hsl_aqua_h / 360.0;
  hueShift += channelWeight(hsl.x, 0.667)  * u_hsl_blue_h / 360.0;
  hueShift += channelWeight(hsl.x, 0.75)   * u_hsl_purple_h / 360.0;
  hueShift += channelWeight(hsl.x, 0.917)  * u_hsl_magenta_h / 360.0;

  satShift += channelWeight(hsl.x, 0.0)    * u_hsl_red_s / 100.0;
  satShift += channelWeight(hsl.x, 0.083)  * u_hsl_orange_s / 100.0;
  satShift += channelWeight(hsl.x, 0.167)  * u_hsl_yellow_s / 100.0;
  satShift += channelWeight(hsl.x, 0.333)  * u_hsl_green_s / 100.0;
  satShift += channelWeight(hsl.x, 0.5)    * u_hsl_aqua_s / 100.0;
  satShift += channelWeight(hsl.x, 0.667)  * u_hsl_blue_s / 100.0;
  satShift += channelWeight(hsl.x, 0.75)   * u_hsl_purple_s / 100.0;
  satShift += channelWeight(hsl.x, 0.917)  * u_hsl_magenta_s / 100.0;

  lumShift += channelWeight(hsl.x, 0.0)    * u_hsl_red_l / 100.0;
  lumShift += channelWeight(hsl.x, 0.083)  * u_hsl_orange_l / 100.0;
  lumShift += channelWeight(hsl.x, 0.167)  * u_hsl_yellow_l / 100.0;
  lumShift += channelWeight(hsl.x, 0.333)  * u_hsl_green_l / 100.0;
  lumShift += channelWeight(hsl.x, 0.5)    * u_hsl_aqua_l / 100.0;
  lumShift += channelWeight(hsl.x, 0.667)  * u_hsl_blue_l / 100.0;
  lumShift += channelWeight(hsl.x, 0.75)   * u_hsl_purple_l / 100.0;
  lumShift += channelWeight(hsl.x, 0.917)  * u_hsl_magenta_l / 100.0;

  hsl.x = fract(hsl.x + hueShift);
  hsl.y = clamp(hsl.y + satShift, 0.0, 1.0);
  hsl.z = clamp(hsl.z + lumShift, 0.0, 1.0);

  // Skin tone uniformity: pull pixel HSL toward reference within the hue range
  if (u_skin_uni_hue > 0.0 || u_skin_uni_sat > 0.0 || u_skin_uni_lum > 0.0) {
    float pixH = hsl.x * 360.0;
    float dSkin = abs(pixH - u_skin_ref_hue);
    if (dSkin > 180.0) dSkin = 360.0 - dSkin;
    if (dSkin < u_skin_hw * 1.5) {
      // How much this pixel is inside the range (1 = center, 0 = edge)
      float inRange = 1.0 - smoothstep(u_skin_hw * 0.8, u_skin_hw * 1.5, dSkin);
      // Pull toward reference
      float refH = u_skin_ref_hue / 360.0;
      float refS = u_skin_ref_sat / 100.0;
      float refL = u_skin_ref_lum / 100.0;
      hsl.x = mix(hsl.x, refH, u_skin_uni_hue * inRange);
      hsl.y = mix(hsl.y, refS, u_skin_uni_sat * inRange);
      hsl.z = mix(hsl.z, refL, u_skin_uni_lum * inRange);
    }
  }

  // View selected range: check against ORIGINAL hue/sat (before HSL shifts),
  // but desaturate the SHIFTED result — so shifted colors stay visible in their new hue
  if (u_view_sel_hue >= 0.0) {
    float dHue = abs(origHue - u_view_sel_hue);
    if (dHue > 180.0) dHue = 360.0 - dHue;
    float innerEdge = u_view_sel_hw * 0.65;
    float hueFade = smoothstep(innerEdge, u_view_sel_hw, dHue);

    // Saturation boundary: check against original saturation
    float satFade = 0.0;
    if (u_view_sel_sat_max > 0.0) {
      float pixSat = origSat; // original saturation
      float featherSat = (u_view_sel_hw - innerEdge) / 360.0; // proportional feather in sat space
      float satMargin = 0.0;
      if (pixSat < u_view_sel_sat_min) satMargin = u_view_sel_sat_min - pixSat;
      else if (pixSat > u_view_sel_sat_max) satMargin = pixSat - u_view_sel_sat_max;
      if (satMargin > 0.0) {
        satFade = smoothstep(0.0, max(featherSat, 0.01), satMargin);
      }
    }

    float totalFade = 1.0 - (1.0 - hueFade) * (1.0 - satFade);
    hsl.y *= (1.0 - totalFade);
  }

  fragColor = vec4(hsl2rgb(hsl), color.a);
}`,
};
