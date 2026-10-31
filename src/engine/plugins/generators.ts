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

/**
 * Display levels for visualizers, given a \`bandAt(x)\`. Loudness and bands put each song's loud level at 0.9, with
 * louder moments compressed above it and quiet passages well below.
 */
export const DISPLAY_LEVELS = `
/** A level with the song's loud level at 1, expanded so quiet passages stay small and loud ones reach the top. */
float expandLevel(float v) {
  float x = clamp(v / 0.9, 0.0, 1.12);
  return x * sqrt(x);
}
float loudLevel() { return expandLevel(u_loudness); }
float barHash(float n) {
  n = fract(n * 0.1031);
  n *= n + 33.33;
  return fract(n * (n + n));
}
/**
 * Height (0..1) of spectrum bar \`bar\` at x (0 lows .. 1 highs). Each band is normalized to its own loud level, so on
 * loud passages the raw bands sit side by side near the top like a wall. Bars instead show how far their band stands
 * out from the frame's average over a level that follows loudness, fall off gently toward the highs as real spectra
 * do, and each moves a little on its own at a pace that follows the music: loud passages stay tall without pinning.
 */
float spectrumLevel(float x, float bar) {
  float b = bandAt(x);
  float m = u_loudness;
  if (u_bandCount >= 1.0) {
    m = 0.0;
    for (int i = 0; i < 16; i++) {
      if (float(i) >= u_bandCount) break;
      m += u_bands[i];
    }
    m /= u_bandCount;
  }
  float shape = clamp(0.35 * loudLevel() + 0.65 * b + 1.2 * (b - m), 0.0, 1.2);
  float life = 0.84 + 0.16 * sin(u_flow * (4.0 + 3.0 * barHash(bar)) + 6.2831853 * barHash(bar + 17.0));
  float v = 1.2 * shape * life * (1.0 - 0.15 * x);
  // Soft top: the tallest bars approach full height on peaks instead of sitting there.
  return v < 0.8 ? max(v, 0.0) : 0.8 + 0.2 * (1.0 - exp(-(v - 0.8) / 0.2));
}`

export const spectrum: GeneratorDefinition = {
  kind: 'generator',
  id: 'visualizer.spectrum',
  name: 'Spectrum bars',
  category: 'Visualizer',
  description: 'Frequency bars that move with the music.',
  tags: ['reactive', 'spectrum', 'bars', 'equalizer', 'electronic'],
  cost: 'low',
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
    {
      key: 'style',
      label: 'Style',
      type: 'select',
      default: 'rounded',
      options: [
        { value: 'bars', label: 'Bars' },
        { value: 'rounded', label: 'Rounded' },
        { value: 'blocks', label: 'LED blocks' },
      ],
    },
    { key: 'glow', label: 'Glow', type: 'number', default: 0.3, min: 0, max: 1, step: 0.01 },
  ],
  fragmentShader: `${BAND_AT}${DISPLAY_LEVELS}
vec4 mainImage(vec2 uv) {
  float bars = max(floor(u_bars), 1.0);
  bool mirrored = u_mirror > 0.5;
  bool centered = u_baseline > 0.5;
  float x = mirrored ? abs(uv.x - 0.5) * 2.0 : uv.x;
  float idx = floor(x * bars);
  float h = max(spectrumLevel((idx + 0.5) / bars, idx) * u_height, 0.006);
  // Bar geometry in canvas pixels, relative to the bar's cell.
  float cellW = u_resolution.x / bars * (mirrored ? 0.5 : 1.0);
  float halfW = max(0.5 * cellW * (1.0 - u_gap), 0.5);
  float xPx = abs(fract(x * bars) - 0.5) * cellW;
  float yScale = centered ? 0.5 * u_resolution.y : u_resolution.y;
  float y = centered ? abs(uv.y - 0.5) * 2.0 : uv.y;
  float yPx = y * yScale;
  float hPx = h * yScale;
  int style = int(u_style + 0.5);
  float d = style == 1
    ? length(vec2(xPx, max(yPx - max(hPx - halfW, 0.0), 0.0))) - halfW
    : max(xPx - halfW, yPx - hPx);
  float cover = 1.0 - smoothstep(-0.75, 0.75, d);
  if (style == 2) {
    float seg = max(14.0 * u_resolution.y / 1080.0, 3.0);
    float gapPx = max(0.3 * seg, 1.0);
    cover *= 1.0 - smoothstep(seg - gapPx - 0.75, seg - gapPx + 0.75, mod(yPx, seg));
  }
  float glow = u_glow * 0.45 * exp(-max(d, 0.0) / (22.0 * u_resolution.y / 1080.0)) * (1.0 - cover);
  vec4 c = mix(u_color, u_color2, clamp(y / u_height, 0.0, 1.0));
  float alpha = clamp(c.a * cover + glow * c.a, 0.0, 1.0);
  return vec4(c.rgb * alpha, alpha);
}`,
}

export const waveform: GeneratorDefinition = {
  kind: 'generator',
  id: 'visualizer.waveform',
  name: 'Waveform line',
  category: 'Visualizer',
  description: 'A flowing line shaped by the music.',
  tags: ['reactive', 'waveform', 'line', 'oscilloscope', 'calm', 'minimal'],
  cost: 'low',
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
    { key: 'color2', label: 'Peak color', type: 'color', default: '#ff4fa3' },
    { key: 'glow', label: 'Glow', type: 'number', default: 0.4, min: 0, max: 1, step: 0.01 },
    {
      key: 'lines',
      label: 'Lines',
      type: 'number',
      default: 1,
      min: 1,
      max: 3,
      step: 1,
      animatable: false,
      modulatable: false,
    },
  ],
  fragmentShader: `${BAND_AT}${DISPLAY_LEVELS}
/** The wave at x (0..1) and its slope, summed in one pass over the bands. */
vec2 wave(float x, float phase) {
  float n = max(u_bandCount, 1.0);
  float s = 0.0;
  float ds = 0.0;
  for (int i = 0; i < 16; i++) {
    float fi = float(i);
    if (fi >= n) break;
    float amp = expandLevel(u_bandCount < 1.0 ? u_loudness : u_bands[i]) / (1.0 + fi * 0.35);
    float w = 6.2831853 * (1.5 + fi * 1.7);
    float arg = x * w + u_time * u_speed * (2.0 + fi * 0.9) + fi * 1.3 + phase;
    s += amp * sin(arg);
    ds += amp * w * cos(arg);
  }
  float env = sin(3.14159265 * clamp(x, 0.0, 1.0));
  float denv = 3.14159265 * cos(3.14159265 * clamp(x, 0.0, 1.0));
  return vec2(s * env, ds * env + s * denv) / sqrt(n);
}
vec4 mainImage(vec2 uv) {
  float H = u_resolution.y;
  float scale = H / 1080.0;
  float amp = u_amplitude * (0.4 + 1.15 * loudLevel()) * H;
  float halfWidth = u_thickness * scale * 0.5;
  float lines = floor(u_lines);
  vec3 rgb = vec3(0.0);
  float alpha = 0.0;
  for (int j = 0; j < 3; j++) {
    float fj = float(j);
    if (fj >= lines) break;
    float k = 1.0 - 0.28 * fj;
    vec2 w = wave(uv.x, fj * 2.1) * amp * k;
    float slope = w.y / u_resolution.x;
    float offset = uv.y * H - 0.5 * H - w.x;
    float dist = abs(offset) / sqrt(1.0 + slope * slope);
    float core = 1.0 - smoothstep(halfWidth * k - 0.75, halfWidth * k + 0.75, dist);
    float glow = u_glow * 0.5 * exp(-max(dist - halfWidth, 0.0) / (16.0 * scale)) * (1.0 - core);
    vec4 c = mix(u_color, u_color2, clamp(abs(w.x) / max(0.6 * amp, 1.0), 0.0, 1.0) * 0.85 + 0.15 * fj);
    float a = (core + glow) * c.a * (1.0 - 0.25 * fj);
    rgb += c.rgb * a * (1.0 - alpha);
    alpha += a * (1.0 - alpha);
  }
  return vec4(rgb, clamp(alpha, 0.0, 1.0));
}`,
}

export const particles: GeneratorDefinition = {
  kind: 'generator',
  id: 'visualizer.particles',
  name: 'Particles',
  category: 'Visualizer',
  description: 'Rising particles that swell on beats.',
  tags: ['reactive', 'particles', 'bokeh', 'dust', 'dreamy', 'beat'],
  cost: 'low',
  params: [
    { key: 'color', label: 'Color', type: 'color', default: '#ffffff' },
    { key: 'density', label: 'Density', type: 'number', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'size', label: 'Size', type: 'number', default: 6, min: 1, max: 40, step: 0.5, unit: 'px' },
    { key: 'speed', label: 'Speed', type: 'number', default: 0.3, min: 0, max: 2, step: 0.01 },
    { key: 'reactivity', label: 'Reactivity', type: 'number', default: 1, min: 0, max: 3, step: 0.05 },
    { key: 'color2', label: 'Second color', type: 'color', default: '#ffd27a' },
    { key: 'glow', label: 'Glow', type: 'number', default: 0.5, min: 0, max: 1, step: 0.01 },
    {
      key: 'direction',
      label: 'Direction',
      type: 'select',
      default: 'up',
      options: [
        { value: 'up', label: 'Rise' },
        { value: 'down', label: 'Fall' },
      ],
    },
  ],
  fragmentShader: `${BAND_AT}${DISPLAY_LEVELS}
vec2 hash2(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xx + q.yz) * q.zy);
}
vec4 mainImage(vec2 uv) {
  float aspect = u_resolution.x / u_resolution.y;
  float pulse = 1.0 + u_reactivity * (0.7 * u_beat + 0.8 * loudLevel());
  float dir = u_direction > 0.5 ? -1.0 : 1.0;
  vec3 rgb = vec3(0.0);
  float acc = 0.0;
  for (int layer = 0; layer < 3; layer++) {
    float fl = float(layer);
    float cells = mix(3.0, 18.0, u_density) * (1.0 + fl * 0.7);
    vec2 p = vec2(uv.x * aspect, uv.y) * cells;
    p.y -= dir * u_time * u_speed * (0.6 + 0.4 * fl) * cells * 0.25;
    vec2 cell = floor(p);
    vec2 f = fract(p);
    vec2 h = hash2(cell + vec2(fl * 37.0, fl * 11.0));
    if (h.y < 0.3) continue;
    float r = clamp(u_size * cells / 1080.0 * pulse * (0.5 + 0.7 * h.x), 0.01, 0.3);
    // The halo stays inside the particle's cell, so neighboring cells never cut it off.
    float rg = min(r * mix(1.0, 2.4, u_glow), 0.45);
    vec2 center = rg + h * (1.0 - 2.0 * rg);
    center.x = clamp(center.x + sin(u_time * (0.4 + h.y) + h.x * 6.2831853) * 0.08, rg, 1.0 - rg);
    float d = length(f - center);
    float dot = (1.0 - smoothstep(r * 0.35, r, d)) * (0.45 + 0.55 * h.x);
    float halo = u_glow * 0.35 * exp(-3.0 * d * d / (rg * rg)) * (1.0 - smoothstep(0.7 * rg, rg, d));
    float a = (dot + halo) / (1.0 + fl * 0.35);
    rgb += mix(u_color.rgb, u_color2.rgb, fract(h.x * 7.13)) * a;
    acc += a;
  }
  float alpha = clamp(acc, 0.0, 1.0) * u_color.a;
  return vec4(clamp(rgb, 0.0, 1.0) * u_color.a, alpha);
}`,
}

export const BUILTIN_GENERATORS: GeneratorDefinition[] = [spectrum, waveform, particles]
