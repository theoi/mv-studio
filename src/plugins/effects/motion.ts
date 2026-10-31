/** Motion effects: camera shake and zoom pulse, both kicked by the beat. */
import type { EffectDefinition } from '../../engine/types.ts'
import { COMMON, HASH, NOISE } from '../glsl.ts'

export const shake: EffectDefinition = {
  kind: 'effect',
  id: 'shake',
  name: 'Shake',
  category: 'Motion',
  description: 'Handheld camera shake that hits harder on the beat.',
  tags: ['reactive', 'beat', 'kick', 'camera', 'handheld', 'impact'],
  cost: 'low',
  params: [
    { key: 'amount', label: 'Amount', type: 'number', default: 6, min: 0, max: 120, step: 0.5, unit: 'px' },
    {
      key: 'rotation',
      label: 'Rotation',
      type: 'number',
      default: 0.5,
      min: 0,
      max: 10,
      step: 0.05,
      unit: '°',
    },
    {
      key: 'speed',
      label: 'Speed',
      type: 'number',
      default: 9,
      min: 1,
      max: 30,
      step: 0.5,
      unit: 'Hz',
      advanced: true,
    },
    {
      key: 'cover',
      label: 'Zoom to hide edges',
      type: 'boolean',
      default: true,
      advanced: true,
    },
  ],
  defaultModulation: {
    amount: [{ source: { kind: 'beat' }, amount: 26, mode: 'add', smoothing: 0.15 }],
    rotation: [{ source: { kind: 'beat' }, amount: 1.2, mode: 'add', smoothing: 0.15 }],
  },
  fragmentShader: `${COMMON}${HASH}${NOISE}
vec4 mainImage(vec2 uv) {
  float t = u_time * u_speed;
  vec2 n = vec2(vnoise1(t), vnoise1(t + 31.7)) * 2.0 - 1.0;
  n += 0.5 * (vec2(vnoise1(t * 2.3 + 5.0), vnoise1(t * 2.3 + 77.0)) * 2.0 - 1.0);
  vec2 off = n / 1.5 * px(u_amount) / u_resolution;
  float rot = (vnoise1(t * 0.8 + 13.0) * 2.0 - 1.0) * radians(u_rotation);
  float a = aspectRatio();
  float zoom = u_cover > 0.5 ? 1.0 + 2.0 * u_amount / 1080.0 + abs(rot) * max(a, 1.0 / a) : 1.0;
  vec2 asp = vec2(a, 1.0);
  vec2 p = rotate2d(rot) * ((uv - 0.5) * asp) / zoom / asp + 0.5 + off;
  return texture(u_input, p) * insideUv(p);
}`,
}

export const zoomPulse: EffectDefinition = {
  kind: 'effect',
  id: 'zoom-pulse',
  name: 'Zoom pulse',
  category: 'Motion',
  description: 'Punches in on every beat with a touch of radial blur.',
  tags: ['reactive', 'beat', 'kick', 'bounce', 'punch'],
  cost: 'low',
  params: [
    { key: 'zoom', label: 'Zoom', type: 'number', default: 0, min: 0, max: 0.5, step: 0.005 },
    { key: 'blur', label: 'Blur', type: 'number', default: 0.5, min: 0, max: 1, step: 0.01 },
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
  defaultModulation: { zoom: [{ source: { kind: 'beat' }, amount: 0.07, mode: 'add', smoothing: 0.25 }] },
  fragmentShader: `
vec4 mainImage(vec2 uv) {
  float z = max(u_zoom, 0.0);
  vec2 c = vec2(u_centerX, u_centerY);
  if (z < 1e-4) return texture(u_input, uv);
  vec4 sum = vec4(0.0);
  const int N = 8;
  for (int i = 0; i < N; i++) {
    float f = float(i) / float(N - 1);
    sum += texture(u_input, c + (uv - c) / (1.0 + z * (1.0 - 0.6 * u_blur * f)));
  }
  return sum / float(N);
}`,
}

export const MOTION_EFFECTS: EffectDefinition[] = [shake, zoomPulse]
