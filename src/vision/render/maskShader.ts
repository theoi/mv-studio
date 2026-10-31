import { JobError } from '../../shared/jobs.ts'
import { DEFAULT_UPSAMPLE, type UpsampleOptions } from '../mask/upsample.ts'
import type { Mask } from '../types.ts'

/**
 * GPU counterpart of `jointBilateralUpsample`: refines a low-resolution soft mask to the
 * output resolution using the frame itself as the guide, so the cutout edge follows hair
 * and clothing edges. Preview and export composite with the same function and parameters.
 *
 * Embedding contract: declare the uniforms below, then call `refinedMask(frame, uv)`.
 * `u_guideLod` should be log2(frame size / mask size) when the frame texture has mipmaps
 * (closest to the CPU's area-averaged guide); without mipmaps it is ignored.
 */
export const MASK_REFINE_GLSL = /* glsl */ `
uniform sampler2D u_mask;
uniform vec2 u_maskSize;
uniform float u_guideLod;
uniform float u_inv2SigmaSpatial2;
uniform float u_inv2SigmaColor2;

float refinedMask(sampler2D frame, vec2 uv) {
  vec3 c = texture(frame, uv).rgb * 255.0;
  vec2 p = uv * u_maskSize - 0.5;
  vec2 base = floor(p) - 1.0;
  float sum = 0.0;
  float wsum = 0.0;
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      vec2 q = base + vec2(float(i), float(j));
      vec2 quv = (clamp(q, vec2(0.0), u_maskSize - 1.0) + 0.5) / u_maskSize;
      vec3 g = textureLod(frame, quv, u_guideLod).rgb * 255.0;
      vec2 d = q - p;
      vec3 dc = c - g;
      float w = exp(-dot(d, d) * u_inv2SigmaSpatial2 - dot(dc, dc) * u_inv2SigmaColor2);
      sum += texture(u_mask, quv).r * w;
      wsum += w;
    }
  }
  return wsum > 1e-8 ? sum / wsum : texture(u_mask, uv).r;
}
`

/** Uniform values matching the CPU defaults; the window is fixed at 4×4 (radius 2). */
export function maskRefineUniforms(
  maskSize: { width: number; height: number },
  frameSize: { width: number; height: number },
  options: UpsampleOptions = {},
) {
  const { sigmaSpatial, sigmaColor } = { ...DEFAULT_UPSAMPLE, ...options }
  return {
    u_maskSize: [maskSize.width, maskSize.height] as const,
    u_guideLod: Math.max(
      0,
      Math.log2(Math.max(frameSize.width / maskSize.width, frameSize.height / maskSize.height)),
    ),
    u_inv2SigmaSpatial2: 1 / (2 * sigmaSpatial * sigmaSpatial),
    // Per-channel sigma: the CPU sums squared differences over three channels.
    u_inv2SigmaColor2: 1 / (2 * sigmaColor * sigmaColor * 3),
  }
}

const VERTEX = /* glsl */ `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  // Canvas convention: the top row of the output samples v = 0 (the frame's first row).
  v_uv = vec2(p.x * 0.5, 1.0 - p.y * 0.5);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_frame;
uniform int u_mode;
${MASK_REFINE_GLSL}
in vec2 v_uv;
out vec4 outColor;
void main() {
  float a = refinedMask(u_frame, v_uv);
  if (u_mode == 0) {
    outColor = vec4(a, a, a, 1.0);
  } else {
    outColor = vec4(texture(u_frame, v_uv).rgb * a, a);
  }
}`

export type MaskRefineMode = 'alpha' | 'cutout'

export interface MaskRefinePass {
  /** Uploads a CPU mask into the pass's R8 mask texture. */
  setMask(mask: Mask): void
  /**
   * Draws into the bound framebuffer/viewport: 'alpha' writes the refined mask as grey,
   * 'cutout' writes the premultiplied subject (frame × mask) for drawing over text layers.
   * `frame` must use texture coordinates with v = 0 at the top row (UNPACK_FLIP_Y false).
   */
  render(
    frame: WebGLTexture,
    frameSize: { width: number; height: number },
    mode?: MaskRefineMode,
    options?: UpsampleOptions,
  ): void
  dispose(): void
}

export function createMaskRefinePass(gl: WebGL2RenderingContext): MaskRefinePass {
  const program = link(gl, VERTEX, FRAGMENT)
  const vao = gl.createVertexArray()
  const maskTex = gl.createTexture()
  if (!vao || !maskTex) throw new JobError('unsupported', 'Could not allocate WebGL resources.')
  gl.bindTexture(gl.TEXTURE_2D, maskTex)
  for (const [k, v] of [
    [gl.TEXTURE_MIN_FILTER, gl.NEAREST],
    [gl.TEXTURE_MAG_FILTER, gl.NEAREST],
    [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
    [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
  ] as const)
    gl.texParameteri(gl.TEXTURE_2D, k, v)
  let maskSize = { width: 1, height: 1 }
  const loc = (name: string) => gl.getUniformLocation(program, name)
  const u = {
    frame: loc('u_frame'),
    mask: loc('u_mask'),
    mode: loc('u_mode'),
    maskSize: loc('u_maskSize'),
    guideLod: loc('u_guideLod'),
    spatial: loc('u_inv2SigmaSpatial2'),
    color: loc('u_inv2SigmaColor2'),
  }
  return {
    setMask(mask) {
      gl.bindTexture(gl.TEXTURE_2D, maskTex)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, mask.width, mask.height, 0, gl.RED, gl.UNSIGNED_BYTE, mask.data)
      maskSize = { width: mask.width, height: mask.height }
    },
    render(frame, frameSize, mode = 'alpha', options = {}) {
      const values = maskRefineUniforms(maskSize, frameSize, options)
      gl.useProgram(program)
      gl.bindVertexArray(vao)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, frame)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, maskTex)
      gl.uniform1i(u.frame, 0)
      gl.uniform1i(u.mask, 1)
      gl.uniform1i(u.mode, mode === 'alpha' ? 0 : 1)
      gl.uniform2f(u.maskSize, values.u_maskSize[0], values.u_maskSize[1])
      gl.uniform1f(u.guideLod, values.u_guideLod)
      gl.uniform1f(u.spatial, values.u_inv2SigmaSpatial2)
      gl.uniform1f(u.color, values.u_inv2SigmaColor2)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      gl.bindVertexArray(null)
      gl.activeTexture(gl.TEXTURE0)
    },
    dispose() {
      gl.deleteProgram(program)
      gl.deleteVertexArray(vao)
      gl.deleteTexture(maskTex)
    },
  }
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram()
  if (!program) throw new JobError('unsupported', 'Could not create a WebGL program.')
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const shader = gl.createShader(type)
    if (!shader) throw new JobError('unsupported', 'Could not create a WebGL shader.')
    gl.shaderSource(shader, src)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new JobError('unsupported', `Mask shader failed to compile: ${gl.getShaderInfoLog(shader)}`)
    gl.attachShader(program, shader)
    gl.deleteShader(shader)
  }
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new JobError('unsupported', `Mask shader failed to link: ${gl.getProgramInfoLog(program)}`)
  return program
}
