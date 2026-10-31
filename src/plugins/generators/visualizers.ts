/** Audio visualizers that sit over footage: a circular spectrum and a reactive orb. Output is premultiplied. */
import { DISPLAY_LEVELS } from '../../engine/plugins/generators.ts'
import type { GeneratorDefinition } from '../../engine/types.ts'
import { AUDIO, COMMON, HASH, NOISE } from '../glsl.ts'

export const circle: GeneratorDefinition = {
  kind: 'generator',
  id: 'visualizer.circle',
  name: 'Circle spectrum',
  category: 'Visualizer',
  description: 'Spectrum bars around a ring that pulses with the bass, with optional artwork in the middle.',
  tags: ['reactive', 'spectrum', 'radial', 'bass', 'stems', 'artwork', 'electronic'],
  cost: 'low',
  params: [
    { key: 'color', label: 'Color', type: 'color', default: '#ffffff' },
    { key: 'color2', label: 'Tip color', type: 'color', default: '#ff4fa3' },
    {
      key: 'bars',
      label: 'Bars',
      type: 'number',
      default: 72,
      min: 16,
      max: 160,
      step: 1,
      animatable: false,
      modulatable: false,
    },
    { key: 'radius', label: 'Radius', type: 'number', default: 0.2, min: 0.05, max: 0.45, step: 0.005 },
    { key: 'height', label: 'Bar height', type: 'number', default: 0.16, min: 0, max: 0.5, step: 0.005 },
    { key: 'pulse', label: 'Bass pulse', type: 'number', default: 0.4, min: 0, max: 1, step: 0.01 },
    { key: 'glow', label: 'Glow', type: 'number', default: 0.4, min: 0, max: 1, step: 0.01 },
    { key: 'artwork', label: 'Artwork', type: 'image', default: '', role: 'texture' },
    { key: 'gap', label: 'Gap', type: 'number', default: 0.35, min: 0, max: 0.9, step: 0.01, advanced: true },
    {
      key: 'spin',
      label: 'Spin',
      type: 'number',
      default: 0.02,
      min: -0.5,
      max: 0.5,
      step: 0.005,
      unit: 'turns/s',
      advanced: true,
    },
  ],
  fragmentShader: `${COMMON}${AUDIO}${DISPLAY_LEVELS}
vec4 mainImage(vec2 uv) {
  vec2 p = (uv - 0.5) * vec2(aspectRatio(), 1.0);
  float pix = 1.0 / u_resolution.y;
  float r = length(p);
  float R = u_radius * (1.0 + 0.22 * u_pulse * expandLevel(bassLevel()));
  float bars = floor(u_bars);
  float turn = fract(atan(p.x, p.y) / TAU + 1.0 - u_spin * musicTime());
  float idx = floor(turn * bars);
  // Mirrored: low frequencies at the top, highs meeting at the bottom.
  float x = abs((idx + 0.5) / bars * 2.0 - 1.0);
  float h = max(spectrumLevel(x, floor(x * bars * 0.5)) * u_height, 3.0 / 1080.0);
  float w = max(0.5 * (1.0 - u_gap) * TAU / bars * R, 0.75 * pix);
  float tangential = (fract(turn * bars) - 0.5) * TAU / bars * r;
  float radial = r - R - w;
  float d = length(vec2(tangential, radial - clamp(radial, 0.0, h))) - w;
  float bar = 1.0 - smoothstep(-pix, pix, d);
  vec3 barColor = mix(u_color.rgb, u_color2.rgb, clamp((r - R) / max(u_height, 1e-3), 0.0, 1.0));
  float halo = u_glow * 0.55 * exp(-max(d, 0.0) / (0.012 + 0.03 * u_glow)) * (1.0 - bar);

  float inner = R - 6.0 / 1080.0;
  float ringD = abs(r - inner) - 1.5 / 1080.0;
  float ring = (1.0 - smoothstep(-pix, pix, ringD)) * u_color.a;
  vec4 art = vec4(0.0);
  if (u_artworkSize.x > 0.0) {
    float disk = 1.0 - smoothstep(inner - 2.0 * pix, inner - pix, r);
    vec2 q = p / (2.0 * inner);
    float imgAspect = u_artworkSize.x / u_artworkSize.y;
    q *= imgAspect > 1.0 ? vec2(1.0 / imgAspect, 1.0) : vec2(1.0, imgAspect);
    art = texture(u_artwork, vec2(q.x + 0.5, 0.5 - q.y)) * disk;
  }
  float a = clamp(bar * mix(u_color.a, u_color2.a, 0.5), 0.0, 1.0);
  vec3 rgb = barColor * a + u_color2.rgb * halo + u_color.rgb * ring;
  float alpha = clamp(a + halo + ring, 0.0, 1.0);
  return art * (1.0 - alpha) + vec4(clamp(rgb, 0.0, 1.0), alpha);
}`,
}

export const orb: GeneratorDefinition = {
  kind: 'generator',
  id: 'visualizer.orb',
  name: 'Orb',
  category: 'Visualizer',
  description: 'A glowing liquid orb: bass swells it, mids and highs ripple its edge, vocals light its core.',
  tags: ['reactive', 'orb', 'blob', 'liquid', 'bass', 'vocals', 'stems', 'ambient'],
  cost: 'low',
  params: [
    { key: 'color', label: 'Edge color', type: 'color', default: '#7c5cff' },
    { key: 'color2', label: 'Core color', type: 'color', default: '#ff7ad9' },
    { key: 'size', label: 'Size', type: 'number', default: 0.24, min: 0.05, max: 0.5, step: 0.005 },
    { key: 'wobble', label: 'Wobble', type: 'number', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'glow', label: 'Glow', type: 'number', default: 0.6, min: 0, max: 1, step: 0.01 },
    { key: 'reactivity', label: 'Reactivity', type: 'number', default: 1, min: 0, max: 2, step: 0.05 },
    {
      key: 'detail',
      label: 'Detail',
      type: 'number',
      default: 2.5,
      min: 1,
      max: 6,
      step: 0.1,
      advanced: true,
    },
  ],
  fragmentShader: `${HASH}${NOISE}${COMMON}${AUDIO}${DISPLAY_LEVELS}
vec4 mainImage(vec2 uv) {
  vec2 p = (uv - 0.5) * vec2(aspectRatio(), 1.0);
  float pix = 1.0 / u_resolution.y;
  float t = musicTime();
  float k = u_reactivity;
  float r = length(p);
  vec2 dir = r > 1e-5 ? p / r : vec2(0.0, 1.0);
  float bass = expandLevel(bassLevel());
  float R = u_size * (1.0 + 0.2 * k * bass + 0.06 * k * drumHit());
  float n1 = vnoise(dir * u_detail + vec2(0.6 * t, -0.4 * t)) - 0.5;
  float n2 = vnoise(dir * u_detail * 2.3 + vec2(-0.9 * t, 0.7 * t) + 7.0) - 0.5;
  float edge = R * (1.0 + u_wobble * (0.38 * n1 * (0.4 + k * expandLevel(midLevel())) + 0.2 * n2 * (0.25 + k * expandLevel(highLevel()))));
  float d = r - edge;
  float body = 1.0 - smoothstep(-pix, pix, d);
  float rel = clamp(r / max(edge, 1e-4), 0.0, 1.0);
  float swirl = fbm(rotate2d(0.3 * t) * p / max(R, 1e-3) * 1.6 + vec2(0.0, 0.25 * t));
  vec3 core = mix(u_color2.rgb, u_color.rgb, smoothstep(0.05, 1.0, rel));
  core *= 0.7 + 0.45 * swirl + 0.35 * k * vocalLevel() * (1.0 - rel);
  core += u_color2.rgb * pow(rel, 8.0) * 0.5;
  float halo = u_glow * exp(-max(d, 0.0) / (R * (0.25 + 0.2 * k * bass))) * 0.75 * (1.0 - body);
  float a = body * u_color.a;
  vec3 rgb = clamp(core, 0.0, 1.0) * a + mix(u_color.rgb, u_color2.rgb, 0.3) * halo;
  return vec4(clamp(rgb, 0.0, 1.0), clamp(a + halo, 0.0, 1.0));
}`,
}

export const VISUALIZERS: GeneratorDefinition[] = [circle, orb]
