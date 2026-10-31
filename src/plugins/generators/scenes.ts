/**
 * Full-frame generative scenes for visualizer videos and lyric backgrounds. Each has a background color; give it zero
 * alpha to lay the scene over footage. Motion follows musicTime() (faster when the music is loud), so it never jitters.
 */
import type { GeneratorDefinition, ParamSpec } from '../../engine/types.ts'
import { AUDIO, COMMON, HASH, NOISE } from '../glsl.ts'

const background = (value = '#05030c'): ParamSpec => ({
  key: 'background',
  label: 'Background',
  type: 'color',
  default: value,
})

const reactivity: ParamSpec = {
  key: 'reactivity',
  label: 'Reactivity',
  type: 'number',
  default: 1,
  min: 0,
  max: 2,
  step: 0.05,
}

const speed = (value: number, max = 3): ParamSpec => ({
  key: 'speed',
  label: 'Speed',
  type: 'number',
  default: value,
  min: 0,
  max,
  step: 0.01,
})

/** Shared chunks plus `scene(light)`: additive light over the background color, premultiplied. */
const SCENE = `${HASH}${NOISE}${COMMON}${AUDIO}
vec4 scene(vec3 light) {
  light = clamp(light, 0.0, 1.0);
  float a = max(light.r, max(light.g, light.b));
  vec4 bg = vec4(u_background.rgb * u_background.a, u_background.a);
  return vec4(light + bg.rgb * (1.0 - a), a + bg.a * (1.0 - a));
}
/** Gradient-free line mask: 1 on lines of a periodic coordinate, antialiased with its screen-space derivative. */
float gridLine(float coord, float width) {
  float d = abs(fract(coord + 0.5) - 0.5);
  float aa = fwidth(coord);
  return 1.0 - smoothstep(width - aa, width + aa, d);
}
float stars(vec2 uv, float density, float twinkle) {
  vec2 cell = floor(uv * u_resolution / max(px(3.0), 1.0));
  float h = hash12(cell);
  float on = step(1.0 - 0.012 * density, h);
  return on * (0.5 + 0.5 * sin(u_time * (1.5 + 3.0 * hash12(cell + 9.1)) * twinkle + h * TAU));
}`

export const tunnel: GeneratorDefinition = {
  kind: 'generator',
  id: 'generator.tunnel',
  name: 'Tunnel',
  category: 'Scene',
  description: 'An endless neon tunnel that speeds up with the music and flashes on the kick.',
  tags: ['reactive', 'tunnel', 'neon', 'flight', 'electronic', 'hypnotic', 'beat'],
  cost: 'low',
  params: [
    { key: 'color', label: 'Color', type: 'color', default: '#22d3ee' },
    { key: 'color2', label: 'Second color', type: 'color', default: '#f472b6' },
    background(),
    speed(1),
    {
      key: 'shape',
      label: 'Shape',
      type: 'select',
      default: 'circle',
      options: [
        { value: 'circle', label: 'Circle' },
        { value: 'square', label: 'Square' },
        { value: 'hexagon', label: 'Hexagon' },
      ],
    },
    { key: 'twist', label: 'Twist', type: 'number', default: 0.2, min: -1, max: 1, step: 0.01 },
    reactivity,
    {
      key: 'lines',
      label: 'Lines',
      type: 'number',
      default: 12,
      min: 3,
      max: 32,
      step: 1,
      animatable: false,
      modulatable: false,
      advanced: true,
    },
  ],
  fragmentShader: `${SCENE}
vec4 mainImage(vec2 uv) {
  float t = musicTime();
  vec2 p = (uv - 0.5) * vec2(aspectRatio(), 1.0);
  p += 0.06 * vec2(sin(t * 0.31), cos(t * 0.23));
  int shape = int(u_shape + 0.5);
  vec2 q = abs(p);
  float r = shape == 0 ? length(p) : shape == 1 ? max(q.x, q.y) : max(q.x * 0.866 + q.y * 0.5, q.y);
  r = max(r, 1e-3);
  float depth = 0.3 / r + t * u_speed * 0.9;
  float angle = atan(p.y, p.x) / TAU + u_twist * 0.08 / r + 0.02 * t;
  float rings = gridLine(depth, 0.035);
  float spokes = gridLine(angle * floor(u_lines), 0.018);
  float near = smoothstep(0.02, 0.3, r);
  float hit = u_reactivity * drumHit();
  // A ring of light runs toward the camera on every beat.
  float pulse = exp(-pow((fract(depth * 0.25 - u_beatPhase) - 0.5) * 9.0, 2.0)) * (0.4 + hit);
  vec3 tint = mix(u_color.rgb, u_color2.rgb, 0.5 + 0.5 * sin(depth * 0.7));
  float lines = max(rings, spokes * 0.7);
  vec3 light = tint * (lines * (0.55 + 0.6 * hit + 0.8 * pulse) + pulse * 0.08) * near;
  light += tint * 0.12 * exp(-r * 6.0) * (1.0 + hit);
  return scene(light * (0.85 + 0.3 * u_reactivity * bassLevel()));
}`,
}

export const starfield: GeneratorDefinition = {
  kind: 'generator',
  id: 'generator.starfield',
  name: 'Starfield',
  category: 'Scene',
  description: 'Flying through stars that stretch into streaks on the beat.',
  tags: ['reactive', 'space', 'stars', 'warp', 'flight', 'ambient', 'beat'],
  cost: 'low',
  params: [
    { key: 'color', label: 'Color', type: 'color', default: '#ffffff' },
    { key: 'color2', label: 'Second color', type: 'color', default: '#93c5fd' },
    background('#020108'),
    speed(1),
    { key: 'density', label: 'Density', type: 'number', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'warp', label: 'Warp streaks', type: 'number', default: 0.5, min: 0, max: 1, step: 0.01 },
    reactivity,
  ],
  fragmentShader: `${SCENE}
vec4 mainImage(vec2 uv) {
  vec2 p = (uv - 0.5) * vec2(aspectRatio(), 1.0);
  float t = musicTime() * u_speed * 0.18;
  vec2 radial = normalize(p + vec2(1e-4, 0.0));
  float streak = 1.0 + 2.5 * u_warp * (0.4 + u_reactivity * drumHit());
  vec3 light = vec3(0.0);
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float z = fract(fi / 5.0 + t);
    float scale = mix(16.0, 1.2, z) * mix(0.6, 1.4, u_density);
    float fade = smoothstep(0.0, 0.35, z) * (1.0 - smoothstep(0.85, 1.0, z));
    vec2 g = p * scale + fi * 17.31;
    vec2 cell = floor(g);
    vec3 h = hash32(cell + fi * 31.7);
    vec2 d = fract(g) - 0.5 - (h.xy - 0.5) * 0.5;
    float stretch = mix(1.0, streak, z);
    float along = dot(d, radial) / stretch;
    float across = dot(d, vec2(-radial.y, radial.x));
    float dist = length(vec2(along, across));
    float size = (0.015 + 0.035 * h.z) * mix(0.6, 1.0, z);
    float pix = scale / u_resolution.y;
    float star = 1.0 - smoothstep(size - pix, size + pix, dist);
    float glow = 0.08 * size / (dist + 0.02);
    float present = step(1.0 - mix(0.35, 0.9, u_density), h.z);
    light += mix(u_color.rgb, u_color2.rgb, h.x) * (star + glow) * fade * present;
  }
  light += u_color2.rgb * 0.05 * exp(-length(p) * 3.0) * (1.0 + u_reactivity * bassLevel());
  return scene(light);
}`,
}

export const synthwave: GeneratorDefinition = {
  kind: 'generator',
  id: 'generator.synthwave',
  name: 'Retro grid',
  category: 'Scene',
  description: 'An 80s neon grid racing toward a striped sunset sun that pulses with the beat.',
  tags: ['reactive', 'synthwave', 'retro', '80s', 'outrun', 'neon', 'grid', 'sun', 'beat'],
  cost: 'low',
  params: [
    { key: 'color', label: 'Grid color', type: 'color', default: '#ff3df2' },
    { key: 'color2', label: 'Sun color', type: 'color', default: '#ffb347' },
    background('#12002a'),
    speed(1),
    { key: 'sun', label: 'Sun size', type: 'number', default: 0.22, min: 0, max: 0.4, step: 0.005 },
    reactivity,
    {
      key: 'horizon',
      label: 'Horizon',
      type: 'number',
      default: 0.42,
      min: 0.2,
      max: 0.7,
      step: 0.01,
      advanced: true,
    },
  ],
  fragmentShader: `${SCENE}
vec4 mainImage(vec2 uv) {
  float a = aspectRatio();
  float hit = u_reactivity * drumHit();
  float y = uv.y - u_horizon;
  vec3 light = vec3(0.0);
  if (y < 0.0) {
    float depth = max(-y, 1e-3);
    float z = 0.18 / depth;
    float x = (uv.x - 0.5) * a * z;
    float lines = max(gridLine(x * 4.0, 0.025), gridLine(z * 1.5 + musicTime() * u_speed * 1.8, 0.035));
    float fog = smoothstep(0.0, 0.25, depth);
    light = u_color.rgb * lines * fog * (0.7 + 0.6 * hit);
    light += u_color.rgb * 0.25 * exp(-depth * 18.0);
  } else {
    float sunR = u_sun * (1.0 + 0.06 * hit);
    vec2 c = vec2(0.5 * a, u_horizon + sunR * 0.75);
    vec2 sp = vec2(uv.x * a, uv.y) - c;
    float pix = 1.0 / u_resolution.y;
    float disk = 1.0 - smoothstep(sunR - pix, sunR + pix, length(sp));
    float v = (sp.y + sunR) / max(2.0 * sunR, 1e-3);
    // Stripes that widen toward the bottom of the sun and slide down slowly.
    float band = fract(v * 9.0 + 0.15 * u_time);
    float cut = step(band, mix(0.55, 0.0, smoothstep(0.0, 0.55, v))) * step(v, 0.55);
    vec3 sunColor = mix(u_color.rgb, u_color2.rgb, smoothstep(0.1, 0.9, v));
    light = sunColor * disk * (1.0 - cut);
    light += u_color2.rgb * 0.35 * exp(-length(sp) / max(sunR, 1e-3) * 1.6) * (1.0 - disk) * (0.8 + 0.4 * hit);
    light += vec3(stars(uv, 1.0, 1.0)) * smoothstep(0.05, 0.3, y) * 0.8;
    light += u_color.rgb * 0.5 * exp(-y * 40.0);
  }
  return scene(light);
}`,
}

export const geometry: GeneratorDefinition = {
  kind: 'generator',
  id: 'generator.geometry',
  name: 'Sacred geometry',
  category: 'Scene',
  description: 'Nested neon polygons that counter-rotate and kick outward on the beat.',
  tags: ['reactive', 'geometry', 'shapes', 'neon', 'hypnotic', 'minimal', 'beat'],
  cost: 'medium',
  params: [
    { key: 'color', label: 'Color', type: 'color', default: '#a78bfa' },
    { key: 'color2', label: 'Second color', type: 'color', default: '#22d3ee' },
    background(),
    {
      key: 'sides',
      label: 'Sides',
      type: 'number',
      default: 6,
      min: 3,
      max: 12,
      step: 1,
      animatable: false,
      modulatable: false,
    },
    {
      key: 'count',
      label: 'Shapes',
      type: 'number',
      default: 6,
      min: 1,
      max: 10,
      step: 1,
      animatable: false,
      modulatable: false,
    },
    speed(0.5, 2),
    {
      key: 'thickness',
      label: 'Thickness',
      type: 'number',
      default: 4,
      min: 1,
      max: 20,
      step: 0.5,
      unit: 'px',
    },
    reactivity,
  ],
  fragmentShader: `${SCENE}
/** Distance-like field of a regular n-gon, from the point's angle (from +y, clockwise) and radius. */
float polygon(float a, float r, float n) {
  float b = TAU / n;
  return cos(floor(0.5 + a / b) * b - a) * r;
}
vec4 mainImage(vec2 uv) {
  vec2 p = (uv - 0.5) * vec2(aspectRatio(), 1.0);
  float t = musicTime() * u_speed;
  float hit = u_reactivity * drumHit();
  float n = floor(u_sides);
  float count = floor(u_count);
  float w = 0.5 * u_thickness / 1080.0;
  float pix = 1.0 / u_resolution.y;
  vec3 light = vec3(0.0);
  // Rotating a shape only offsets the angle, so atan and length are computed once.
  float angle = atan(p.x, p.y);
  float radius = length(p);
  for (int i = 0; i < 10; i++) {
    float fi = float(i);
    if (fi >= count) break;
    float k = count > 1.0 ? fi / (count - 1.0) : 0.0;
    float size = 0.42 * pow(0.74, fi) * (1.0 + 0.12 * hit * (1.0 - k)) * (1.0 + 0.1 * u_reactivity * bandAt(k));
    float dir = mod(fi, 2.0) < 0.5 ? 1.0 : -1.0;
    float d = abs(polygon(angle - dir * t * (0.25 + 0.12 * fi) - fi * 0.4, radius, n) - size);
    float line = 1.0 - smoothstep(w - pix, w + pix, d);
    float glow = 0.004 / (d + 0.004) * 0.25;
    light += mix(u_color.rgb, u_color2.rgb, k) * (line + glow) * (0.75 + 0.5 * hit);
  }
  return scene(light);
}`,
}

export const nebula: GeneratorDefinition = {
  kind: 'generator',
  id: 'generator.nebula',
  name: 'Nebula',
  category: 'Background',
  description: 'Slow cosmic clouds that brighten with the music.',
  tags: ['reactive', 'space', 'clouds', 'ambient', 'dreamy', 'cosmic', 'background'],
  cost: 'medium',
  params: [
    { key: 'color', label: 'Color', type: 'color', default: '#7c3aed' },
    { key: 'color2', label: 'Second color', type: 'color', default: '#f472b6' },
    background('#030212'),
    speed(0.4, 2),
    { key: 'scale', label: 'Scale', type: 'number', default: 1, min: 0.3, max: 3, step: 0.01 },
    { key: 'stars', label: 'Stars', type: 'number', default: 0.6, min: 0, max: 1, step: 0.01 },
    reactivity,
  ],
  fragmentShader: `${SCENE}
vec4 mainImage(vec2 uv) {
  float t = musicTime() * u_speed * 0.15;
  vec2 p = (uv - 0.5) * vec2(aspectRatio(), 1.0) * 2.2 / u_scale;
  vec2 q = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, 1.3) - t));
  float f = fbm(p + 2.2 * q + vec2(1.7 * t, 9.2));
  float dense = smoothstep(0.35, 0.95, f);
  vec3 cloud = mix(u_color.rgb, u_color2.rgb, smoothstep(0.3, 0.8, q.x)) * dense;
  cloud += u_color2.rgb * pow(dense, 4.0) * 0.6;
  float level = 0.75 + 0.5 * u_reactivity * (0.6 * u_loudness + 0.4 * bassLevel());
  vec3 light = cloud * level * 0.9;
  light += vec3(stars(uv, u_stars * 1.5, 1.0)) * (1.0 - dense) * u_stars;
  return scene(light);
}`,
}

export const aurora: GeneratorDefinition = {
  kind: 'generator',
  id: 'generator.aurora',
  name: 'Aurora',
  category: 'Background',
  description: 'Northern lights rippling across a starry sky, swelling with the vocals.',
  tags: ['reactive', 'aurora', 'sky', 'night', 'ambient', 'calm', 'vocals', 'stems', 'background'],
  cost: 'low',
  params: [
    { key: 'color', label: 'Color', type: 'color', default: '#34d399' },
    { key: 'color2', label: 'Top color', type: 'color', default: '#8b5cf6' },
    background('#020617'),
    speed(0.5, 2),
    { key: 'height', label: 'Height', type: 'number', default: 0.6, min: 0.2, max: 0.9, step: 0.01 },
    { key: 'stars', label: 'Stars', type: 'number', default: 0.6, min: 0, max: 1, step: 0.01 },
    reactivity,
  ],
  fragmentShader: `${SCENE}
vec4 mainImage(vec2 uv) {
  float t = musicTime() * u_speed * 0.2;
  float x = uv.x * aspectRatio();
  vec3 light = vec3(0.0);
  float level = 0.7 + 0.6 * u_reactivity * vocalLevel();
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float base = u_height - 0.12 * fi + 0.12 * (vnoise(vec2(x * 0.9 + t + fi * 3.1, fi)) - 0.5);
    float wave = 0.05 * sin(x * (2.0 + fi) + t * 2.0 + fi);
    float y = uv.y - base - wave;
    // Sharp lower edge, long fade upward.
    float curtain = y < 0.0 ? exp(-y * y * 900.0) : exp(-y * (5.0 + 2.0 * fi));
    float rays = 0.55 + 0.45 * vnoise(vec2(x * 28.0 + fi * 11.0, t * 3.0));
    vec3 tint = mix(u_color.rgb, u_color2.rgb, smoothstep(-0.02, 0.25, y));
    light += tint * curtain * rays * (0.55 - 0.12 * fi);
  }
  light *= level;
  light += vec3(stars(uv, 1.0, 1.0)) * u_stars * smoothstep(0.2, 0.6, uv.y) * (1.0 - min(light.g * 2.0, 1.0));
  return scene(light);
}`,
}

export const gradient: GeneratorDefinition = {
  kind: 'generator',
  id: 'generator.gradient',
  name: 'Gradient flow',
  category: 'Background',
  description:
    'Soft color fields drifting into each other, breathing with the beat. A calm backdrop for lyrics.',
  tags: ['reactive', 'gradient', 'soft', 'calm', 'minimal', 'pastel', 'background', 'lyrics'],
  cost: 'low',
  params: [
    { key: 'color', label: 'Color', type: 'color', default: '#6d28d9' },
    { key: 'color2', label: 'Second color', type: 'color', default: '#f472b6' },
    { key: 'color3', label: 'Third color', type: 'color', default: '#38bdf8' },
    background('#0b1026'),
    speed(0.4, 2),
    { key: 'softness', label: 'Softness', type: 'number', default: 0.5, min: 0, max: 1, step: 0.01 },
    reactivity,
  ],
  fragmentShader: `${SCENE}
vec4 mainImage(vec2 uv) {
  float a = aspectRatio();
  vec2 p = vec2(uv.x * a, uv.y);
  float t = musicTime() * u_speed * 0.35;
  float breath = 1.0 + 0.08 * u_reactivity * (u_beat + bassLevel());
  vec2 c0 = vec2(a * (0.3 + 0.2 * sin(t * 0.9)), 0.35 + 0.25 * cos(t * 0.7));
  vec2 c1 = vec2(a * (0.7 + 0.2 * cos(t * 0.6 + 1.0)), 0.65 + 0.2 * sin(t * 0.8 + 2.0));
  vec2 c2 = vec2(a * (0.5 + 0.3 * sin(t * 0.5 + 4.0)), 0.5 + 0.3 * sin(t * 0.45 + 1.0));
  float s = mix(0.06, 0.3, u_softness) * breath;
  float w0 = exp(-dot(p - c0, p - c0) / s);
  float w1 = exp(-dot(p - c1, p - c1) / s);
  float w2 = exp(-dot(p - c2, p - c2) / (s * 0.8));
  float total = w0 + w1 + w2;
  vec3 blobs = (u_color.rgb * w0 + u_color2.rgb * w1 + u_color3.rgb * w2) / max(total, 1e-5);
  float cover = total / (total + 0.15);
  vec4 bg = vec4(u_background.rgb * u_background.a, u_background.a);
  vec4 c = vec4(blobs * cover, cover) + bg * (1.0 - cover);
  // Dither against banding in smooth gradients; a function of pixel and frame, so preview and export match.
  float noise = (hash13(vec3(floor(uv * u_resolution), floor(u_time * 24.0))) - 0.5) / 255.0;
  return vec4(clamp(c.rgb + noise * c.a, 0.0, c.a), c.a);
}`,
}

export const SCENES: GeneratorDefinition[] = [
  tunnel,
  starfield,
  synthwave,
  geometry,
  nebula,
  aurora,
  gradient,
]
