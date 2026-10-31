/**
 * GLSL chunks shared by the library plugins. A plugin shader concatenates the chunks it uses before its own body;
 * they rely only on the uniforms every plugin receives (see "Plugins" in AGENTS.md).
 */

/** Hash functions adapted from "Hash without Sine" by David Hoskins (MIT). */
export const HASH = `
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
vec3 hash32(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}`

/** Smooth value noise and 4-octave fractal noise, both in 0..1. Needs HASH. */
export const NOISE = `
float vnoise1(float x) {
  float i = floor(x);
  float f = fract(x);
  return mix(hash11(i), hash11(i + 1.0), f * f * (3.0 - 2.0 * f));
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  const mat2 R = mat2(0.8, 0.6, -0.6, 0.8);
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * vnoise(p);
    p = R * p * 2.03 + 17.1;
    a *= 0.5;
  }
  return v / 0.9375;
}`

/** Constants, 1080p-relative pixel sizes, color helpers and a loudness-weighted clock. */
export const COMMON = `
const float PI = 3.14159265;
const float TAU = 6.2831853;
/** Pixels at 1080p to canvas pixels, so reduced-size previews look like the export. */
float px(float v) { return v * u_resolution.y / 1080.0; }
/** An offset in 1080p pixels as a uv offset. */
vec2 pxUv(vec2 v) { return v * (u_resolution.y / 1080.0) / u_resolution; }
float aspectRatio() { return u_resolution.x / u_resolution.y; }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 unpremultiply(vec4 c) { return c.a > 1e-5 ? c.rgb / c.a : vec3(0.0); }
float insideUv(vec2 uv) { return step(0.0, uv.x) * step(0.0, uv.y) * step(uv.x, 1.0) * step(uv.y, 1.0); }
mat2 rotate2d(float a) { float c = cos(a); float s = sin(a); return mat2(c, s, -s, c); }
/** Seconds that run faster when the music is loud (half speed in silence, about real time at average loudness). */
float musicTime() { return 0.5 * u_time + u_flow; }`

/**
 * Audio helpers in 0..1: spectrum lookup and levels for bass, mids, highs, drums and vocals. They use separated stems
 * when the song has them and fall back to frequency bands, onsets and beats otherwise.
 */
export const AUDIO = `
float bandAt(float x) {
  if (u_bandCount < 1.0) return u_loudness;
  float f = clamp(x, 0.0, 1.0) * (u_bandCount - 1.0);
  int i = min(int(floor(f)), 15);
  int j = min(i + 1, min(int(u_bandCount) - 1, 15));
  return mix(u_bands[i], u_bands[j], fract(f));
}
float bassLevel() { return u_hasStems > 0.5 ? u_stems.z : bandAt(0.05); }
float midLevel() { return bandAt(0.45); }
float highLevel() { return bandAt(0.9); }
float vocalLevel() { return u_hasStems > 0.5 ? u_stems.x : 0.5 * (bandAt(0.35) + bandAt(0.55)); }
float drumHit() { return u_hasStems > 0.5 ? max(u_stemOnsets.y, 0.7 * u_beat) : max(u_onset, u_beat); }`
