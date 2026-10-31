/** Distortion effects: lens chromatic aberration, digital glitch and flowing displacement. */
import type { EffectDefinition } from '../../engine/types.ts'
import { COMMON, HASH, NOISE } from '../glsl.ts'

export const chromaticAberration: EffectDefinition = {
  kind: 'effect',
  id: 'chromatic-aberration',
  name: 'Chromatic aberration',
  category: 'Distort',
  description: 'Lens-style color fringes that grow toward the edges and kick on the beat.',
  tags: ['reactive', 'beat', 'lens', 'fringe', 'rgb'],
  cost: 'low',
  params: [
    { key: 'amount', label: 'Amount', type: 'number', default: 6, min: 0, max: 60, step: 0.5, unit: 'px' },
    {
      key: 'falloff',
      label: 'Edge falloff',
      type: 'number',
      default: 0.5,
      min: 0,
      max: 1,
      step: 0.01,
      advanced: true,
    },
  ],
  defaultModulation: { amount: [{ source: { kind: 'beat' }, amount: 14, mode: 'add', smoothing: 0.2 }] },
  fragmentShader: `${COMMON}
vec4 mainImage(vec2 uv) {
  vec2 asp = vec2(aspectRatio(), 1.0);
  vec2 d = (uv - 0.5) * asp;
  float len = length(d);
  float r = len / length(0.5 * asp);
  float k = pow(r, mix(0.6, 2.5, u_falloff));
  vec2 offset = (d / max(len, 1e-4)) * px(u_amount) * k / u_resolution;
  vec3 sum = vec3(0.0);
  vec3 weights = vec3(0.0);
  float alpha = 0.0;
  const int N = 7;
  for (int i = 0; i < N; i++) {
    float t = float(i) / float(N - 1);
    vec3 w = clamp(vec3(1.0 - 2.0 * t, 1.0 - abs(2.0 * t - 1.0), 2.0 * t - 1.0), 0.0, 1.0);
    vec4 s = texture(u_input, uv + offset * (1.0 - 2.0 * t));
    sum += s.rgb * w;
    weights += w;
    alpha += s.a;
  }
  vec3 rgb = sum / weights;
  return vec4(rgb, max(alpha / float(N), max(rgb.r, max(rgb.g, rgb.b))));
}`,
}

export const glitch: EffectDefinition = {
  kind: 'effect',
  id: 'glitch',
  name: 'Glitch',
  category: 'Distort',
  description: 'Digital tearing, displaced blocks and split channels that burst on hits.',
  tags: ['reactive', 'onset', 'digital', 'datamosh', 'corrupt', 'rgb'],
  cost: 'low',
  params: [
    { key: 'amount', label: 'Amount', type: 'number', default: 0.2, min: 0, max: 1, step: 0.01 },
    {
      key: 'blockSize',
      label: 'Block size',
      type: 'number',
      default: 64,
      min: 8,
      max: 240,
      step: 1,
      unit: 'px',
    },
    {
      key: 'speed',
      label: 'Changes per second',
      type: 'number',
      default: 12,
      min: 1,
      max: 30,
      step: 1,
      advanced: true,
    },
    {
      key: 'split',
      label: 'Channel split',
      type: 'number',
      default: 14,
      min: 0,
      max: 60,
      step: 0.5,
      unit: 'px',
      advanced: true,
    },
  ],
  defaultModulation: { amount: [{ source: { kind: 'onset' }, amount: 0.6, mode: 'add', smoothing: 0.1 }] },
  fragmentShader: `${COMMON}${HASH}
vec4 mainImage(vec2 uv) {
  float amt = clamp(u_amount, 0.0, 1.0);
  if (amt < 0.002) return texture(u_input, uv);
  float tick = floor(u_time * u_speed);
  float rows = mix(6.0, 26.0, hash11(tick * 1.7 + 0.3));
  float band = floor(uv.y * rows);
  float hb = hash12(vec2(band, tick));
  float bandOn = step(1.0 - amt * 0.45, hb);
  vec2 p = uv;
  p.x += bandOn * (hash12(vec2(band, tick + 7.0)) - 0.5) * 0.22 * amt;
  vec2 block = pxUv(vec2(u_blockSize));
  vec2 cell = floor(uv / block);
  float hc = hash13(vec3(cell, tick));
  float blockOn = step(1.0 - amt * amt * 0.2, hc);
  p += blockOn * (hash22(cell + tick * 1.31) - 0.5) * block * 3.0;
  float split = px(u_split) / u_resolution.x * (0.3 + bandOn + blockOn) * amt;
  vec4 r = texture(u_input, p + vec2(split, 0.0));
  vec4 g = texture(u_input, p);
  vec4 b = texture(u_input, p - vec2(split, 0.0));
  vec4 c = vec4(r.r, g.g, b.b, max(g.a, max(r.a, b.a)));
  if (blockOn > 0.5 && hash12(cell + tick * 3.1) > 0.6) c.rgb = c.gbr;
  float line = floor(uv.y * u_resolution.y / max(px(2.0), 1.0));
  c.rgb *= 1.0 - 0.18 * amt * step(0.93, hash12(vec2(line, tick)));
  return c;
}`,
}

export const displace: EffectDefinition = {
  kind: 'effect',
  id: 'displace',
  name: 'Displace',
  category: 'Distort',
  description: 'Liquid warping that flows faster and deeper with the music.',
  tags: ['reactive', 'warp', 'liquid', 'wave', 'ripple', 'heat'],
  cost: 'medium',
  params: [
    { key: 'amount', label: 'Amount', type: 'number', default: 22, min: 0, max: 160, step: 0.5, unit: 'px' },
    {
      key: 'mode',
      label: 'Style',
      type: 'select',
      default: 'flow',
      options: [
        { value: 'flow', label: 'Flow' },
        { value: 'waves', label: 'Waves' },
        { value: 'ripple', label: 'Ripple' },
      ],
    },
    { key: 'scale', label: 'Scale', type: 'number', default: 2.5, min: 0.5, max: 10, step: 0.1 },
    {
      key: 'speed',
      label: 'Speed',
      type: 'number',
      default: 0.5,
      min: 0,
      max: 3,
      step: 0.05,
      advanced: true,
    },
  ],
  defaultModulation: { amount: [{ source: { kind: 'loudness' }, amount: 30, mode: 'add', smoothing: 0.3 }] },
  fragmentShader: `${COMMON}${HASH}${NOISE}
vec4 mainImage(vec2 uv) {
  vec2 asp = vec2(aspectRatio(), 1.0);
  vec2 q = uv * asp * u_scale;
  float t = musicTime() * u_speed;
  vec2 off;
  if (u_mode < 0.5) {
    off = vec2(fbm(q + vec2(0.0, t)), fbm(q + vec2(5.2, 1.3 - t))) - 0.5;
  } else if (u_mode < 1.5) {
    off = 0.5 * vec2(sin(q.y * 4.0 + t * 4.0), cos(q.x * 3.0 + t * 3.0));
  } else {
    vec2 d = (uv - 0.5) * asp;
    float r = length(d);
    off = d / max(r, 1e-3) * 0.5 * sin(r * 16.0 * u_scale - t * 8.0) * exp(-r * 1.5);
  }
  return texture(u_input, uv + off * 2.0 * px(u_amount) / u_resolution);
}`,
}

export const DISTORT_EFFECTS: EffectDefinition[] = [chromaticAberration, glitch, displace]
