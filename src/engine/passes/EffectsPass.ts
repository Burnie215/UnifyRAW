import type { RenderPass } from './RenderPass';

/**
 * Combined effects: Vignette + Grain + Noise Reduction (blur)
 */
export const EffectsPass: RenderPass = {
  name: 'effects',
  uniforms: ['u_vignette', 'u_vignetteFeather', 'u_grain', 'u_grainSize', 'u_noiseReduction', 'u_resolution'],
  fragmentShader: `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture;
uniform float u_vignette;
uniform float u_vignetteFeather;
uniform float u_grain;
uniform float u_grainSize;
uniform float u_noiseReduction;
uniform vec2 u_resolution;

// Simple hash for grain noise
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec4 color = texture(u_texture, v_texCoord);
  vec3 c = color.rgb;

  // Noise reduction (simple box blur)
  if (u_noiseReduction > 0.01) {
    vec2 texel = 1.0 / u_resolution;
    vec3 blur = vec3(0.0);
    float radius = u_noiseReduction * 2.0;
    int r = int(ceil(radius));
    float total = 0.0;
    for (int x = -r; x <= r; x++) {
      for (int y = -r; y <= r; y++) {
        float w = exp(-float(x*x + y*y) / (radius * radius * 0.5));
        blur += texture(u_texture, v_texCoord + vec2(float(x), float(y)) * texel).rgb * w;
        total += w;
      }
    }
    c = mix(c, blur / total, u_noiseReduction * 0.7);
  }

  // Vignette
  if (abs(u_vignette) > 0.01) {
    vec2 uv = v_texCoord - 0.5;
    float dist = length(uv * vec2(1.0, u_resolution.y / u_resolution.x));
    float feather = 0.3 + u_vignetteFeather * 0.4;
    float vig = smoothstep(feather, feather * 0.3, dist);
    if (u_vignette < 0.0) {
      c *= mix(1.0, vig, abs(u_vignette));
    } else {
      c = mix(c, vec3(1.0), (1.0 - vig) * u_vignette * 0.5);
    }
  }

  // Grain
  if (u_grain > 0.01) {
    float scale = max(1.0, u_grainSize * 0.5);
    vec2 grainCoord = floor(v_texCoord * u_resolution / scale);
    float noise = hash(grainCoord) * 2.0 - 1.0;
    c += noise * u_grain * 0.15;
  }

  fragColor = vec4(clamp(c, 0.0, 1.0), color.a);
}`,
};
