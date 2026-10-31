import { CAMERA_PRESETS, MAX_OFFSET, OVERSCAN_MARGIN, OVERSCAN_SAMPLES } from './camera.ts'
import type { CameraPreset } from '../types.ts'

/**
 * GLSL for the 3D camera move effect (`src/plugins/parallax.ts`) and the standalone parallax renderer. This module
 * has no runtime dependencies so the plugin registry, which also loads in workers, can import it on its own.
 */

/** Stable plugin id, stored in projects. */
export const CAMERA_EFFECT_ID = 'camera-3d'

export const DEFAULT_CAMERA_PRESET: CameraPreset = 'dolly-in'

/** Option order of the effect's `fit` select; matches the clip's MediaFit so depth lines up with the layer. */
export const CAMERA_EFFECT_FITS = ['cover', 'contain', 'stretch'] as const

export const PARALLAX_MIN_STEPS = 16
export const PARALLAX_MAX_STEPS = 48

const float = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v))

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

/** GLSL port of `cameraPoseAt` (camera.ts); presets are indices into CAMERA_PRESETS. */
export const CAMERA_POSE_GLSL = `
const float CAMERA_PI = 3.141592653589793;
const int CAMERA_OVERSCAN_SAMPLES = ${OVERSCAN_SAMPLES};

struct CameraPose {
  vec2 offset;
  vec2 pan;
  float zoom;
  float dolly;
};

CameraPose cameraRawPose(int preset, float progress, float intensity) {
  float e = 0.5 - 0.5 * cos(CAMERA_PI * clamp(progress, 0.0, 1.0));
  float s = 2.0 * e - 1.0;
  float a = ${float(MAX_OFFSET)} * intensity;
  CameraPose c = CameraPose(vec2(0.0), vec2(0.0), 1.0, 0.0);
  if (preset <= ${CAMERA_PRESETS.indexOf('dolly-out')}) {
    float k = preset == ${CAMERA_PRESETS.indexOf('dolly-in')} ? e : 1.0 - e;
    c.zoom = 1.0 + 0.12 * intensity * k;
    c.dolly = 0.22 * intensity * k;
  } else if (preset <= ${CAMERA_PRESETS.indexOf('pan-right')}) {
    float dir = preset == ${CAMERA_PRESETS.indexOf('pan-left')} ? 1.0 : -1.0;
    c.offset.x = dir * a * s;
    c.pan.x = dir * 0.5 * a * s;
  } else if (preset <= ${CAMERA_PRESETS.indexOf('tilt-down')}) {
    float dir = preset == ${CAMERA_PRESETS.indexOf('tilt-up')} ? 1.0 : -1.0;
    c.pan.y = dir * 0.8 * a * s;
    c.offset.y = dir * 0.35 * a * s;
  } else if (preset <= ${CAMERA_PRESETS.indexOf('orbit-right')}) {
    float dir = preset == ${CAMERA_PRESETS.indexOf('orbit-left')} ? 1.0 : -1.0;
    c.offset.x = dir * 1.3 * a * s;
    c.offset.y = -0.15 * a * sin(CAMERA_PI * e);
    c.zoom = 1.0 + 0.04 * intensity * sin(CAMERA_PI * e);
  } else if (preset == ${CAMERA_PRESETS.indexOf('crane-up')}) {
    c.offset.y = a * s;
    c.pan.y = 0.4 * a * s;
    c.zoom = 1.0 + 0.05 * intensity * e;
  } else {
    c.zoom = 1.0 + 0.18 * intensity * e;
    c.dolly = 0.1 * intensity * e;
    c.offset = vec2(0.5, 0.25) * a * s;
    c.pan = vec2(-0.3, -0.15) * a * s;
  }
  return c;
}

float cameraAxisZoom(float offset, float pan, float dolly, float focus) {
  float zoom = 1.0;
  for (int i = 0; i < 2; i++) {
    float k = i == 0 ? -focus : 1.0 - focus;
    float c = 1.0 - dolly * k;
    float room = 0.5 - abs(pan * c + offset * k);
    if (c <= 0.0 || room <= 0.0) return 1e4;
    zoom = max(zoom, 0.5 * c / room);
  }
  return zoom;
}

float cameraRequiredZoom(CameraPose c, float focus) {
  return max(cameraAxisZoom(c.offset.x, c.pan.x, c.dolly, focus), cameraAxisZoom(c.offset.y, c.pan.y, c.dolly, focus));
}

CameraPose cameraPoseAt(int preset, float progress, float intensity, float focus) {
  float factor = 1.0;
  for (int i = 0; i <= CAMERA_OVERSCAN_SAMPLES; i++) {
    CameraPose c = cameraRawPose(preset, float(i) / float(CAMERA_OVERSCAN_SAMPLES), intensity);
    factor = max(factor, cameraRequiredZoom(c, focus) / c.zoom);
  }
  CameraPose pose = cameraRawPose(preset, progress, intensity);
  pose.zoom *= factor * ${float(OVERSCAN_MARGIN)};
  return pose;
}
`

/**
 * Effect body. The layer arrives fitted into the canvas, so the canvas stands in for the image: the camera works in
 * top-left canvas coordinates and depth is read through the clip's fit (the depth image has the still's aspect).
 * Without a depth map the move still pans and zooms, with no parallax.
 */
export const CAMERA_EFFECT_GLSL = `${PARALLAX_MARCH_GLSL}
${CAMERA_POSE_GLSL}
vec4 mainImage(vec2 uv) {
  vec2 t = vec2(uv.x, 1.0 - uv.y);
  bool hasDepth = u_depthSize.x > 0.0 && u_depthSize.y > 0.0;
  vec2 size = vec2(1.0);
  int fit = int(u_fit + 0.5);
  if (hasDepth && fit != 2) {
    float r = (u_depthSize.x / u_depthSize.y) / (u_resolution.x / u_resolution.y);
    size = ((fit == 0) == (r > 1.0)) ? vec2(r, 1.0) : vec2(1.0, 1.0 / r);
  }
  vec2 lo = max(vec2(0.0), 0.5 - 0.5 * size);
  vec2 hi = min(vec2(1.0), 0.5 + 0.5 * size);
  if (any(lessThan(t, lo)) || any(greaterThan(t, hi))) return texture(u_input, uv);
  float focus = clamp(u_focus, 0.0, 1.0);
  CameraPose c = cameraPoseAt(int(u_preset + 0.5), u_progress, clamp(u_intensity, 0.0, 1.0), focus);
  vec2 p = 0.5 + (t - 0.5) / c.zoom - c.pan;
  vec2 v = c.offset + (p - 0.5) * c.dolly;
  vec2 q = hasDepth ? parallaxMarch(u_depth, 1.0 / size, 0.5 - 0.5 / size, u_depthSize, p, v, focus) : p;
  q = clamp(q, lo, hi);
  return texture(u_input, vec2(q.x, 1.0 - q.y));
}
`
