/** Light effects: drifting light leaks and a beat strobe. */
import type { EffectDefinition } from '../../engine/types.ts'
import { COMMON } from '../glsl.ts'

export const lightLeak: EffectDefinition = {
  kind: 'effect',
  id: 'light-leak',
  name: 'Light leak',
  category: 'Light',
  description: 'Warm light drifting in from the edges, flaring on the downbeat.',
  tags: ['reactive', 'downbeat', 'film', 'flare', 'warm', 'dreamy'],
  cost: 'low',
  params: [
    { key: 'intensity', label: 'Intensity', type: 'number', default: 0.7, min: 0, max: 2, step: 0.01 },
    { key: 'color', label: 'Color', type: 'color', default: '#ff7a3d' },
    { key: 'color2', label: 'Second color', type: 'color', default: '#ff3d7f' },
    {
      key: 'speed',
      label: 'Drift speed',
      type: 'number',
      default: 0.35,
      min: 0,
      max: 2,
      step: 0.01,
      advanced: true,
    },
  ],
  defaultModulation: {
    intensity: [{ source: { kind: 'downbeat' }, amount: 0.5, mode: 'add', smoothing: 0.4 }],
  },
  fragmentShader: `${COMMON}
vec4 mainImage(vec2 uv) {
  vec4 src = texture(u_input, uv);
  float t = u_time * u_speed;
  float a = aspectRatio();
  vec2 p = uv * vec2(a, 1.0);
  vec2 c0 = vec2(a * (0.18 + 0.15 * sin(t * 0.7)), 1.05 + 0.1 * sin(t * 0.5));
  vec2 c1 = vec2(a * (1.04 + 0.05 * sin(t * 0.6 + 1.0)), 0.45 + 0.3 * sin(t * 0.43 + 2.0));
  vec2 c2 = vec2(a * (0.5 + 0.35 * sin(t * 0.31 + 4.0)), -0.12);
  vec2 s = vec2(0.7, 1.0);
  float w0 = exp(-dot((p - c0) * s, (p - c0) * s) / 0.18) * (0.75 + 0.25 * sin(t * 1.3));
  float w1 = exp(-dot((p - c1) * s.yx, (p - c1) * s.yx) / 0.22) * (0.7 + 0.3 * sin(t * 1.1 + 2.0));
  float w2 = exp(-dot(p - c2, p - c2) / 0.12) * (0.6 + 0.4 * sin(t * 0.9 + 4.0));
  float streak = exp(-pow((uv.y - 0.72 - 0.08 * sin(t * 0.6)) * 9.0, 2.0)) * 0.18;
  vec3 leak = u_color.rgb * (w0 + streak) + u_color2.rgb * w1 + mix(u_color.rgb, u_color2.rgb, 0.5) * w2;
  leak = clamp(leak * u_intensity, 0.0, 1.0);
  return vec4(src.rgb + leak * (src.a - src.rgb), src.a);
}`,
}

export const strobe: EffectDefinition = {
  kind: 'effect',
  id: 'strobe',
  name: 'Strobe',
  category: 'Light',
  description: 'Flashes, blackouts or inverts on every beat.',
  tags: ['reactive', 'beat', 'flash', 'club', 'rave'],
  cost: 'low',
  params: [
    { key: 'amount', label: 'Amount', type: 'number', default: 0, min: 0, max: 1, step: 0.01 },
    {
      key: 'mode',
      label: 'Style',
      type: 'select',
      default: 'flash',
      options: [
        { value: 'flash', label: 'Flash' },
        { value: 'blackout', label: 'Blackout' },
        { value: 'invert', label: 'Invert' },
      ],
    },
    { key: 'color', label: 'Flash color', type: 'color', default: '#ffffff', advanced: true },
  ],
  defaultModulation: { amount: [{ source: { kind: 'beat' }, amount: 0.85, mode: 'add', smoothing: 0 }] },
  fragmentShader: `
vec4 mainImage(vec2 uv) {
  vec4 c = texture(u_input, uv);
  float k = clamp(u_amount, 0.0, 1.0);
  if (u_mode < 0.5) return vec4(mix(c.rgb, u_color.rgb * c.a, k), c.a);
  if (u_mode < 1.5) return vec4(c.rgb * (1.0 - k), c.a);
  return vec4(mix(c.rgb, c.a - c.rgb, k), c.a);
}`,
}

export const LIGHT_EFFECTS: EffectDefinition[] = [lightLeak, strobe]
