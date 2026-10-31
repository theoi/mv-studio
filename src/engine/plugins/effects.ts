/** Built-in effects: full-screen GLSL passes over a premultiplied layer. Pixel sizes are relative to a 1080p canvas. */
import type { EffectDefinition } from '../types.ts'

/** Vogel-disk sampling helper shared by the blur-based effects; `r` is the radius in pixels. */
const DISK = `
vec2 diskOffset(int i, int n, float r) {
  float fi = float(i) + 0.5;
  float rr = sqrt(fi / float(n)) * r;
  float a = fi * 2.39996323;
  return vec2(cos(a), sin(a)) * rr / u_resolution;
}
float scalePx(float px) { return px * u_resolution.y / 1080.0; }`

export const blur: EffectDefinition = {
  kind: 'effect',
  id: 'blur',
  name: 'Blur',
  category: 'Blur',
  description: 'Soft, even blur.',
  params: [
    { key: 'radius', label: 'Radius', type: 'number', default: 12, min: 0, max: 80, step: 0.5, unit: 'px' },
  ],
  fragmentShader: `${DISK}
vec4 mainImage(vec2 uv) {
  float r = scalePx(u_radius);
  if (r < 0.5) return texture(u_input, uv);
  vec4 sum = vec4(0.0);
  float total = 0.0;
  const int N = 64;
  for (int i = 0; i < N; i++) {
    float w = 1.0 - 0.6 * (float(i) + 0.5) / float(N);
    sum += texture(u_input, uv + diskOffset(i, N, r)) * w;
    total += w;
  }
  return sum / total;
}`,
}

export const glow: EffectDefinition = {
  kind: 'effect',
  id: 'glow',
  name: 'Glow',
  category: 'Light',
  description: 'Bright areas bloom outward.',
  params: [
    { key: 'intensity', label: 'Intensity', type: 'number', default: 1, min: 0, max: 4, step: 0.05 },
    { key: 'radius', label: 'Radius', type: 'number', default: 24, min: 1, max: 80, step: 0.5, unit: 'px' },
    { key: 'threshold', label: 'Threshold', type: 'number', default: 0.6, min: 0, max: 1, step: 0.01 },
    { key: 'tint', label: 'Tint', type: 'color', default: '#ffffff', advanced: true },
  ],
  fragmentShader: `${DISK}
vec4 mainImage(vec2 uv) {
  vec4 base = texture(u_input, uv);
  float r = scalePx(u_radius);
  vec3 sum = vec3(0.0);
  float total = 0.0;
  const int N = 48;
  for (int i = 0; i < N; i++) {
    vec4 s = texture(u_input, uv + diskOffset(i, N, r));
    float l = max(s.r, max(s.g, s.b));
    float k = smoothstep(u_threshold, min(u_threshold + 0.25, 1.0001), l);
    float w = 1.0 - 0.7 * (float(i) + 0.5) / float(N);
    sum += s.rgb * k * w;
    total += w;
  }
  vec3 g = sum / total * u_intensity * u_tint.rgb;
  vec3 rgb = min(base.rgb + g, vec3(1.0));
  return vec4(rgb, max(base.a, max(rgb.r, max(rgb.g, rgb.b))));
}`,
}

export const rgbSplit: EffectDefinition = {
  kind: 'effect',
  id: 'rgb-split',
  name: 'RGB split',
  category: 'Distort',
  description: 'Offsets the red and blue channels, great on beats.',
  params: [
    { key: 'amount', label: 'Amount', type: 'number', default: 8, min: 0, max: 60, step: 0.5, unit: 'px' },
    { key: 'angle', label: 'Angle', type: 'number', default: 0, min: -180, max: 180, step: 1, unit: '°' },
  ],
  fragmentShader: `
vec4 mainImage(vec2 uv) {
  float a = radians(u_angle);
  vec2 off = vec2(cos(a), sin(a)) * u_amount * (u_resolution.y / 1080.0) / u_resolution;
  vec4 r = texture(u_input, uv + off);
  vec4 g = texture(u_input, uv);
  vec4 b = texture(u_input, uv - off);
  return vec4(r.r, g.g, b.b, max(max(r.a, g.a), b.a));
}`,
}

export const vignette: EffectDefinition = {
  kind: 'effect',
  id: 'vignette',
  name: 'Vignette',
  category: 'Color',
  description: 'Darkens the edges of the frame.',
  params: [
    { key: 'amount', label: 'Amount', type: 'number', default: 0.6, min: 0, max: 1, step: 0.01 },
    { key: 'size', label: 'Size', type: 'number', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'softness', label: 'Softness', type: 'number', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'color', label: 'Color', type: 'color', default: '#000000', advanced: true },
  ],
  fragmentShader: `
vec4 mainImage(vec2 uv) {
  vec4 c = texture(u_input, uv);
  vec2 aspect = vec2(u_resolution.x / u_resolution.y, 1.0);
  float d = length((uv - 0.5) * aspect) / length(aspect * 0.5);
  float inner = mix(0.25, 1.0, u_size);
  float soft = mix(0.05, 0.9, u_softness);
  float k = smoothstep(inner - soft, inner, d) * u_amount;
  return vec4(mix(c.rgb, u_color.rgb * c.a, k), c.a);
}`,
}

export const filmGrain: EffectDefinition = {
  kind: 'effect',
  id: 'film-grain',
  name: 'Film grain',
  category: 'Texture',
  description: 'Animated photographic grain.',
  params: [
    { key: 'amount', label: 'Amount', type: 'number', default: 0.15, min: 0, max: 1, step: 0.01 },
    {
      key: 'size',
      label: 'Grain size',
      type: 'number',
      default: 1.5,
      min: 0.5,
      max: 6,
      step: 0.1,
      unit: 'px',
    },
    { key: 'monochrome', label: 'Monochrome', type: 'boolean', default: true, advanced: true },
  ],
  fragmentShader: `
float hash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
vec4 mainImage(vec2 uv) {
  vec4 c = texture(u_input, uv);
  float s = max(u_size, 0.5) * u_resolution.y / 1080.0;
  vec2 cell = floor(uv * u_resolution / s);
  float frame = mod(floor(u_time * 24.0), 997.0);
  float n = hash(vec3(cell, frame)) - 0.5;
  vec3 noise = u_monochrome > 0.5
    ? vec3(n)
    : vec3(n, hash(vec3(cell, frame + 17.0)) - 0.5, hash(vec3(cell, frame + 43.0)) - 0.5);
  return vec4(clamp(c.rgb + noise * u_amount * c.a, 0.0, c.a), c.a);
}`,
}

export const BUILTIN_EFFECTS: EffectDefinition[] = [glow, blur, rgbSplit, vignette, filmGrain]
