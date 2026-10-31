/**
 * Library transitions. u_progress is already eased; a missing side (fading from or to the layers below) samples as
 * transparent, so every transition composites rather than assuming opaque shots.
 */
import type { ParamSpec, TransitionDefinition } from '../engine/types.ts'
import { COMMON, HASH, NOISE } from './glsl.ts'

/** Shared helpers: bounded sampling (transparent outside the frame) and the direction a shot travels. */
const T = `${COMMON}
vec4 fromAt(vec2 p) { return texture(u_from, p) * insideUv(p); }
vec4 toAt(vec2 p) { return texture(u_to, p) * insideUv(p); }
vec4 over(vec4 top, vec4 below) { return top + below * (1.0 - top.a); }`

const DIRECTION = `
vec2 travel() {
  int d = int(u_direction + 0.5);
  return d == 0 ? vec2(-1.0, 0.0) : d == 1 ? vec2(1.0, 0.0) : d == 2 ? vec2(0.0, 1.0) : vec2(0.0, -1.0);
}`

const direction = (fallback = 'left'): ParamSpec => ({
  key: 'direction',
  label: 'Direction',
  type: 'select',
  default: fallback,
  options: [
    { value: 'left', label: 'Left' },
    { value: 'right', label: 'Right' },
    { value: 'up', label: 'Up' },
    { value: 'down', label: 'Down' },
  ],
})

const softness = (fallback: number, max = 0.5): ParamSpec => ({
  key: 'softness',
  label: 'Edge softness',
  type: 'number',
  default: fallback,
  min: 0,
  max,
  step: 0.005,
})

export const dip: TransitionDefinition = {
  kind: 'transition',
  id: 'dip',
  name: 'Dip to color',
  category: 'Basic',
  description: 'Fades out to a color, then into the next shot.',
  tags: ['fade', 'black', 'white', 'classic'],
  cost: 'low',
  defaultDuration: 0.8,
  params: [
    { key: 'color', label: 'Color', type: 'color', default: '#000000' },
    {
      key: 'hold',
      label: 'Hold',
      type: 'number',
      default: 0.1,
      min: 0,
      max: 0.8,
      step: 0.01,
      advanced: true,
    },
  ],
  fragmentShader: `
vec4 transition(vec2 uv) {
  float h = u_hold * 0.5;
  vec4 mid = vec4(u_color.rgb, 1.0);
  vec4 c = mix(texture(u_from, uv), mid, smoothstep(0.0, 0.5 - h, u_progress));
  return mix(c, texture(u_to, uv), smoothstep(0.5 + h, 1.0, u_progress));
}`,
}

export const wipe: TransitionDefinition = {
  kind: 'transition',
  id: 'wipe',
  name: 'Wipe',
  category: 'Shape',
  description: 'A clean angled wipe with a glowing edge.',
  tags: ['wipe', 'line', 'clean'],
  cost: 'low',
  defaultDuration: 0.5,
  params: [
    { key: 'angle', label: 'Angle', type: 'number', default: 30, min: 0, max: 360, step: 1, unit: '°' },
    softness(0.02),
    { key: 'glow', label: 'Edge glow', type: 'number', default: 0.6, min: 0, max: 2, step: 0.01 },
    { key: 'glowColor', label: 'Glow color', type: 'color', default: '#ffffff', advanced: true },
  ],
  fragmentShader: `${T}
vec4 transition(vec2 uv) {
  float a = radians(u_angle);
  vec2 dir = vec2(cos(a), sin(a));
  vec2 asp = vec2(aspectRatio(), 1.0);
  float d = dot((uv - 0.5) * asp, dir);
  float extent = 0.5 * (abs(dir.x) * asp.x + abs(dir.y));
  float s = max(u_softness, 0.001);
  float edge = mix(-extent - s, extent + s, u_progress);
  vec4 c = mix(texture(u_from, uv), texture(u_to, uv), 1.0 - smoothstep(edge - s, edge + s, d));
  float line = exp(-abs(d - edge) / max(px(5.0) / u_resolution.y, 1e-4)) * u_glow * sin(PI * u_progress);
  return vec4(min(c.rgb + u_glowColor.rgb * line, 1.0), max(c.a, min(line, 1.0)));
}`,
}

export const iris: TransitionDefinition = {
  kind: 'transition',
  id: 'iris',
  name: 'Iris',
  category: 'Shape',
  description: 'The next shot opens from the center in a circle, diamond, square or star.',
  tags: ['circle', 'shape', 'reveal', 'star'],
  cost: 'low',
  defaultDuration: 0.7,
  params: [
    {
      key: 'shape',
      label: 'Shape',
      type: 'select',
      default: 'circle',
      options: [
        { value: 'circle', label: 'Circle' },
        { value: 'diamond', label: 'Diamond' },
        { value: 'square', label: 'Square' },
        { value: 'star', label: 'Star' },
      ],
    },
    softness(0.02, 0.3),
    {
      key: 'centerX',
      label: 'Center X',
      type: 'number',
      default: 0.5,
      min: 0,
      max: 1,
      step: 0.01,
      advanced: true,
    },
    {
      key: 'centerY',
      label: 'Center Y',
      type: 'number',
      default: 0.5,
      min: 0,
      max: 1,
      step: 0.01,
      advanced: true,
    },
  ],
  fragmentShader: `${T}
float shapeDist(vec2 q) {
  int s = int(u_shape + 0.5);
  if (s == 0) return length(q);
  if (s == 1) return (abs(q.x) + abs(q.y)) * 0.75;
  if (s == 2) return max(abs(q.x), abs(q.y));
  float a = atan(q.y, q.x) - PI * 0.5;
  return length(q) / mix(0.45, 1.0, pow(abs(cos(2.5 * a)), 3.0)) * 0.6;
}
vec4 transition(vec2 uv) {
  vec2 asp = vec2(aspectRatio(), 1.0);
  vec2 c = vec2(u_centerX, u_centerY);
  float far = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 corner = vec2(float(i % 2), float(i / 2));
    far = max(far, shapeDist((corner - c) * asp));
  }
  far *= u_shape > 2.5 ? 1.25 : 1.0;
  float s = max(u_softness, 0.001);
  float r = mix(-s, far + s, u_progress);
  float m = 1.0 - smoothstep(r - s, r + s, shapeDist((uv - c) * asp));
  return mix(texture(u_from, uv), texture(u_to, uv), m);
}`,
}

export const clock: TransitionDefinition = {
  kind: 'transition',
  id: 'clock',
  name: 'Clock wipe',
  category: 'Shape',
  description: 'Sweeps around like a clock hand.',
  tags: ['radial', 'sweep', 'wipe'],
  cost: 'low',
  defaultDuration: 0.7,
  params: [
    softness(0.01, 0.2),
    { key: 'reverse', label: 'Counterclockwise', type: 'boolean', default: false },
  ],
  fragmentShader: `${T}
vec4 transition(vec2 uv) {
  vec2 q = (uv - 0.5) * vec2(aspectRatio(), 1.0);
  float a = atan(u_reverse > 0.5 ? -q.x : q.x, q.y);
  float f = fract(a / TAU + 1.0);
  float s = max(u_softness, 0.001);
  float edge = mix(-s, 1.0 + s, u_progress);
  return mix(texture(u_from, uv), texture(u_to, uv), 1.0 - smoothstep(edge - s, edge + s, f));
}`,
}

export const blinds: TransitionDefinition = {
  kind: 'transition',
  id: 'blinds',
  name: 'Blinds',
  category: 'Shape',
  description: 'Slats open one after another.',
  tags: ['stripes', 'venetian', 'slats'],
  cost: 'low',
  defaultDuration: 0.7,
  params: [
    { key: 'count', label: 'Slats', type: 'number', default: 10, min: 2, max: 40, step: 1 },
    { key: 'vertical', label: 'Vertical', type: 'boolean', default: true },
    softness(0.03, 0.3),
    {
      key: 'stagger',
      label: 'Stagger',
      type: 'number',
      default: 0.6,
      min: 0,
      max: 2,
      step: 0.01,
      advanced: true,
    },
  ],
  fragmentShader: `${T}
vec4 transition(vec2 uv) {
  float n = max(floor(u_count), 1.0);
  float x = u_vertical > 0.5 ? uv.x : 1.0 - uv.y;
  float f = fract(x * n);
  float p = clamp(u_progress * (1.0 + u_stagger) - floor(x * n) / n * u_stagger, 0.0, 1.0);
  float s = max(u_softness, 0.001);
  float edge = mix(-s, 1.0 + s, p);
  return mix(texture(u_from, uv), texture(u_to, uv), 1.0 - smoothstep(edge - s, edge + s, f));
}`,
}

export const lumaWipe: TransitionDefinition = {
  kind: 'transition',
  id: 'luma-wipe',
  name: 'Luma wipe',
  category: 'Shape',
  description: 'The brightest parts of the shot give way first.',
  tags: ['luminance', 'organic', 'dissolve', 'cinematic'],
  cost: 'low',
  defaultDuration: 0.9,
  params: [
    softness(0.15),
    { key: 'invert', label: 'Darkest first', type: 'boolean', default: false },
    {
      key: 'source',
      label: 'Brightness from',
      type: 'select',
      default: 'from',
      options: [
        { value: 'from', label: 'Outgoing shot' },
        { value: 'to', label: 'Incoming shot' },
      ],
      advanced: true,
    },
  ],
  fragmentShader: `${T}
vec4 transition(vec2 uv) {
  vec4 a = texture(u_from, uv);
  vec4 b = texture(u_to, uv);
  float l = luma(unpremultiply(u_source > 0.5 ? b : a));
  float key = u_invert > 0.5 ? l : 1.0 - l;
  float s = max(u_softness, 0.001);
  float t = mix(-s, 1.0 + s, u_progress);
  return mix(a, b, 1.0 - smoothstep(t - s, t + s, key));
}`,
}

export const noiseDissolve: TransitionDefinition = {
  kind: 'transition',
  id: 'noise-dissolve',
  name: 'Burn dissolve',
  category: 'Shape',
  description: 'Organic noise dissolve with a glowing burning edge.',
  tags: ['dissolve', 'burn', 'organic', 'noise', 'fire'],
  cost: 'medium',
  defaultDuration: 0.9,
  params: [
    { key: 'scale', label: 'Scale', type: 'number', default: 3.5, min: 1, max: 12, step: 0.1 },
    { key: 'edge', label: 'Edge width', type: 'number', default: 0.05, min: 0, max: 0.3, step: 0.005 },
    { key: 'glow', label: 'Edge glow', type: 'number', default: 1, min: 0, max: 3, step: 0.05 },
    { key: 'edgeColor', label: 'Edge color', type: 'color', default: '#ffb36b' },
  ],
  fragmentShader: `${T}${HASH}${NOISE}
vec4 transition(vec2 uv) {
  float n = clamp((fbm(uv * vec2(aspectRatio(), 1.0) * u_scale) - 0.2) / 0.6, 0.0, 1.0);
  float w = max(u_edge, 0.001);
  float t = mix(-w, 1.0 + w, u_progress);
  vec4 c = mix(texture(u_from, uv), texture(u_to, uv), 1.0 - smoothstep(t - 0.015, t + 0.015, n));
  // The glow runs just ahead of the dissolving front, on the side that has not changed yet.
  float ahead = n - t;
  float front = step(0.0, ahead) * (1.0 - smoothstep(0.0, w, ahead));
  vec3 g = u_edgeColor.rgb * front * front * u_glow * min(1.0, 8.0 * min(u_progress, 1.0 - u_progress));
  vec3 rgb = min(c.rgb + g, 1.0);
  return vec4(rgb, max(c.a, max(rgb.r, max(rgb.g, rgb.b))));
}`,
}

export const slide: TransitionDefinition = {
  kind: 'transition',
  id: 'slide',
  name: 'Slide',
  category: 'Motion',
  description: 'The next shot slides in over the current one.',
  tags: ['slide', 'cover', 'motion'],
  cost: 'low',
  defaultDuration: 0.5,
  params: [
    direction(),
    {
      key: 'blur',
      label: 'Motion blur',
      type: 'number',
      default: 0.5,
      min: 0,
      max: 1,
      step: 0.01,
      advanced: true,
    },
  ],
  fragmentShader: `${T}${DIRECTION}
vec4 transition(vec2 uv) {
  vec2 dir = travel();
  float p = u_progress;
  float blur = u_blur * sin(PI * p) * 0.08;
  vec4 incoming = vec4(0.0);
  const int N = 6;
  for (int i = 0; i < N; i++) incoming += toAt(uv + dir * (1.0 - p + (float(i) / float(N - 1) - 0.5) * blur));
  incoming /= float(N);
  vec4 outgoing = texture(u_from, uv);
  outgoing.rgb *= 1.0 - 0.35 * p;
  return over(incoming, outgoing);
}`,
}

export const push: TransitionDefinition = {
  kind: 'transition',
  id: 'push',
  name: 'Push',
  category: 'Motion',
  description: 'The next shot pushes the current one out of frame.',
  tags: ['push', 'slide', 'motion'],
  cost: 'low',
  defaultDuration: 0.5,
  params: [
    direction(),
    {
      key: 'blur',
      label: 'Motion blur',
      type: 'number',
      default: 0.5,
      min: 0,
      max: 1,
      step: 0.01,
      advanced: true,
    },
  ],
  fragmentShader: `${T}${DIRECTION}
vec4 transition(vec2 uv) {
  vec2 dir = travel();
  float p = u_progress;
  float blur = u_blur * sin(PI * p) * 0.08;
  vec4 sum = vec4(0.0);
  const int N = 6;
  // For each tap exactly one of the two shots covers the pixel, so the taps add up to full coverage.
  for (int i = 0; i < N; i++) {
    float o = (float(i) / float(N - 1) - 0.5) * blur;
    sum += fromAt(uv - dir * (p + o)) + toAt(uv + dir * (1.0 - p + o));
  }
  return sum / float(N);
}`,
}

export const whipPan: TransitionDefinition = {
  kind: 'transition',
  id: 'whip-pan',
  name: 'Whip pan',
  category: 'Motion',
  description: 'A fast camera whip with heavy motion blur, great on a snare or kick.',
  tags: ['beat', 'fast', 'whip', 'swish', 'motion blur', 'energetic'],
  cost: 'medium',
  defaultDuration: 0.35,
  params: [
    direction(),
    { key: 'blur', label: 'Motion blur', type: 'number', default: 1, min: 0, max: 2, step: 0.01 },
  ],
  fragmentShader: `${T}${DIRECTION}
vec4 transition(vec2 uv) {
  vec2 dir = travel();
  float p = u_progress;
  float q = p < 0.5 ? 4.0 * p * p * p : 1.0 - pow(-2.0 * p + 2.0, 3.0) * 0.5;
  float s = sin(PI * p);
  float blur = u_blur * s * s * 0.45;
  vec4 sum = vec4(0.0);
  const int N = 14;
  for (int i = 0; i < N; i++) {
    float o = (float(i) / float(N - 1) - 0.5) * blur;
    sum += fromAt(uv - dir * (q + o)) + toAt(uv + dir * (1.0 - q + o));
  }
  vec4 c = sum / float(N);
  c.rgb = min(c.rgb * (1.0 + 0.3 * s * s), vec3(c.a));
  return c;
}`,
}

export const zoomBlur: TransitionDefinition = {
  kind: 'transition',
  id: 'zoom-blur',
  name: 'Zoom blur',
  category: 'Motion',
  description: 'Rushes into the shot through a radial blur and lands on the next.',
  tags: ['beat', 'zoom', 'punch', 'radial', 'energetic'],
  cost: 'medium',
  defaultDuration: 0.5,
  params: [
    { key: 'strength', label: 'Strength', type: 'number', default: 0.8, min: 0.1, max: 2, step: 0.01 },
    {
      key: 'flash',
      label: 'Flash',
      type: 'number',
      default: 0.3,
      min: 0,
      max: 1,
      step: 0.01,
      advanced: true,
    },
  ],
  fragmentShader: `${T}
vec4 transition(vec2 uv) {
  float p = u_progress;
  float k = smoothstep(0.4, 0.6, p);
  float s = sin(PI * p);
  float zf = 1.0 + u_strength * p * 2.0;
  float zt = 1.0 + u_strength * (1.0 - p);
  float blur = s * u_strength * 0.3;
  vec4 a = vec4(0.0);
  vec4 b = vec4(0.0);
  const int N = 12;
  for (int i = 0; i < N; i++) {
    float spread = 1.0 + blur * float(i) / float(N - 1);
    if (k < 1.0) a += texture(u_from, 0.5 + (uv - 0.5) / (zf * spread));
    if (k > 0.0) b += texture(u_to, 0.5 + (uv - 0.5) / (zt * spread));
  }
  vec4 c = mix(a, b, k) / float(N);
  c.rgb = min(c.rgb + s * s * 0.25 * u_flash * c.a, vec3(c.a));
  return c;
}`,
}

export const spin: TransitionDefinition = {
  kind: 'transition',
  id: 'spin',
  name: 'Spin',
  category: 'Motion',
  description: 'Spins out of one shot and into the next with rotational blur.',
  tags: ['rotate', 'twist', 'energetic'],
  cost: 'medium',
  defaultDuration: 0.6,
  params: [
    { key: 'angle', label: 'Turn', type: 'number', default: 180, min: 45, max: 720, step: 5, unit: '°' },
    { key: 'zoom', label: 'Zoom', type: 'number', default: 0.4, min: 0, max: 1.5, step: 0.01 },
    { key: 'clockwise', label: 'Clockwise', type: 'boolean', default: true, advanced: true },
  ],
  fragmentShader: `${T}
vec2 wrapUv(vec2 p) { return 1.0 - abs(1.0 - mod(p, 2.0)); }
vec4 transition(vec2 uv) {
  float p = u_progress;
  vec2 asp = vec2(aspectRatio(), 1.0);
  vec2 q = (uv - 0.5) * asp;
  float sgn = u_clockwise > 0.5 ? -1.0 : 1.0;
  float total = radians(u_angle);
  float k = smoothstep(0.45, 0.55, p);
  float blur = sin(PI * p) * total * 0.1;
  float zoom = 1.0 + u_zoom * sin(PI * p);
  vec4 a = vec4(0.0);
  vec4 b = vec4(0.0);
  const int N = 10;
  for (int i = 0; i < N; i++) {
    float o = (float(i) / float(N - 1) - 0.5) * blur;
    if (k < 1.0) a += texture(u_from, wrapUv(rotate2d(sgn * total * p + o) * q / zoom / asp + 0.5));
    if (k > 0.0) b += texture(u_to, wrapUv(rotate2d(-sgn * total * (1.0 - p) + o) * q / zoom / asp + 0.5));
  }
  return mix(a, b, k) / float(N);
}`,
}

export const glitchCut: TransitionDefinition = {
  kind: 'transition',
  id: 'glitch-cut',
  name: 'Glitch cut',
  category: 'Glitch',
  description: 'Blocks of the next shot break through digital corruption.',
  tags: ['beat', 'digital', 'datamosh', 'corrupt', 'rgb'],
  cost: 'low',
  defaultDuration: 0.45,
  params: [
    { key: 'intensity', label: 'Intensity', type: 'number', default: 0.8, min: 0, max: 1, step: 0.01 },
    {
      key: 'split',
      label: 'Channel split',
      type: 'number',
      default: 24,
      min: 0,
      max: 80,
      step: 0.5,
      unit: 'px',
      advanced: true,
    },
  ],
  fragmentShader: `${T}${HASH}
vec4 pick(vec2 p, float useTo) { return useTo > 0.5 ? texture(u_to, p) : texture(u_from, p); }
vec4 transition(vec2 uv) {
  float p = u_progress;
  float k = sin(PI * p) * u_intensity;
  float tick = floor(p * 16.0);
  float band = floor(uv.y * (8.0 + 16.0 * hash11(tick + 0.5)));
  float hb = hash12(vec2(band, tick));
  float shift = step(1.0 - k * 0.8, hb) * (hash12(vec2(band, tick + 3.0)) - 0.5) * 0.3 * k;
  vec2 cell = floor(uv * vec2(16.0, 9.0) * (1.0 + floor(hash11(tick + 2.0) * 3.0)));
  float useTo = step(hash13(vec3(cell, 1.0)), smoothstep(0.2, 0.8, p));
  vec2 q = uv + vec2(shift, 0.0);
  float split = px(u_split) / u_resolution.x * k * (0.3 + step(0.7, hb));
  vec4 r = pick(q + vec2(split, 0.0), useTo);
  vec4 g = pick(q, useTo);
  vec4 b = pick(q - vec2(split, 0.0), useTo);
  vec4 c = vec4(r.r, g.g, b.b, max(g.a, max(r.a, b.a)));
  if (hash13(vec3(cell, tick + 9.0)) > 1.0 - 0.12 * k) c.rgb = c.brg;
  return c;
}`,
}

export const lightBurn: TransitionDefinition = {
  kind: 'transition',
  id: 'light-burn',
  name: 'Light burn',
  category: 'Light',
  description: 'An overexposed film burn flares across and reveals the next shot.',
  tags: ['film', 'flare', 'burn', 'warm', 'light leak'],
  cost: 'medium',
  defaultDuration: 0.8,
  params: [
    { key: 'color', label: 'Color', type: 'color', default: '#ff9a3c' },
    { key: 'intensity', label: 'Intensity', type: 'number', default: 1, min: 0, max: 2, step: 0.01 },
  ],
  fragmentShader: `${T}${HASH}${NOISE}
vec4 transition(vec2 uv) {
  float p = u_progress;
  float n = fbm(uv * vec2(aspectRatio(), 1.0) * 2.2 + vec2(p * 1.2, -p * 0.8));
  // A band of heat sweeps diagonally across the frame; behind it the next shot shows through.
  float d = (p * 1.8 - 0.4 + (n - 0.5) * 0.7) - (uv.x * 0.75 + (1.0 - uv.y) * 0.25);
  float heat = smoothstep(-0.35, 0.0, d) * exp(-max(d, 0.0) * 3.5) * sqrt(sin(PI * p));
  vec4 base = mix(texture(u_from, uv), texture(u_to, uv), smoothstep(0.0, 0.25, d));
  float e = clamp(heat * u_intensity, 0.0, 1.0);
  vec3 burn = mix(u_color.rgb, vec3(1.0, 0.96, 0.88), smoothstep(0.7, 1.0, e));
  float a = max(base.a, e);
  return vec4(min(base.rgb * (1.0 - 0.4 * e) + burn * e, vec3(a)), a);
}`,
}

export const TRANSITIONS: TransitionDefinition[] = [
  dip,
  wipe,
  iris,
  clock,
  blinds,
  lumaWipe,
  noiseDissolve,
  slide,
  push,
  whipPan,
  zoomBlur,
  spin,
  glitchCut,
  lightBurn,
]
