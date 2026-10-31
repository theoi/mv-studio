/** Built-in GLSL ES 3.00 shaders and the plugin shader templates. */
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

/** Color adjustments, matte and opacity in one pass over a premultiplied layer. */
export const FINISH_FS = `#version 300 es
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

vec3 hueRotate(vec3 c, float a) {
  const vec3 k = vec3(0.57735);
  float cosA = cos(a);
  return c * cosA + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cosA);
}

void main() {
  vec4 c = texture(u_tex, v_uv);
  if (u_adjust == 1 && c.a > 0.0) {
    vec3 rgb = c.rgb / c.a;
    rgb *= exp2(u_exposure * 2.0);
    rgb += u_brightness * 0.5;
    rgb = (rgb - 0.5) * (1.0 + u_contrast) + 0.5;
    rgb += vec3(u_temperature, 0.0, -u_temperature) * 0.15 + vec3(0.0, u_tint, 0.0) * 0.15;
    if (u_hue != 0.0) rgb = hueRotate(rgb, u_hue * 3.14159265);
    float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
    rgb = mix(vec3(l), rgb, 1.0 + u_saturation);
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

/** Effects define `vec4 mainImage(vec2 uv)` and sample the layer with `texture(u_input, uv)` (premultiplied). */
export function effectShader(params: ParamSpec[], body: string): string {
  return `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_input;
${PLUGIN_COMMON}
${paramUniforms(params)}
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
