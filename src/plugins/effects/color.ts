/** Color effects: color grading with LUTs, and duotone. */
import type { EffectDefinition } from '../../engine/types.ts'
import { COMMON } from '../glsl.ts'

/** Look presets of the color grade: ASC CDL slope, offset and power, then saturation, contrast and split toning. */
export const GRADE_LOOKS = [
  { value: 'natural', label: 'Natural' },
  { value: 'teal-orange', label: 'Teal and orange' },
  { value: 'warm-film', label: 'Warm film' },
  { value: 'cool-night', label: 'Cool night' },
  { value: 'bleach', label: 'Bleach bypass' },
  { value: 'vintage', label: 'Vintage fade' },
  { value: 'noir', label: 'Noir' },
  { value: 'cross', label: 'Cross process' },
  { value: 'neon', label: 'Neon pop' },
  { value: 'pastel', label: 'Pastel' },
  { value: 'golden', label: 'Golden hour' },
] as const

export const colorGrade: EffectDefinition = {
  kind: 'effect',
  id: 'color-grade',
  name: 'Color grade',
  category: 'Color',
  description: 'Film-style looks, split toning and LUTs.',
  tags: ['grade', 'lut', 'look', 'film', 'cinematic', 'teal', 'orange'],
  cost: 'low',
  params: [
    {
      key: 'look',
      label: 'Look',
      type: 'select',
      default: 'teal-orange',
      options: GRADE_LOOKS.map((l) => ({ ...l })),
    },
    { key: 'amount', label: 'Strength', type: 'number', default: 0.8, min: 0, max: 1, step: 0.01 },
    { key: 'fade', label: 'Fade', type: 'number', default: 0, min: 0, max: 1, step: 0.01 },
    { key: 'lut', label: 'LUT', type: 'image', default: '', role: 'lut' },
    {
      key: 'lutAmount',
      label: 'LUT strength',
      type: 'number',
      default: 1,
      min: 0,
      max: 1,
      step: 0.01,
      advanced: true,
    },
    { key: 'shadows', label: 'Shadow tint', type: 'color', default: '#1f6f8b', advanced: true },
    { key: 'highlights', label: 'Highlight tint', type: 'color', default: '#ffa860', advanced: true },
    {
      key: 'split',
      label: 'Split toning',
      type: 'number',
      default: 0,
      min: 0,
      max: 1,
      step: 0.01,
      advanced: true,
    },
  ],
  fragmentShader: `${COMMON}
const vec3 SLOPE[11] = vec3[11](
  vec3(1.0), vec3(1.04, 1.0, 0.94), vec3(1.06, 1.0, 0.88), vec3(0.88, 0.96, 1.08), vec3(1.02),
  vec3(1.0, 0.95, 0.85), vec3(1.0), vec3(1.08, 1.02, 0.82), vec3(1.05, 0.98, 1.08), vec3(0.98, 0.96, 1.0),
  vec3(1.12, 1.0, 0.82));
const vec3 OFFSET[11] = vec3[11](
  vec3(0.0), vec3(0.0, 0.0, 0.01), vec3(0.02, 0.01, 0.0), vec3(0.0, 0.01, 0.035), vec3(0.0),
  vec3(0.07, 0.06, 0.08), vec3(0.0), vec3(-0.02, 0.0, 0.07), vec3(0.0, -0.01, 0.02), vec3(0.09, 0.08, 0.1),
  vec3(0.02, 0.0, -0.01));
const vec3 POWER[11] = vec3[11](
  vec3(1.0), vec3(1.0), vec3(0.95, 1.0, 1.06), vec3(1.08, 1.04, 0.96), vec3(1.0),
  vec3(0.95, 1.0, 1.08), vec3(1.0), vec3(1.15, 0.92, 1.25), vec3(1.0), vec3(0.9), vec3(0.94, 1.0, 1.1));
const float SAT[11] = float[11](1.0, 1.08, 0.9, 0.78, 0.45, 0.72, 0.0, 1.2, 1.45, 0.62, 1.15);
const float CONTRAST[11] = float[11](1.0, 1.12, 1.05, 1.1, 1.35, 0.88, 1.3, 1.1, 1.18, 0.85, 1.05);
const vec3 SHADOW[11] = vec3[11](
  vec3(0.5), vec3(0.1, 0.45, 0.55), vec3(0.45, 0.42, 0.5), vec3(0.2, 0.35, 0.6), vec3(0.5),
  vec3(0.35, 0.45, 0.55), vec3(0.45, 0.48, 0.55), vec3(0.15, 0.3, 0.65), vec3(0.3, 0.1, 0.65),
  vec3(0.55, 0.45, 0.65), vec3(0.4, 0.35, 0.55));
const vec3 HIGHLIGHT[11] = vec3[11](
  vec3(0.5), vec3(1.0, 0.62, 0.32), vec3(1.0, 0.8, 0.55), vec3(0.6, 0.75, 0.95), vec3(0.5),
  vec3(1.0, 0.85, 0.6), vec3(0.5), vec3(0.95, 0.95, 0.45), vec3(0.2, 0.95, 1.0), vec3(1.0, 0.8, 0.85),
  vec3(1.0, 0.72, 0.38));
const float SPLIT[11] = float[11](0.0, 0.6, 0.35, 0.45, 0.0, 0.4, 0.15, 0.4, 0.5, 0.35, 0.5);

vec3 splitTone(vec3 c, vec3 shadowTint, vec3 highlightTint, float k) {
  float l = luma(c);
  vec3 s = shadowTint - luma(shadowTint);
  vec3 h = highlightTint - luma(highlightTint);
  return c + (s * (1.0 - smoothstep(0.0, 0.6, l)) + h * smoothstep(0.35, 1.0, l)) * k;
}

vec3 gradeLook(vec3 c, int i) {
  c = pow(max(c * SLOPE[i] + OFFSET[i], 0.0), POWER[i]);
  c = (c - 0.45) * CONTRAST[i] + 0.45;
  c = mix(vec3(luma(c)), c, SAT[i]);
  return clamp(splitTone(c, SHADOW[i], HIGHLIGHT[i], SPLIT[i]), 0.0, 1.0);
}

/** Strip LUT (size n: n*n x n, x = r + n * b, y = g), trilinear: bilinear within a blue slice, then across slices. */
vec3 applyLut(vec3 c, float n) {
  vec3 s = clamp(c, 0.0, 1.0) * (n - 1.0);
  float b0 = floor(s.b);
  float b1 = min(b0 + 1.0, n - 1.0);
  float v = (s.g + 0.5) / n;
  vec3 c0 = texture(u_lut, vec2((s.r + 0.5 + b0 * n) / (n * n), v)).rgb;
  vec3 c1 = texture(u_lut, vec2((s.r + 0.5 + b1 * n) / (n * n), v)).rgb;
  return mix(c0, c1, s.b - b0);
}

vec4 mainImage(vec2 uv) {
  vec4 src = texture(u_input, uv);
  if (src.a <= 0.0) return src;
  vec3 c = src.rgb / src.a;
  vec3 g = mix(c, gradeLook(c, int(u_look + 0.5)), u_amount);
  g = splitTone(g, u_shadows.rgb, u_highlights.rgb, u_split);
  g = g * (1.0 - 0.18 * u_fade) + vec3(0.1, 0.09, 0.11) * u_fade;
  float n = u_lutSize.y;
  if (n >= 2.0 && abs(u_lutSize.x - n * n) < 0.5) g = mix(g, applyLut(g, n), u_lutAmount);
  return vec4(clamp(g, 0.0, 1.0) * src.a, src.a);
}`,
}

export const duotone: EffectDefinition = {
  kind: 'effect',
  id: 'duotone',
  name: 'Duotone',
  category: 'Color',
  description: 'Maps the picture onto two colors, poster style.',
  tags: ['two tone', 'poster', 'gradient map', 'color'],
  cost: 'low',
  params: [
    { key: 'shadows', label: 'Shadows', type: 'color', default: '#1b1464' },
    { key: 'highlights', label: 'Highlights', type: 'color', default: '#ff5e8a' },
    { key: 'amount', label: 'Strength', type: 'number', default: 1, min: 0, max: 1, step: 0.01 },
    {
      key: 'contrast',
      label: 'Contrast',
      type: 'number',
      default: 0.2,
      min: -1,
      max: 1,
      step: 0.01,
      advanced: true,
    },
  ],
  fragmentShader: `${COMMON}
vec4 mainImage(vec2 uv) {
  vec4 src = texture(u_input, uv);
  if (src.a <= 0.0) return src;
  vec3 c = src.rgb / src.a;
  float l = clamp((luma(c) - 0.5) * (1.0 + u_contrast) + 0.5, 0.0, 1.0);
  vec3 tone = mix(u_shadows.rgb, u_highlights.rgb, smoothstep(0.0, 1.0, l));
  return vec4(mix(c, tone, u_amount) * src.a, src.a);
}`,
}

export const invert: EffectDefinition = {
  kind: 'effect',
  id: 'invert',
  name: 'Invert',
  category: 'Color',
  description: 'Turns the picture into its negative.',
  tags: ['negative', 'flip', 'vj'],
  cost: 'low',
  params: [{ key: 'amount', label: 'Amount', type: 'number', default: 1, min: 0, max: 1, step: 0.01 }],
  fragmentShader: `
vec4 mainImage(vec2 uv) {
  vec4 c = texture(u_input, uv);
  return vec4(mix(c.rgb, c.a - c.rgb, u_amount), c.a);
}`,
}

export const COLOR_EFFECTS: EffectDefinition[] = [colorGrade, duotone, invert]
