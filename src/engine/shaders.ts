/** Built-in GLSL ES 3.00 shaders and the plugin shader templates. */
import type { ColorAdjustmentKey } from '../model/types.ts'
import type { ParamSpec } from './types.ts'

/** Full-screen pass. v_uv has a bottom-left origin, matching render-target textures. */
export const FULLSCREEN_VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos;
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
}`

/**
 * Transformed layer quad. u_m maps the unit square (top-left origin) to canvas pixels (top-left origin). DOM sources
 * are uploaded with row 0 at v = 0, so the unit coordinate is also the source texture coordinate.
 */
export const LAYER_VS = `#version 300 es
in vec2 a_pos;
uniform mat3 u_m;
uniform vec2 u_canvas;
uniform vec4 u_crop;
out vec2 v_uv;
void main() {
  vec3 p = u_m * vec3(a_pos, 1.0);
  v_uv = u_crop.xy + a_pos * u_crop.zw;
  gl_Position = vec4(p.x / u_canvas.x * 2.0 - 1.0, 1.0 - p.y / u_canvas.y * 2.0, 0.0, 1.0);
}`

export const LAYER_TEXTURE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform int u_flipY;
uniform float u_opacity;
out vec4 outColor;
void main() {
  vec2 uv = u_flipY == 1 ? vec2(v_uv.x, 1.0 - v_uv.y) : v_uv;
  outColor = texture(u_tex, uv) * u_opacity;
}`

export const LAYER_SOLID_FS = `#version 300 es
precision highp float;
uniform vec4 u_color;
uniform float u_opacity;
out vec4 outColor;
void main() {
  outColor = vec4(u_color.rgb * u_color.a, u_color.a) * u_opacity;
}`

export const COPY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 outColor;
void main() {
  outColor = texture(u_tex, v_uv);
}`

/**
 * Tone helpers shared by the finish pass and grading effects, so grades roll off instead of clipping:
 * `contrastCurve` is an S-curve that keeps black, white and fully saturated colors fixed, and `fitGamut` brings a
 * color into 0..1 by pulling its chroma toward its luma (hue and luma kept) instead of clamping channel by channel.
 */
export const TONE_GLSL = `
const vec3 LUMA_709 = vec3(0.2126, 0.7152, 0.0722);

/** How far the chroma of c reaches toward the edge of 0..1 from luma l (1 = on the edge). */
float gamutReach(vec3 c, float l) {
  float hi = max(c.r, max(c.g, c.b));
  float lo = min(c.r, min(c.g, c.b));
  return max(hi > l ? (hi - l) / max(1.0 - l, 1e-5) : 0.0, lo < l ? (l - lo) / max(l, 1e-5) : 0.0);
}

/**
 * The reach where gamut roll-off starts for a pixel whose source color is src: at least the source's own reach, so a
 * grade that does not push a color further leaves it untouched.
 */
float gamutKnee(vec3 src) {
  vec3 s = clamp(src, 0.0, 1.0);
  return clamp(gamutReach(s, dot(s, LUMA_709)), 0.9, 0.995);
}

vec3 fitGamut(vec3 c, float knee) {
  float l0 = dot(c, LUMA_709);
  float l = clamp(l0, 0.0, 1.0);
  vec3 chroma = c - l0;
  float r = gamutReach(l + chroma, l);
  if (r <= knee) return l + chroma;
  float x = (r - knee) / (1.0 - knee);
  return l + chroma * ((knee + (1.0 - knee) * x / (1.0 + x)) / r);
}

/**
 * Brings a color pushed past white back under it by its brightest channel, so it keeps its hue and saturation (a
 * brightened pure green stays green), and eases it toward white only as it goes further past, as film highlights do.
 */
vec3 fitBright(vec3 c) {
  float hi = max(c.r, max(c.g, c.b));
  float over = max(hi - 1.0, 0.0);
  return mix(c / max(hi, 1.0), vec3(1.0), over / (over + 3.0));
}

/** S-curve with slope k > 1 at pivot p that flattens into 0 and 1, for two values at once. */
vec2 sCurve(vec2 x, float k, float p) {
  x = clamp(x, 0.0, 1.0);
  vec2 below = vec2(lessThan(x, vec2(p)));
  vec2 y = pow(mix((1.0 - x) / (1.0 - p), x / p, below), vec2(k));
  return mix(1.0 - (1.0 - p) * y, p * y, below);
}

/**
 * Contrast k around pivot p. Above 1 the brightest and darkest channels follow an S-curve that flattens into black
 * and white, so shadows and highlights compress instead of clipping and midtone colors gain saturation as under a
 * per-channel curve. The middle channel keeps its place between them, so the hue is kept, and a color with a channel
 * at 1 and one at 0 (primaries, secondaries) is unchanged. A color outside 0..1 first moves toward its luma until it
 * fits. Below 1 it fades linearly toward the pivot.
 */
vec3 contrastCurve(vec3 c, float k, float p) {
  if (k <= 1.0) return (c - p) * k + p;
  float l0 = dot(c, LUMA_709);
  float l = clamp(l0, 0.0, 1.0);
  // Brightest and darkest channel relative to luma, and how far past the edge of 0..1 they reach.
  vec2 range = vec2(max(c.r, max(c.g, c.b)), min(c.r, min(c.g, c.b))) - l0;
  float reach = max(range.x / max(1.0 - l, 1e-5), -range.y / max(l, 1e-5));
  vec2 m = sCurve(l + range / max(reach, 1.0), k, p);
  return m.y + (m.x - m.y) * (c - l0 - range.y) / max(range.x - range.y, 1e-5);
}
`
/**
 * Color adjustments, matte and opacity in one pass over a premultiplied layer. Contrast above 0 is an S-curve and
 * below 0 a fade (to 40% at -1, so the extreme stays usable). Colors pushed past white keep their hue and saturation
 * and ease toward white, other out-of-range colors roll off toward their luma, so no setting clips channels or shifts
 * hue, and neutral settings leave the layer unchanged. CURVE (contrast above 0), COLOR
 * (brightness, temperature, tint, hue, saturation) and HUE compile in only the adjustments a layer uses, see
 * `finishShader`.
 */
const FINISH_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform sampler2D u_matte;
uniform int u_matteMode;
uniform float u_feather;
uniform float u_opacity;
uniform int u_adjust;
uniform float u_exposure;
uniform float u_brightness;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_temperature;
uniform float u_tint;
uniform float u_hue;
out vec4 outColor;
${TONE_GLSL}
/**
 * Rotates the hue of c by angle a in the BT.709 Cb/Cr plane, which keeps luma. Where the rotated color leaves 0..1
 * (beyond where c already was), it keeps its hue and chroma and gives up luma instead: lifted out of the negatives,
 * then scaled under the top. So a saturated blue turns violet, or yellow halfway round, instead of dark and gray.
 */
vec3 hueRotate(vec3 c, float a) {
  float lo0 = min(min(c.r, min(c.g, c.b)), 0.0);
  float hi0 = max(max(c.r, max(c.g, c.b)), 1.0);
  float y = dot(c, LUMA_709);
  vec2 cbcr = mat2(cos(a), sin(a), -sin(a), cos(a)) * vec2((c.b - y) / 1.8556, (c.r - y) / 1.5748);
  float r = y + 1.5748 * cbcr.y;
  float b = y + 1.8556 * cbcr.x;
  c = vec3(r, (y - 0.2126 * r - 0.0722 * b) / 0.7152, b);
  c -= min(min(c.r, min(c.g, c.b)) - lo0, 0.0);
  return c * (hi0 / max(max(c.r, max(c.g, c.b)), hi0));
}

void main() {
  vec4 c = texture(u_tex, v_uv);
  if (u_adjust == 1 && c.a > 0.0) {
    vec3 rgb = c.rgb / c.a;
#ifdef COLOR
    float knee = gamutKnee(rgb);
#endif
    rgb *= exp2(u_exposure * 2.0);
#ifdef COLOR
    rgb += u_brightness * 0.5;
#endif
    // Contrast and fade keep colors in 0..1, so without COLOR this is the only fitting needed.
    rgb = fitBright(rgb);
#ifdef CURVE
    rgb = contrastCurve(rgb, 1.0 + u_contrast, 0.5);
#else
    rgb = (rgb - 0.5) * (1.0 + 0.6 * min(u_contrast, 0.0)) + 0.5;
#endif
#ifdef COLOR
    rgb += vec3(u_temperature, 0.0, -u_temperature) * 0.15 + vec3(0.0, u_tint, 0.0) * 0.15;
#ifdef HUE
    rgb = hueRotate(rgb, u_hue * 3.14159265);
#endif
    float l = dot(rgb, LUMA_709);
    rgb = fitGamut(mix(vec3(l), rgb, 1.0 + u_saturation), knee);
#endif
    c = vec4(clamp(rgb, 0.0, 1.0) * c.a, c.a);
  }
  if (u_matteMode != 0) {
    float m = texture(u_matte, v_uv).r;
    float lo = 0.5 - u_feather * 0.5;
    float hi = 0.5 + u_feather * 0.5 + 1e-4;
    m = smoothstep(lo, hi, m);
    if (u_matteMode == 2) m = 1.0 - m;
    c *= m;
  }
  outColor = c * u_opacity;
}`

const FINISH_CURVE = 1
const FINISH_COLOR = 2
const FINISH_HUE = 4

/** The finish-pass variant for a layer's adjustments (null when it has none), a key for `finishShader`. */
export function finishVariant(adjust: Readonly<Record<ColorAdjustmentKey, number>> | null): number {
  if (!adjust) return 0
  const color = adjust.brightness || adjust.saturation || adjust.temperature || adjust.tint || adjust.hue
  return (adjust.contrast > 0 ? FINISH_CURVE : 0) | (color ? FINISH_COLOR : 0) | (adjust.hue ? FINISH_HUE : 0)
}

/**
 * The finish pass with only the adjustment code a variant needs. Uniform branches would leave one program, but
 * SwiftShader (software WebGL) still pays for the code it skips: on exposure alone, about as much as the soft gamut
 * knee and the contrast curve cost.
 */
export function finishShader(variant: number): string {
  const names: [number, string][] = [
    [FINISH_CURVE, 'CURVE'],
    [FINISH_COLOR, 'COLOR'],
    [FINISH_HUE, 'HUE'],
  ]
  const defines = names.map(([bit, name]) => (variant & bit ? `#define ${name}\n` : '')).join('')
  return FINISH_FS.replace('#version 300 es\n', `#version 300 es\n${defines}`)
}
/** Blend a premultiplied source layer over a premultiplied destination (W3C compositing and blending). */
export const BLEND_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_dst;
uniform sampler2D u_src;
uniform int u_mode;
out vec4 outColor;

float softLight(float cs, float cd) {
  if (cs <= 0.5) return cd - (1.0 - 2.0 * cs) * cd * (1.0 - cd);
  float d = cd <= 0.25 ? ((16.0 * cd - 12.0) * cd + 4.0) * cd : sqrt(cd);
  return cd + (2.0 * cs - 1.0) * (d - cd);
}
float hardLight(float cs, float cd) {
  return cs <= 0.5 ? cd * 2.0 * cs : 1.0 - (1.0 - cd) * (1.0 - (2.0 * cs - 1.0));
}
float colorDodge(float cs, float cd) {
  if (cd == 0.0) return 0.0;
  if (cs >= 1.0) return 1.0;
  return min(1.0, cd / (1.0 - cs));
}
float colorBurn(float cs, float cd) {
  if (cd >= 1.0) return 1.0;
  if (cs <= 0.0) return 0.0;
  return 1.0 - min(1.0, (1.0 - cd) / cs);
}
vec3 blendFn(vec3 cs, vec3 cd) {
  if (u_mode == 1) return cs * cd;
  if (u_mode == 2) return cs + cd - cs * cd;
  if (u_mode == 3) return vec3(hardLight(cd.r, cs.r), hardLight(cd.g, cs.g), hardLight(cd.b, cs.b));
  if (u_mode == 5) return min(cs, cd);
  if (u_mode == 6) return max(cs, cd);
  if (u_mode == 7) return vec3(softLight(cs.r, cd.r), softLight(cs.g, cd.g), softLight(cs.b, cd.b));
  if (u_mode == 8) return vec3(hardLight(cs.r, cd.r), hardLight(cs.g, cd.g), hardLight(cs.b, cd.b));
  if (u_mode == 9) return abs(cs - cd);
  if (u_mode == 10) return vec3(colorDodge(cs.r, cd.r), colorDodge(cs.g, cd.g), colorDodge(cs.b, cd.b));
  if (u_mode == 11) return vec3(colorBurn(cs.r, cd.r), colorBurn(cs.g, cd.g), colorBurn(cs.b, cd.b));
  return cs;
}
void main() {
  vec4 d = texture(u_dst, v_uv);
  vec4 s = texture(u_src, v_uv);
  float a = s.a + d.a * (1.0 - s.a);
  if (u_mode == 4) {
    outColor = vec4(min(s.rgb + d.rgb, vec3(1.0)), a);
    return;
  }
  vec3 cs = s.a > 0.0 ? s.rgb / s.a : vec3(0.0);
  vec3 cd = d.a > 0.0 ? d.rgb / d.a : vec3(0.0);
  vec3 rgb = s.rgb * (1.0 - d.a) + d.rgb * (1.0 - s.a) + s.a * d.a * clamp(blendFn(cs, cd), 0.0, 1.0);
  outColor = vec4(rgb, a);
}`

export const BLEND_MODE_INDEX: Record<string, number> = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  add: 4,
  darken: 5,
  lighten: 6,
  'soft-light': 7,
  'hard-light': 8,
  difference: 9,
  'color-dodge': 10,
  'color-burn': 11,
}

/** Uniforms every plugin shader gets, in addition to u_<param> uniforms declared from its ParamSpecs. */
const PLUGIN_COMMON = `uniform vec2 u_resolution;
uniform float u_time;
uniform float u_loudness;
uniform float u_beat;
uniform float u_onset;
uniform float u_downbeat;
uniform float u_bands[16];
uniform float u_bandCount;
uniform float u_beatIndex;
uniform float u_beatPhase;
uniform float u_barIndex;
uniform float u_barPhase;
uniform float u_flow;
uniform vec4 u_stems;
uniform vec4 u_stemOnsets;
uniform float u_hasStems;`

function paramUniforms(params: ParamSpec[]): string {
  return params
    .map((p) =>
      p.type === 'color'
        ? `uniform vec4 u_${p.key};`
        : p.type === 'image'
          ? `uniform sampler2D u_${p.key};\nuniform vec2 u_${p.key}Size;`
          : `uniform float u_${p.key};`,
    )
    .join('\n')
}

/**
 * Effects define `vec4 mainImage(vec2 uv)` and sample the layer with `texture(u_input, uv)` (premultiplied). `inputs`
 * are earlier passes of a multi-pass effect, declared as u_<id> and u_<id>Size.
 */
export function effectShader(params: ParamSpec[], body: string, inputs: readonly string[] = []): string {
  const passUniforms = inputs.map((id) => `uniform sampler2D u_${id};\nuniform vec2 u_${id}Size;`).join('\n')
  return `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_input;
uniform mat3 u_canvasToLayer;
uniform mat3 u_layerToCanvas;
${PLUGIN_COMMON}
${paramUniforms(params)}
${passUniforms}
${body}
void main() { outColor = mainImage(v_uv); }`
}

/** Transitions define `vec4 transition(vec2 uv)` using u_from, u_to (premultiplied) and u_progress (0..1, eased). */
export function transitionShader(params: ParamSpec[], body: string): string {
  return `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_from;
uniform sampler2D u_to;
uniform float u_progress;
${PLUGIN_COMMON}
${paramUniforms(params)}
${body}
void main() { outColor = transition(v_uv); }`
}

/** Generators define `vec4 mainImage(vec2 uv)` and return premultiplied color. */
export function generatorShader(params: ParamSpec[], body: string): string {
  return `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
${PLUGIN_COMMON}
${paramUniforms(params)}
${body}
void main() { outColor = mainImage(v_uv); }`
}
