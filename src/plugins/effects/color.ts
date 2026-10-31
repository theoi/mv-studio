/** Color effects: color grading with LUTs, and duotone. */
import { TONE_GLSL } from '../../engine/shaders.ts'
import type { EffectDefinition } from '../../engine/types.ts'
import { COMMON } from '../glsl.ts'

/**
 * Look presets of the color grade: ASC CDL slope, offset and power, then contrast, saturation and split toning. Contrast
 * is an S-curve and out-of-range colors roll off toward their luma, so grades keep highlight and shadow detail.
 */
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

type GradeLook = (typeof GRADE_LOOKS)[number]['value']
type Vec3 = readonly [number, number, number]

interface GradePreset {
  slope: Vec3
  offset: Vec3
  power: Vec3
  saturation: number
  contrast: number
  /** Split-tone colors and strength. */
  shadow: Vec3
  highlight: Vec3
  split: number
}

const v3 = (x: number, y = x, z = x): Vec3 => [x, y, z]

const GRADE_PRESETS: Record<GradeLook, GradePreset> = {
  natural: {
    slope: v3(1),
    offset: v3(0),
    power: v3(1),
    saturation: 1,
    contrast: 1,
    shadow: v3(0.5),
    highlight: v3(0.5),
    split: 0,
  },
  'teal-orange': {
    slope: v3(1.04, 1.0, 0.94),
    offset: v3(0, 0, 0.01),
    power: v3(1),
    saturation: 1.08,
    contrast: 1.12,
    shadow: v3(0.1, 0.45, 0.55),
    highlight: v3(1.0, 0.62, 0.32),
    split: 0.6,
  },
  'warm-film': {
    slope: v3(1.06, 1.0, 0.88),
    offset: v3(0.02, 0.01, 0),
    power: v3(0.95, 1.0, 1.06),
    saturation: 0.9,
    contrast: 1.05,
    shadow: v3(0.45, 0.42, 0.5),
    highlight: v3(1.0, 0.8, 0.55),
    split: 0.35,
  },
  'cool-night': {
    slope: v3(0.88, 0.96, 1.08),
    offset: v3(0, 0.01, 0.035),
    power: v3(1.08, 1.04, 0.96),
    saturation: 0.78,
    contrast: 1.1,
    shadow: v3(0.2, 0.35, 0.6),
    highlight: v3(0.6, 0.75, 0.95),
    split: 0.45,
  },
  bleach: {
    slope: v3(1.02),
    offset: v3(0),
    power: v3(1),
    saturation: 0.45,
    contrast: 1.35,
    shadow: v3(0.5),
    highlight: v3(0.5),
    split: 0,
  },
  vintage: {
    slope: v3(1.0, 0.95, 0.85),
    offset: v3(0.07, 0.06, 0.08),
    power: v3(0.95, 1.0, 1.08),
    saturation: 0.72,
    contrast: 0.88,
    shadow: v3(0.35, 0.45, 0.55),
    highlight: v3(1.0, 0.85, 0.6),
    split: 0.4,
  },
  noir: {
    slope: v3(1),
    offset: v3(0),
    power: v3(1),
    saturation: 0,
    contrast: 1.3,
    shadow: v3(0.45, 0.48, 0.55),
    highlight: v3(0.5),
    split: 0.15,
  },
  cross: {
    slope: v3(1.08, 1.02, 0.82),
    offset: v3(-0.02, 0, 0.07),
    power: v3(1.15, 0.92, 1.25),
    saturation: 1.2,
    contrast: 1.1,
    shadow: v3(0.15, 0.3, 0.65),
    highlight: v3(0.95, 0.95, 0.45),
    split: 0.4,
  },
  neon: {
    slope: v3(1.05, 0.98, 1.08),
    offset: v3(0, -0.01, 0.02),
    power: v3(1),
    saturation: 1.45,
    contrast: 1.18,
    shadow: v3(0.3, 0.1, 0.65),
    highlight: v3(0.2, 0.95, 1.0),
    split: 0.5,
  },
  pastel: {
    slope: v3(0.98, 0.96, 1.0),
    offset: v3(0.09, 0.08, 0.1),
    power: v3(0.9),
    saturation: 0.62,
    contrast: 0.85,
    shadow: v3(0.55, 0.45, 0.65),
    highlight: v3(1.0, 0.8, 0.85),
    split: 0.35,
  },
  golden: {
    slope: v3(1.12, 1.0, 0.82),
    offset: v3(0.02, 0, -0.01),
    power: v3(0.94, 1.0, 1.1),
    saturation: 1.15,
    contrast: 1.05,
    shadow: v3(0.4, 0.35, 0.55),
    highlight: v3(1.0, 0.72, 0.38),
    split: 0.5,
  },
}

/** The preset of a `look` param value (its option value, or its index as shaders see it). */
function gradeLookAt(value: unknown): GradeLook {
  if (typeof value === 'number') return GRADE_LOOKS[Math.round(value)]?.value ?? 'natural'
  return GRADE_LOOKS.find((l) => l.value === value)?.value ?? 'natural'
}

/** Split-tone offset of a tint color: its chroma (color minus its luma), scaled by the split strength. */
function tintOffset(c: Vec3, k: number): Vec3 {
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  return [(c[0] - l) * k, (c[1] - l) * k, (c[2] - l) * k]
}

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
  frameUniforms: ({ params }) => {
    const p = GRADE_PRESETS[gradeLookAt(params.look)]
    return {
      slope: p.slope,
      offset: p.offset,
      power: p.power,
      gradeSaturation: p.saturation,
      gradeContrast: p.contrast,
      shadowTint: tintOffset(p.shadow, p.split),
      highlightTint: tintOffset(p.highlight, p.split),
    }
  },
  fragmentShader: `${COMMON}${TONE_GLSL}
uniform vec3 u_slope;
uniform vec3 u_offset;
uniform vec3 u_power;
uniform float u_gradeSaturation;
uniform float u_gradeContrast;
uniform vec3 u_shadowTint;
uniform vec3 u_highlightTint;

/**
 * Adds tint offsets s and h to the shadows and highlights. The highlight tint peaks in the bright tones and eases off
 * toward white, so whites stay clean rather than flat.
 */
vec3 splitTone(vec3 c, vec3 s, vec3 h) {
  float l = luma(c);
  float hw = smoothstep(0.35, 0.8, l) * (1.0 - 0.7 * smoothstep(0.8, 1.0, l));
  return c + s * (1.0 - smoothstep(0.0, 0.6, l)) + h * hw;
}

vec3 gradeLook(vec3 c, float knee) {
  c = contrastCurve(pow(max(c * u_slope + u_offset, 0.0), u_power), u_gradeContrast, 0.45);
  c = mix(vec3(luma(c)), c, u_gradeSaturation);
  return fitGamut(splitTone(c, u_shadowTint, u_highlightTint), knee);
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
  float knee = gamutKnee(c);
  vec3 g = mix(c, gradeLook(c, knee), u_amount);
  if (u_split > 0.0) {
    vec3 s = (u_shadows.rgb - luma(u_shadows.rgb)) * u_split;
    vec3 h = (u_highlights.rgb - luma(u_highlights.rgb)) * u_split;
    g = fitGamut(splitTone(g, s, h), knee);
  }
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
