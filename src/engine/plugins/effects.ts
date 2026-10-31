/** Built-in effects: full-screen GLSL passes over a premultiplied layer. Pixel sizes are relative to a 1080p canvas. */
import type { EffectDefinition, EffectPass } from '../types.ts'

const PYRAMID_LEVELS = 7

/**
 * Blur radius (1080p pixels, read from u_radius) as a continuous pyramid level. The radius maps to a Gaussian-like
 * sigma of 0.46 * radius, the spread of the disk blur this replaced. Stopping the pyramid at level k blurs with a
 * variance of 11/12 * 4^k - 9/4 canvas pixels squared (summed from the tap offsets and bilinear reconstruction of every
 * pass), and blending two levels blends their variances, so the fractional level matches the variance exactly.
 */
const PYRAMID_LEVEL = `
float pyramidVariance(float k) { return 0.916667 * exp2(2.0 * k) - 2.25; }
float pyramidLevel() {
  float sigma = 0.46 * u_radius * u_resolution.y / 1080.0;
  float v = sigma * sigma;
  float v1 = pyramidVariance(1.0);
  if (v < v1) return v / v1;
  float k = clamp(floor(0.5 * log2((v + 2.25) / 0.916667)), 1.0, ${PYRAMID_LEVELS - 1}.0);
  float vk = pyramidVariance(k);
  return min(k + (v - vk) / (pyramidVariance(k + 1.0) - vk), ${PYRAMID_LEVELS}.0);
}`

const diagonal5 = (sample: (offset: string) => string) =>
  `(${sample('vec2(0.0)')} * 4.0 + ${sample('t')} + ${sample('-t')} + ${sample('vec2(t.x, -t.y)')} + ${sample('vec2(-t.x, t.y)')}) / 8.0`

/**
 * Passes of a dual-filter blur pyramid (Bjørge, "Bandwidth-efficient rendering", SIGGRAPH 2015): 5-tap downsamples to
 * 1/2 ... 1/128 of the canvas, then 8-tap upsamples back to 1/2 that stop blending in finer levels once the radius
 * is reached. About 7 full-resolution texture reads per pixel at any radius. `tap` defines `vec4 tap(vec2 uv)`, the
 * layer as the pyramid sees it (for example only its highlights). The final shader reads the result as u_u1.
 */
export function blurPyramid(tap = 'vec4 tap(vec2 uv) { return texture(u_input, uv); }'): EffectPass[] {
  const passes: EffectPass[] = [
    {
      id: 'd1',
      scale: 0.5,
      fragmentShader: `${tap}
vec4 mainImage(vec2 uv) {
  vec2 t = 1.0 / u_resolution;
  return ${diagonal5((o) => `tap(uv + ${o})`)};
}`,
    },
  ]
  for (let k = 2; k <= PYRAMID_LEVELS; k++)
    passes.push({
      id: `d${k}`,
      scale: 2 ** -k,
      inputs: [`d${k - 1}`],
      fragmentShader: `
vec4 mainImage(vec2 uv) {
  vec2 t = 1.0 / u_d${k - 1}Size;
  return ${diagonal5((o) => `texture(u_d${k - 1}, uv + ${o})`)};
}`,
    })
  for (let k = PYRAMID_LEVELS - 1; k >= 1; k--) {
    const low = k === PYRAMID_LEVELS - 1 ? `d${PYRAMID_LEVELS}` : `u${k + 1}`
    const s = (o: string) => `texture(u_${low}, uv + ${o})`
    passes.push({
      id: `u${k}`,
      scale: 2 ** -k,
      inputs: [`d${k}`, low],
      fragmentShader: `${PYRAMID_LEVEL}
vec4 mainImage(vec2 uv) {
  float t = clamp(pyramidLevel() - ${k}.0, 0.0, 1.0);
  if (t <= 0.0) return texture(u_d${k}, uv);
  vec2 h = 0.5 / u_${low}Size;
  vec4 up = (${s('vec2(-2.0 * h.x, 0.0)')} + ${s('vec2(2.0 * h.x, 0.0)')} + ${s('vec2(0.0, 2.0 * h.y)')} + ${s('vec2(0.0, -2.0 * h.y)')}
    + 2.0 * (${s('h')} + ${s('-h')} + ${s('vec2(h.x, -h.y)')} + ${s('vec2(-h.x, h.y)')})) / 12.0;
  return t >= 1.0 ? up : mix(texture(u_d${k}, uv), up, t);
}`,
    })
  }
  return passes
}

export const blur: EffectDefinition = {
  kind: 'effect',
  id: 'blur',
  name: 'Blur',
  category: 'Blur',
  description: 'Soft, even blur.',
  tags: ['soft', 'defocus', 'dreamy'],
  cost: 'low',
  params: [
    { key: 'radius', label: 'Radius', type: 'number', default: 12, min: 0, max: 80, step: 0.5, unit: 'px' },
  ],
  passes: blurPyramid(),
  fragmentShader: `${PYRAMID_LEVEL}
vec4 mainImage(vec2 uv) {
  vec4 base = texture(u_input, uv);
  float level = pyramidLevel();
  return level <= 0.0 ? base : mix(base, texture(u_u1, uv), min(level, 1.0));
}`,
}

/**
 * The highlights glow spreads from: pixels brighter than u_threshold, weighted by how far above it they are (full
 * weight only at white, with a soft knee), so bright footage glows from its light sources rather than everywhere.
 */
const GLOW_BRIGHT = `
vec4 bright(vec4 s) {
  float l = max(s.r, max(s.g, s.b));
  float x = l - u_threshold;
  float soft = clamp(x + 0.1, 0.0, 0.2);
  return s * clamp(max(soft * soft * 2.5, x) / max(1.0 - u_threshold, 0.05), 0.0, 1.0);
}`

export const glow: EffectDefinition = {
  kind: 'effect',
  id: 'glow',
  name: 'Glow',
  category: 'Light',
  description: 'Bright areas bloom outward.',
  tags: ['bloom', 'dreamy', 'soft', 'light'],
  cost: 'low',
  params: [
    { key: 'intensity', label: 'Intensity', type: 'number', default: 1, min: 0, max: 4, step: 0.05 },
    { key: 'radius', label: 'Radius', type: 'number', default: 24, min: 1, max: 80, step: 0.5, unit: 'px' },
    { key: 'threshold', label: 'Threshold', type: 'number', default: 0.6, min: 0, max: 1, step: 0.01 },
    { key: 'tint', label: 'Tint', type: 'color', default: '#ffffff', advanced: true },
  ],
  passes: [
    ...blurPyramid(`${GLOW_BRIGHT}
vec4 tap(vec2 uv) { return bright(texture(u_input, uv)); }`),
    {
      // Share of the frame above the threshold, averaged once from the coarsest pyramid level into a 1x1 target.
      id: 'share',
      scale: 1 / 4096,
      inputs: [`d${PYRAMID_LEVELS}`],
      fragmentShader: `
vec4 mainImage(vec2 uv) {
  float s = 0.0;
  for (int y = 0; y < 4; y++)
    for (int x = 0; x < 4; x++) {
      vec3 b = texture(u_d${PYRAMID_LEVELS}, (vec2(x, y) + 0.5) / 4.0).rgb;
      s += max(b.r, max(b.g, b.b));
    }
  return vec4(s / 16.0);
}`,
    },
  ],
  passInputs: ['u1', 'share'],
  fragmentShader: `${PYRAMID_LEVEL}
${GLOW_BRIGHT}

vec4 mainImage(vec2 uv) {
  vec4 base = texture(u_input, uv);
  float level = pyramidLevel();
  vec3 g = texture(u_u1, uv).rgb;
  if (level < 1.0) g = mix(bright(base).rgb, g, level);
  // Like the eye adapting to a bright scene, glow eases off when much of the frame is bright, so it stays a glow
  // around light sources instead of a haze over bright footage.
  float adapt = 1.0 / (1.0 + 4.0 * max(texture(u_share, vec2(0.5)).r - 0.06, 0.0));
  // Screen blend of light that saturates smoothly: glow brightens dark surroundings fully but cannot blow out what
  // is already bright.
  g = 1.0 - exp(-g * u_intensity * adapt * u_tint.rgb);
  vec3 rgb = base.rgb + g * (1.0 - base.rgb);
  return vec4(rgb, max(base.a, max(rgb.r, max(rgb.g, rgb.b))));
}`,
}

export const rgbSplit: EffectDefinition = {
  kind: 'effect',
  id: 'rgb-split',
  name: 'RGB split',
  category: 'Distort',
  description: 'Offsets the red and blue channels, great on beats.',
  tags: ['reactive', 'beat', 'rgb', 'chromatic'],
  cost: 'low',
  defaultModulation: { amount: [{ source: { kind: 'beat' }, amount: 12, mode: 'add', smoothing: 0.2 }] },
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
  tags: ['edges', 'cinematic', 'frame'],
  cost: 'low',
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
  tags: ['film', 'noise', 'analog'],
  cost: 'low',
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
  vec2 cell = floor(uv * u_resolution / max(s, 1.0));
  // Grain finer than a pixel (reduced-size previews) averages out, so it is weaker there, as in the full-size render.
  float strength = u_amount * min(s, 1.0);
  float frame = mod(floor(u_time * 24.0), 997.0);
  float n = hash(vec3(cell, frame)) - 0.5;
  vec3 noise = u_monochrome > 0.5
    ? vec3(n)
    : vec3(n, hash(vec3(cell, frame + 17.0)) - 0.5, hash(vec3(cell, frame + 43.0)) - 0.5);
  return vec4(clamp(c.rgb + noise * strength * c.a, 0.0, c.a), c.a);
}`,
}

export const BUILTIN_EFFECTS: EffectDefinition[] = [glow, blur, rgbSplit, vignette, filmGrain]
