/** Built-in transitions. u_progress is already eased; a missing side samples as transparent. */
import type { TransitionDefinition } from '../types.ts'

export const fade: TransitionDefinition = {
  kind: 'transition',
  id: 'fade',
  name: 'Fade',
  category: 'Basic',
  description: 'Cross-dissolve, or fade from or to the layers below.',
  params: [],
  fragmentShader: `
vec4 transition(vec2 uv) {
  return mix(texture(u_from, uv), texture(u_to, uv), u_progress);
}`,
}

export const flash: TransitionDefinition = {
  kind: 'transition',
  id: 'flash',
  name: 'Flash',
  category: 'Light',
  description: 'Cuts through a bright flash.',
  params: [
    { key: 'color', label: 'Color', type: 'color', default: '#ffffff' },
    { key: 'intensity', label: 'Intensity', type: 'number', default: 1, min: 0, max: 1, step: 0.01 },
  ],
  fragmentShader: `
vec4 transition(vec2 uv) {
  vec4 base = mix(texture(u_from, uv), texture(u_to, uv), smoothstep(0.45, 0.55, u_progress));
  float f = pow(1.0 - abs(u_progress - 0.5) * 2.0, 1.5) * u_intensity;
  return mix(base, vec4(u_color.rgb, 1.0), f);
}`,
}

export const zoom: TransitionDefinition = {
  kind: 'transition',
  id: 'zoom',
  name: 'Zoom',
  category: 'Motion',
  description: 'Punches in on the outgoing shot and settles on the next.',
  params: [{ key: 'strength', label: 'Strength', type: 'number', default: 0.6, min: 0, max: 2, step: 0.01 }],
  fragmentShader: `
vec4 transition(vec2 uv) {
  float p = u_progress;
  vec2 uvA = (uv - 0.5) / (1.0 + p * u_strength) + 0.5;
  vec2 uvB = (uv - 0.5) / (1.0 + (1.0 - p) * u_strength * 0.5) + 0.5;
  return mix(texture(u_from, uvA), texture(u_to, uvB), smoothstep(0.3, 0.7, p));
}`,
}

export const wipeLeft: TransitionDefinition = {
  kind: 'transition',
  id: 'wipe-left',
  name: 'Wipe left',
  category: 'Basic',
  description: 'The next shot wipes in from the right.',
  params: [
    { key: 'softness', label: 'Edge softness', type: 'number', default: 0.04, min: 0, max: 0.5, step: 0.01 },
  ],
  fragmentShader: `
vec4 transition(vec2 uv) {
  float s = max(u_softness, 0.0005);
  float edge = mix(1.0 + s, -s, u_progress);
  return mix(texture(u_from, uv), texture(u_to, uv), smoothstep(edge - s, edge + s, uv.x));
}`,
}

export const BUILTIN_TRANSITIONS: TransitionDefinition[] = [fade, flash, zoom, wipeLeft]
