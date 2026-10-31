/** Stylize effects: kaleidoscope, mirror, pixelate, halftone and edge glow. */
import type { EffectDefinition } from '../../engine/types.ts'
import { COMMON } from '../glsl.ts'

export const kaleidoscope: EffectDefinition = {
  kind: 'effect',
  id: 'kaleidoscope',
  name: 'Kaleidoscope',
  category: 'Stylize',
  description: 'Mirrored segments that turn with the music and zoom on the beat.',
  tags: ['reactive', 'beat', 'symmetry', 'trippy', 'psychedelic'],
  cost: 'low',
  params: [
    {
      key: 'segments',
      label: 'Segments',
      type: 'number',
      default: 6,
      min: 2,
      max: 16,
      step: 1,
      animatable: false,
      modulatable: false,
    },
    {
      key: 'speed',
      label: 'Spin',
      type: 'number',
      default: 12,
      min: -180,
      max: 180,
      step: 1,
      unit: '°/s',
      description: 'Turns faster when the music is loud.',
    },
    { key: 'zoom', label: 'Zoom', type: 'number', default: 1, min: 0.25, max: 4, step: 0.01 },
    {
      key: 'angle',
      label: 'Angle',
      type: 'number',
      default: 0,
      min: -180,
      max: 180,
      step: 1,
      unit: '°',
      advanced: true,
    },
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
  defaultModulation: { zoom: [{ source: { kind: 'beat' }, amount: 0.12, mode: 'multiply', smoothing: 0.3 }] },
  fragmentShader: `${COMMON}
vec2 mirrorRepeat(vec2 p) { return 1.0 - abs(1.0 - mod(p, 2.0)); }
vec4 mainImage(vec2 uv) {
  vec2 asp = vec2(aspectRatio(), 1.0);
  vec2 c = vec2(u_centerX, u_centerY);
  vec2 d = (uv - c) * asp;
  float r = length(d) / max(u_zoom, 0.05);
  float a = atan(d.y, d.x) + radians(u_angle) + radians(u_speed) * musicTime();
  float seg = TAU / max(floor(u_segments), 2.0);
  a = mod(a, seg);
  a = min(a, seg - a);
  vec2 p = vec2(cos(a), sin(a)) * r / asp + c;
  return texture(u_input, mirrorRepeat(p));
}`,
}

export const mirror: EffectDefinition = {
  kind: 'effect',
  id: 'mirror',
  name: 'Mirror',
  category: 'Stylize',
  description: 'Reflects one half of the picture onto the other, or all four quarters.',
  tags: ['symmetry', 'reflect', 'flip'],
  cost: 'low',
  params: [
    {
      key: 'mode',
      label: 'Mirror',
      type: 'select',
      default: 'left',
      options: [
        { value: 'left', label: 'Left onto right' },
        { value: 'right', label: 'Right onto left' },
        { value: 'top', label: 'Top onto bottom' },
        { value: 'bottom', label: 'Bottom onto top' },
        { value: 'quad', label: 'Four ways' },
      ],
    },
    {
      key: 'position',
      label: 'Axis',
      type: 'number',
      default: 0.5,
      min: 0.2,
      max: 0.8,
      step: 0.01,
      advanced: true,
    },
  ],
  fragmentShader: `
vec4 mainImage(vec2 uv) {
  int m = int(u_mode + 0.5);
  float c = u_position;
  vec2 p = uv;
  if (m == 0 || m == 4) p.x = p.x > c ? 2.0 * c - p.x : p.x;
  if (m == 1) p.x = p.x < c ? 2.0 * c - p.x : p.x;
  if (m == 2 || m == 4) p.y = p.y < 1.0 - c ? 2.0 * (1.0 - c) - p.y : p.y;
  if (m == 3) p.y = p.y > 1.0 - c ? 2.0 * (1.0 - c) - p.y : p.y;
  return texture(u_input, clamp(p, 0.0, 1.0));
}`,
}

export const pixelate: EffectDefinition = {
  kind: 'effect',
  id: 'pixelate',
  name: 'Pixelate',
  category: 'Stylize',
  description: 'Chunky pixels or round LED dots.',
  tags: ['8-bit', 'mosaic', 'retro', 'led', 'censor'],
  cost: 'low',
  params: [
    { key: 'size', label: 'Pixel size', type: 'number', default: 16, min: 2, max: 120, step: 1, unit: 'px' },
    {
      key: 'shape',
      label: 'Shape',
      type: 'select',
      default: 'square',
      options: [
        { value: 'square', label: 'Squares' },
        { value: 'dots', label: 'LED dots' },
      ],
    },
  ],
  fragmentShader: `${COMMON}
vec4 mainImage(vec2 uv) {
  float s = max(px(u_size), 1.0);
  vec2 pix = uv * u_resolution;
  vec2 center = (floor(pix / s) + 0.5) * s / u_resolution;
  vec2 q = vec2(0.25 * s) / u_resolution;
  vec4 c = 0.25 * (texture(u_input, center - q) + texture(u_input, center + q) +
                   texture(u_input, center + vec2(q.x, -q.y)) + texture(u_input, center + vec2(-q.x, q.y)));
  if (u_shape < 0.5) return c;
  float d = length(fract(pix / s) - 0.5);
  float aa = 1.0 / s;
  return c * (1.0 - smoothstep(0.4 - aa, 0.4 + aa, d));
}`,
}

export const halftone: EffectDefinition = {
  kind: 'effect',
  id: 'halftone',
  name: 'Halftone',
  category: 'Stylize',
  description: 'Printed dot screen, in color or as ink on paper.',
  tags: ['print', 'comic', 'pop art', 'dots', 'newspaper'],
  cost: 'low',
  params: [
    { key: 'size', label: 'Dot size', type: 'number', default: 10, min: 3, max: 48, step: 0.5, unit: 'px' },
    {
      key: 'style',
      label: 'Style',
      type: 'select',
      default: 'color',
      options: [
        { value: 'color', label: 'Color dots' },
        { value: 'ink', label: 'Ink on paper' },
      ],
    },
    { key: 'amount', label: 'Strength', type: 'number', default: 1, min: 0, max: 1, step: 0.01 },
    {
      key: 'angle',
      label: 'Screen angle',
      type: 'number',
      default: 45,
      min: 0,
      max: 90,
      step: 1,
      unit: '°',
      advanced: true,
    },
  ],
  fragmentShader: `${COMMON}
vec4 mainImage(vec2 uv) {
  vec4 src = texture(u_input, uv);
  float s = max(px(u_size), 2.0);
  mat2 R = rotate2d(radians(u_angle));
  vec2 p = R * (uv * u_resolution) / s;
  vec2 centerPx = transpose(R) * ((floor(p) + 0.5) * s);
  vec4 c = texture(u_input, centerPx / u_resolution);
  vec3 col = unpremultiply(c);
  float d = length(fract(p) - 0.5);
  float aa = 1.0 / s;
  vec3 dots;
  if (u_style < 0.5) {
    float r = 0.7 * sqrt(clamp(luma(col) * 1.2, 0.0, 1.0));
    dots = col * (1.0 - smoothstep(r - aa, r + aa, d));
  } else {
    float r = 0.72 * sqrt(clamp(1.0 - luma(col), 0.0, 1.0));
    dots = mix(vec3(0.96, 0.94, 0.88), vec3(0.08, 0.08, 0.11), 1.0 - smoothstep(r - aa, r + aa, d));
  }
  return vec4(mix(src.rgb, dots * c.a, u_amount), mix(src.a, c.a, u_amount));
}`,
}

export const edgeGlow: EffectDefinition = {
  kind: 'effect',
  id: 'edge-glow',
  name: 'Edge glow',
  category: 'Stylize',
  description: 'Neon outlines traced along the edges, brighter when the music is loud.',
  tags: ['reactive', 'neon', 'outline', 'tron', 'sketch'],
  cost: 'medium',
  params: [
    { key: 'color', label: 'Color', type: 'color', default: '#3df2ff' },
    { key: 'intensity', label: 'Intensity', type: 'number', default: 1.4, min: 0, max: 4, step: 0.05 },
    { key: 'background', label: 'Picture', type: 'number', default: 0.35, min: 0, max: 1, step: 0.01 },
    {
      key: 'threshold',
      label: 'Threshold',
      type: 'number',
      default: 0.15,
      min: 0,
      max: 1,
      step: 0.01,
      advanced: true,
    },
  ],
  defaultModulation: {
    intensity: [{ source: { kind: 'loudness' }, amount: 0.8, mode: 'multiply', smoothing: 0.25 }],
  },
  fragmentShader: `${COMMON}
float lumAt(vec2 uv) { return luma(texture(u_input, uv).rgb); }
float edgeAt(vec2 uv, float r) {
  vec2 o = vec2(r) / u_resolution;
  float tl = lumAt(uv + vec2(-o.x, o.y));
  float t = lumAt(uv + vec2(0.0, o.y));
  float tr = lumAt(uv + o);
  float l = lumAt(uv - vec2(o.x, 0.0));
  float rr = lumAt(uv + vec2(o.x, 0.0));
  float bl = lumAt(uv - o);
  float b = lumAt(uv - vec2(0.0, o.y));
  float br = lumAt(uv + vec2(o.x, -o.y));
  float gx = (tr + 2.0 * rr + br) - (tl + 2.0 * l + bl);
  float gy = (tl + 2.0 * t + tr) - (bl + 2.0 * b + br);
  return length(vec2(gx, gy));
}
vec4 mainImage(vec2 uv) {
  vec4 src = texture(u_input, uv);
  float e = edgeAt(uv, max(px(1.0), 1.0));
  float halo = 0.5 * edgeAt(uv, px(4.0)) + 0.3 * edgeAt(uv, px(10.0));
  float k = smoothstep(u_threshold, u_threshold + 0.25, e) + 0.8 * smoothstep(u_threshold, u_threshold + 0.6, halo);
  vec3 rgb = min(src.rgb * u_background + u_color.rgb * k * u_intensity, vec3(1.0));
  return vec4(rgb, max(src.a, max(rgb.r, max(rgb.g, rgb.b))));
}`,
}

export const STYLIZE_EFFECTS: EffectDefinition[] = [kaleidoscope, mirror, pixelate, halftone, edgeGlow]
