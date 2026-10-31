/** Texture effects: VHS tape and old film. */
import type { EffectDefinition } from '../../engine/types.ts'
import { COMMON, HASH, NOISE } from '../glsl.ts'

export const vhs: EffectDefinition = {
  kind: 'effect',
  id: 'vhs',
  name: 'VHS',
  category: 'Texture',
  description: 'Tape look: color bleed, wobble, tracking noise and scanlines.',
  tags: ['retro', 'tape', '80s', '90s', 'analog', 'camcorder'],
  cost: 'low',
  params: [
    { key: 'amount', label: 'Amount', type: 'number', default: 0.8, min: 0, max: 1, step: 0.01 },
    { key: 'tracking', label: 'Tracking noise', type: 'number', default: 0.35, min: 0, max: 1, step: 0.01 },
    { key: 'noise', label: 'Noise', type: 'number', default: 0.3, min: 0, max: 1, step: 0.01 },
    {
      key: 'scanlines',
      label: 'Scanlines',
      type: 'number',
      default: 0.4,
      min: 0,
      max: 1,
      step: 0.01,
      advanced: true,
    },
    {
      key: 'bleed',
      label: 'Color bleed',
      type: 'number',
      default: 5,
      min: 0,
      max: 20,
      step: 0.5,
      unit: 'px',
      advanced: true,
    },
  ],
  fragmentShader: `${COMMON}${HASH}${NOISE}
vec3 toYiq(vec3 c) { return mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312) * c; }
vec3 fromYiq(vec3 c) { return mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703) * c; }
vec4 mainImage(vec2 uv) {
  float t = u_time;
  float frame = floor(t * 30.0);
  float line = floor(uv.y * 540.0);
  float wobble = (vnoise(vec2(line * 0.05, t * 5.0)) - 0.5) * 0.004 * u_amount;
  float bandPos = fract(0.3 - t * 0.06);
  float band = 1.0 - smoothstep(0.0, 0.05, abs(uv.y - bandPos));
  float tear = band * u_tracking * (hash12(vec2(line, frame)) - 0.3) * 0.05;
  vec2 p = uv + vec2(wobble + tear, 0.0);
  vec4 src = texture(u_input, p);
  float dx = px(1.5) / u_resolution.x;
  float y = toYiq(src.rgb).x * 0.5 +
    0.25 * (toYiq(texture(u_input, p - vec2(dx, 0.0)).rgb).x + toYiq(texture(u_input, p + vec2(dx, 0.0)).rgb).x);
  float bleed = px(u_bleed) / u_resolution.x;
  vec2 iq = vec2(0.0);
  for (int i = 0; i < 6; i++) iq += toYiq(texture(u_input, p - vec2((float(i) - 1.0) * bleed, 0.0)).rgb).yz;
  vec3 col = mix(src.rgb, fromYiq(vec3(y, iq / 6.0 * 1.05)), u_amount);
  float scan = 0.5 + 0.5 * cos(uv.y * u_resolution.y / max(px(3.0), 1.0) * TAU);
  col *= 1.0 - u_scanlines * 0.22 * scan * u_amount;
  col += (hash13(vec3(floor(uv * u_resolution / max(px(1.5), 1.0)), frame)) - 0.5) * u_noise * 0.22 * min(px(1.5), 1.0) * src.a;
  col += band * u_tracking * step(0.985, hash12(vec2(floor(uv.x * 220.0), line + frame))) * 0.7 * src.a;
  col = mix(col, col * 0.92 + 0.04 * src.a, u_amount);
  return vec4(clamp(col, 0.0, src.a), src.a);
}`,
}

export const oldFilm: EffectDefinition = {
  kind: 'effect',
  id: 'old-film',
  name: 'Old film',
  category: 'Texture',
  description: 'Sepia, flicker, gate weave, dust and scratches.',
  tags: ['retro', 'vintage', 'sepia', '8mm', 'super 8', 'silent film'],
  cost: 'low',
  params: [
    { key: 'amount', label: 'Amount', type: 'number', default: 0.85, min: 0, max: 1, step: 0.01 },
    { key: 'sepia', label: 'Sepia', type: 'number', default: 0.6, min: 0, max: 1, step: 0.01 },
    { key: 'dust', label: 'Dust', type: 'number', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'scratches', label: 'Scratches', type: 'number', default: 0.4, min: 0, max: 1, step: 0.01 },
    {
      key: 'flicker',
      label: 'Flicker',
      type: 'number',
      default: 0.35,
      min: 0,
      max: 1,
      step: 0.01,
      advanced: true,
    },
    {
      key: 'weave',
      label: 'Gate weave',
      type: 'number',
      default: 0.5,
      min: 0,
      max: 1,
      step: 0.01,
      advanced: true,
    },
  ],
  fragmentShader: `${COMMON}${HASH}${NOISE}
vec4 mainImage(vec2 uv) {
  float frame = floor(u_time * 24.0);
  vec2 weave = (vec2(vnoise1(frame * 0.37), vnoise1(frame * 0.37 + 40.0)) - 0.5) * pxUv(vec2(8.0)) * u_weave;
  vec4 src = texture(u_input, uv + weave);
  vec3 orig = unpremultiply(src);
  vec3 c = mix(orig, vec3(luma(orig)) * vec3(1.07, 0.95, 0.74) + vec3(0.04, 0.02, 0.0), u_sepia);
  c *= 1.0 + (hash11(frame) - 0.5) * 0.22 * u_flicker;
  vec2 asp = vec2(aspectRatio(), 1.0);
  c *= 1.0 - 0.45 * smoothstep(0.45, 1.05, length((uv - 0.5) * asp) / length(0.5 * asp));
  vec2 g = uv * asp * 12.0;
  vec2 cell = floor(g);
  vec2 h = hash22(cell + frame * 13.7);
  if (h.x < 0.07 * u_dust) {
    vec2 center = cell + hash22(cell + frame * 3.1);
    float r = 0.04 + 0.12 * h.y;
    c *= 1.0 - 0.85 * (1.0 - smoothstep(r * 0.4, r, length((g - center) * vec2(1.0, 0.6 + h.y))));
  }
  float sFrame = floor(u_time * 6.0);
  float scratchOn = step(1.0 - 0.6 * u_scratches, hash11(sFrame * 7.1));
  float sx = 0.1 + 0.8 * hash11(sFrame * 1.3) + 0.004 * sin(uv.y * 9.0 + sFrame);
  float w = max(px(1.2), 1.0) / u_resolution.x;
  float scratch = scratchOn * (1.0 - smoothstep(0.0, w, abs(uv.x - sx)));
  c = mix(c, vec3(0.92, 0.88, 0.8), scratch * 0.55);
  c += (hash13(vec3(floor(uv * u_resolution / max(px(1.6), 1.0)), frame)) - 0.5) * 0.12 * min(px(1.6), 1.0);
  c = mix(orig, c, u_amount);
  return vec4(clamp(c, 0.0, 1.0) * src.a, src.a);
}`,
}

export const TEXTURE_EFFECTS: EffectDefinition[] = [vhs, oldFilm]
