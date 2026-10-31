/** Built-in generators (music visualizers). uv has a bottom-left origin; output is premultiplied. */
import type { GeneratorDefinition } from '../types.ts'

/** Band value across the spectrum (x in 0..1), interpolated; falls back to loudness without band data. */
const BAND_AT = `
float bandAt(float x) {
  if (u_bandCount < 1.0) return u_loudness;
  float f = clamp(x, 0.0, 1.0) * (u_bandCount - 1.0);
  int i = min(int(floor(f)), 15);
  int j = min(i + 1, min(int(u_bandCount) - 1, 15));
  return mix(u_bands[i], u_bands[j], fract(f));
}`

export const spectrum: GeneratorDefinition = {
  kind: 'generator',
  id: 'visualizer.spectrum',
  name: 'Spectrum bars',
  category: 'Visualizer',
  description: 'Frequency bars that move with the music.',
  params: [
    { key: 'color', label: 'Color', type: 'color', default: '#ffffff' },
    { key: 'color2', label: 'Top color', type: 'color', default: '#ff4fa3' },
    {
      key: 'bars',
      label: 'Bars',
      type: 'number',
      default: 32,
      min: 4,
      max: 96,
      step: 1,
      animatable: false,
      modulatable: false,
    },
    { key: 'height', label: 'Height', type: 'number', default: 0.6, min: 0.05, max: 1, step: 0.01 },
    { key: 'gap', label: 'Gap', type: 'number', default: 0.3, min: 0, max: 0.9, step: 0.01, advanced: true },
    { key: 'mirror', label: 'Mirror', type: 'boolean', default: false },
    {
      key: 'baseline',
      label: 'Baseline',
      type: 'select',
      default: 'bottom',
      options: [
        { value: 'bottom', label: 'Bottom' },
        { value: 'center', label: 'Center' },
      ],
    },
  ],
  fragmentShader: `${BAND_AT}
vec4 mainImage(vec2 uv) {
  float bars = max(floor(u_bars), 1.0);
  float x = u_mirror > 0.5 ? abs(uv.x - 0.5) * 2.0 : uv.x;
  float idx = floor(x * bars);
  float local = fract(x * bars);
  float g = u_gap * 0.5;
  if (local < g || local > 1.0 - g) return vec4(0.0);
  float h = max(clamp(bandAt((idx + 0.5) / bars), 0.0, 1.0) * u_height, 0.006);
  float y = u_baseline > 0.5 ? abs(uv.y - 0.5) * 2.0 : uv.y;
  float px = 1.5 / u_resolution.y;
  float a = 1.0 - smoothstep(h - px, h, y);
  if (a <= 0.0) return vec4(0.0);
  vec4 c = mix(u_color, u_color2, clamp(y / u_height, 0.0, 1.0));
  float alpha = c.a * a;
  return vec4(c.rgb * alpha, alpha);
}`,
}

export const waveform: GeneratorDefinition = {
  kind: 'generator',
  id: 'visualizer.waveform',
  name: 'Waveform line',
  category: 'Visualizer',
  description: 'A flowing line shaped by the music.',
  params: [
    { key: 'color', label: 'Color', type: 'color', default: '#ffffff' },
    {
      key: 'thickness',
      label: 'Thickness',
      type: 'number',
      default: 5,
      min: 1,
      max: 30,
      step: 0.5,
      unit: 'px',
    },
    { key: 'amplitude', label: 'Amplitude', type: 'number', default: 0.3, min: 0, max: 1, step: 0.01 },
    { key: 'speed', label: 'Speed', type: 'number', default: 1, min: 0, max: 4, step: 0.05, advanced: true },
  ],
  fragmentShader: `
float wave(float x) {
  float n = max(u_bandCount, 1.0);
  float y = 0.0;
  for (int i = 0; i < 16; i++) {
    float fi = float(i);
    if (fi >= n) break;
    float amp = u_bandCount < 1.0 ? u_loudness : u_bands[i];
    float freq = 1.5 + fi * 1.7;
    y += amp * sin(x * 6.2831853 * freq + u_time * u_speed * (2.0 + fi * 0.9) + fi * 1.3) / (1.0 + fi * 0.35);
  }
  return y / sqrt(n) * sin(3.14159265 * clamp(x, 0.0, 1.0));
}
vec4 mainImage(vec2 uv) {
  float H = u_resolution.y;
  float amp = u_amplitude * (0.5 + u_loudness) * H;
  float dx = 1.0 / u_resolution.x;
  float yPx = (0.5 * H) + wave(uv.x) * amp;
  float slope = (wave(uv.x + dx) - wave(uv.x - dx)) * amp / 2.0;
  float dist = abs(uv.y * H - yPx) / sqrt(1.0 + slope * slope);
  float halfWidth = u_thickness * H / 1080.0 * 0.5;
  float a = (1.0 - smoothstep(halfWidth - 0.75, halfWidth + 0.75, dist)) * u_color.a;
  return vec4(u_color.rgb * a, a);
}`,
}

export const particles: GeneratorDefinition = {
  kind: 'generator',
  id: 'visualizer.particles',
  name: 'Particles',
  category: 'Visualizer',
  description: 'Rising particles that swell on beats.',
  params: [
    { key: 'color', label: 'Color', type: 'color', default: '#ffffff' },
    { key: 'density', label: 'Density', type: 'number', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'size', label: 'Size', type: 'number', default: 6, min: 1, max: 40, step: 0.5, unit: 'px' },
    { key: 'speed', label: 'Speed', type: 'number', default: 0.3, min: 0, max: 2, step: 0.01 },
    { key: 'reactivity', label: 'Reactivity', type: 'number', default: 1, min: 0, max: 3, step: 0.05 },
  ],
  fragmentShader: `
vec2 hash2(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xx + q.yz) * q.zy);
}
vec4 mainImage(vec2 uv) {
  float aspect = u_resolution.x / u_resolution.y;
  float pulse = 1.0 + u_reactivity * (0.7 * u_beat + 0.8 * u_loudness);
  float acc = 0.0;
  for (int layer = 0; layer < 3; layer++) {
    float fl = float(layer);
    float cells = mix(3.0, 18.0, u_density) * (1.0 + fl * 0.7);
    vec2 p = vec2(uv.x * aspect, uv.y) * cells;
    p.y -= u_time * u_speed * (0.6 + 0.4 * fl) * cells * 0.25;
    vec2 cell = floor(p);
    vec2 f = fract(p);
    vec2 h = hash2(cell + vec2(fl * 37.0, fl * 11.0));
    if (h.y < 0.3) continue;
    float r = clamp(u_size * cells / 1080.0 * pulse * (0.5 + 0.7 * h.x), 0.01, 0.45);
    vec2 center = r + h * (1.0 - 2.0 * r);
    center.x = clamp(center.x + sin(u_time * (0.4 + h.y) + h.x * 6.2831853) * 0.08, r, 1.0 - r);
    float d = length(f - center);
    acc += (1.0 - smoothstep(r * 0.35, r, d)) * (0.45 + 0.55 * h.x) / (1.0 + fl * 0.35);
  }
  float a = clamp(acc, 0.0, 1.0) * u_color.a;
  return vec4(u_color.rgb * a, a);
}`,
}

export const BUILTIN_GENERATORS: GeneratorDefinition[] = [spectrum, waveform, particles]
