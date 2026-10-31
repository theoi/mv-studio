import type { EffectUniformValue, ResolvedParams } from '../../engine/types.ts'
import { CAMERA_PRESETS, cameraPoseAt } from './camera.ts'
import type { CameraPreset } from '../types.ts'

/**
 * GLSL for the 3D camera move effect (`src/plugins/parallax.ts`) and the standalone parallax renderer. This module
 * depends only on camera.ts so the plugin registry, which also loads in workers, can import it on its own.
 */

/** Stable plugin id, stored in projects. */
export const CAMERA_EFFECT_ID = 'camera-3d'

export const DEFAULT_CAMERA_PRESET: CameraPreset = 'dolly-in'

export const PARALLAX_MIN_STEPS = 16
export const PARALLAX_MAX_STEPS = 48

/**
 * `parallaxMarch` returns the image point to sample for image point `p` whose parallax direction at depth 1 is `v`.
 * It walks the depth layers h from 1 (near) down to 0 (far) along q(h) = p - v * (h - focus) and stops at the first
 * layer the depth map reaches, so near content occludes far content. Depth (red channel, 0 far .. 1 near) is read at
 * q * depthScale + depthOffset.
 */
export const PARALLAX_MARCH_GLSL = `
const int PARALLAX_MIN_STEPS = ${PARALLAX_MIN_STEPS};
const int PARALLAX_MAX_STEPS = ${PARALLAX_MAX_STEPS};

float parallaxDepth(sampler2D depthMap, vec2 q, vec2 depthScale, vec2 depthOffset) {
  return textureLod(depthMap, clamp(q * depthScale + depthOffset, 0.0, 1.0), 0.0).r;
}

vec2 parallaxMarch(sampler2D depthMap, vec2 depthScale, vec2 depthOffset, vec2 depthTexels, vec2 p, vec2 v, float focus) {
  // One step per depth texel along the whole ray, so thin near features are not stepped over.
  float rayTexels = length(v * depthScale * depthTexels);
  int steps = int(clamp(ceil(rayTexels), float(PARALLAX_MIN_STEPS), float(PARALLAX_MAX_STEPS)));
  float dh = 1.0 / float(steps);
  float h = 1.0;
  float d = parallaxDepth(depthMap, p - v * (h - focus), depthScale, depthOffset);
  float prevH = h;
  float prevD = d;
  for (int i = 0; i < PARALLAX_MAX_STEPS; i++) {
    if (d >= h || i >= steps) break;
    prevH = h;
    prevD = d;
    h -= dh;
    d = parallaxDepth(depthMap, p - v * (h - focus), depthScale, depthOffset);
  }
  // Linear refinement between the last layer above the surface and the first one at or below it.
  float hit = h;
  float above = prevD - prevH;
  float below = d - h;
  if (above < 0.0 && above - below < 0.0) hit = mix(prevH, h, clamp(above / (above - below), 0.0, 1.0));
  return p - v * (hit - focus);
}
`

/** Per-frame uniforms of the camera effect: the pose, computed once per frame instead of in every pixel. */
export function cameraEffectUniforms(params: ResolvedParams): Record<string, EffectUniformValue> {
  const num = (v: unknown) => (typeof v === 'number' ? v : 0)
  const preset = CAMERA_PRESETS.find((p) => p === params.preset) ?? DEFAULT_CAMERA_PRESET
  const pose = cameraPoseAt(
    { preset, intensity: num(params.intensity), focus: num(params.focus) },
    num(params.progress),
  )
  return {
    cameraOffset: [pose.offsetX, pose.offsetY],
    cameraPan: [pose.panX ?? 0, pose.panY ?? 0],
    cameraZoom: pose.zoom,
    cameraDolly: pose.dolly ?? 0,
    cameraFocus: pose.focus,
  }
}

/**
 * Effect body. It works in the layer's own coordinates (u_canvasToLayer, top-left 0..1 over the still), so it follows
 * the clip's fit and transform: the camera frames the part of the still visible on the canvas, depth is read directly
 * in image coordinates, and colour is sampled back from the transformed layer. The pose comes from
 * cameraEffectUniforms. Without a depth map the move still pans and zooms, with no parallax.
 */
export const CAMERA_EFFECT_GLSL = `${PARALLAX_MARCH_GLSL}
uniform vec2 u_cameraOffset;
uniform vec2 u_cameraPan;
uniform float u_cameraZoom;
uniform float u_cameraDolly;
uniform float u_cameraFocus;

vec2 cameraToLayer(vec2 canvasUv) {
  return (u_canvasToLayer * vec3(canvasUv, 1.0)).xy;
}

vec4 mainImage(vec2 uv) {
  vec2 i = cameraToLayer(uv);
  if (any(lessThan(i, vec2(0.0))) || any(greaterThan(i, vec2(1.0)))) return texture(u_input, uv);
  // The visible part of the still; the move's overscan keeps every sample inside it.
  vec2 c0 = cameraToLayer(vec2(0.0, 0.0));
  vec2 c1 = cameraToLayer(vec2(1.0, 0.0));
  vec2 c2 = cameraToLayer(vec2(0.0, 1.0));
  vec2 c3 = cameraToLayer(vec2(1.0, 1.0));
  vec2 lo = clamp(min(min(c0, c1), min(c2, c3)), 0.0, 1.0);
  vec2 size = max(clamp(max(max(c0, c1), max(c2, c3)), 0.0, 1.0) - lo, vec2(1e-6));
  vec2 t = (i - lo) / size;
  vec2 p = 0.5 + (t - 0.5) / u_cameraZoom - u_cameraPan;
  vec2 v = u_cameraOffset + (p - 0.5) * u_cameraDolly;
  bool hasDepth = u_depthSize.x > 0.0 && u_depthSize.y > 0.0;
  vec2 q = hasDepth ? parallaxMarch(u_depth, size, lo, u_depthSize, p, v, u_cameraFocus) : p;
  vec2 source = lo + clamp(q, 0.0, 1.0) * size;
  return texture(u_input, (u_layerToCanvas * vec3(source, 1.0)).xy);
}
`
