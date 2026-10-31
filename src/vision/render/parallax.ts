import { JobError } from '../../shared/jobs.ts'
import type { CameraPose, DepthMap, Size } from '../types.ts'

/**
 * 2.5D parallax renderer: one full-screen pass that re-projects an image through its depth map with
 * parallax occlusion mapping. The shader sources and uniform contract are exported so the engine
 * compositor can embed the same pass in its own WebGL2 pipeline; `createParallaxRenderer` is a
 * self-contained wrapper that also works on an OffscreenCanvas inside a worker.
 *
 * Geometry (all coordinates normalized, y down, matching `requiredZoom` in camera.ts):
 *   p = 0.5 + (uv - 0.5) * uvScale / zoom - pan          image point before parallax
 *   v = offset + (p - 0.5) * dolly                         parallax direction at depth 1
 *   a surface point at depth d appears at p when it is sampled at q = p - v * (d - focus)
 * The ray march walks the depth layers h from 1 (near) down to 0 (far) along q(h) = p - v * (h - focus) and
 * stops at the first layer the depth map reaches, so near content occludes far content.
 */

export const PARALLAX_MIN_STEPS = 16
export const PARALLAX_MAX_STEPS = 48

export const PARALLAX_VERTEX_SHADER = `#version 300 es
out vec2 v_uv;
void main() {
  // Full-screen triangle from gl_VertexID 0..2, no vertex buffers needed.
  vec2 pos = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = vec2(pos.x, 1.0 - pos.y);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}
`

export const PARALLAX_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D u_image;
uniform sampler2D u_depth;
uniform vec2 u_uvScale;
uniform float u_zoom;
uniform vec2 u_pan;
uniform vec2 u_offset;
uniform float u_dolly;
uniform float u_focus;
uniform vec2 u_depthSize;

in vec2 v_uv;
out vec4 outColor;

const int MIN_STEPS = ${PARALLAX_MIN_STEPS};
const int MAX_STEPS = ${PARALLAX_MAX_STEPS};

float depthAt(vec2 q) {
  return textureLod(u_depth, q, 0.0).r;
}

void main() {
  vec2 p = 0.5 + (v_uv - 0.5) * u_uvScale / u_zoom - u_pan;
  vec2 v = u_offset + (p - 0.5) * u_dolly;
  // One step per depth texel along the whole ray, so thin near features are not stepped over.
  float rayTexels = length(v * u_depthSize);
  int steps = int(clamp(ceil(rayTexels), float(MIN_STEPS), float(MAX_STEPS)));
  float dh = 1.0 / float(steps);

  float h = 1.0;
  float d = depthAt(p - v * (h - u_focus));
  float prevH = h;
  float prevD = d;
  for (int i = 0; i < MAX_STEPS; i++) {
    if (d >= h || i >= steps) break;
    prevH = h;
    prevD = d;
    h -= dh;
    d = depthAt(p - v * (h - u_focus));
  }

  // Linear refinement between the last layer above the surface and the first one at or below it.
  float hit = h;
  float above = prevD - prevH;
  float below = d - h;
  if (above < 0.0 && above - below < 0.0) hit = mix(prevH, h, clamp(above / (above - below), 0.0, 1.0));

  vec2 q = clamp(p - v * (hit - u_focus), 0.0, 1.0);
  // The image texture holds premultiplied alpha, so filtering and the output stay premultiplied.
  outColor = textureLod(u_image, q, 0.0);
}
`

/** Uniform names of the parallax pass. Samplers: `u_image` (premultiplied RGBA), `u_depth` (R8, 0 far .. 1 near). */
export const PARALLAX_UNIFORMS = {
  image: 'u_image',
  depth: 'u_depth',
  uvScale: 'u_uvScale',
  zoom: 'u_zoom',
  pan: 'u_pan',
  offset: 'u_offset',
  dolly: 'u_dolly',
  focus: 'u_focus',
  depthSize: 'u_depthSize',
} as const

export interface ParallaxUniformValues {
  u_uvScale: [number, number]
  u_zoom: number
  u_pan: [number, number]
  u_offset: [number, number]
  u_dolly: number
  u_focus: number
  u_depthSize: [number, number]
}

/**
 * Uniform values for a pose. The image covers the output (centre crop) when their aspects differ; both
 * textures use LINEAR filtering and CLAMP_TO_EDGE wrapping.
 */
export function parallaxUniformValues(
  pose: CameraPose,
  imageSize: Size,
  outputSize: Size,
  depthSize: Size,
): ParallaxUniformValues {
  const imageAspect = imageSize.width / imageSize.height
  const outputAspect = outputSize.width / outputSize.height
  const uvScale: [number, number] =
    outputAspect > imageAspect ? [1, imageAspect / outputAspect] : [outputAspect / imageAspect, 1]
  return {
    u_uvScale: uvScale,
    u_zoom: Math.max(1, pose.zoom),
    u_pan: [pose.panX ?? 0, pose.panY ?? 0],
    u_offset: [pose.offsetX, pose.offsetY],
    u_dolly: pose.dolly ?? 0,
    u_focus: Math.min(1, Math.max(0, pose.focus)),
    u_depthSize: [depthSize.width, depthSize.height],
  }
}

export interface ParallaxRenderer {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas
  /** Uploads the colour frame. Sources with alpha should not already be premultiplied (ImageBitmap default is fine). */
  setImage(source: TexImageSource): void
  setDepth(depth: DepthMap): void
  /**
   * Draws one frame, resizing the canvas to `size` when given. Throws JobError 'unsupported' while the
   * WebGL context is lost; the renderer restores its resources when the browser restores the context.
   */
  render(pose: CameraPose, size?: { width: number; height: number }): void
  dispose(): void
}

type Canvas = HTMLCanvasElement | OffscreenCanvas

interface GlResources {
  program: WebGLProgram
  vao: WebGLVertexArrayObject
  imageTex: WebGLTexture
  depthTex: WebGLTexture
  locations: Record<keyof typeof PARALLAX_UNIFORMS, WebGLUniformLocation | null>
}

export function createParallaxRenderer(canvas?: Canvas): ParallaxRenderer {
  const ownsCanvas = !canvas
  const target = canvas ?? defaultCanvas()
  const context = getWebGl2(target)
  if (!context) throw new JobError('unsupported', 'WebGL2 is not available.')
  const gl: WebGL2RenderingContext = context

  let resources: GlResources | null = createResources(gl)
  let lost = false
  let disposed = false
  let imageSource: TexImageSource | null = null
  let imageSize: Size | null = null
  let depth: DepthMap | null = null

  const onLost = (event: Event) => {
    event.preventDefault()
    lost = true
    resources = null
  }
  const onRestored = () => {
    lost = false
    try {
      resources = createResources(gl)
      if (depth) uploadDepth(depth)
      // The source may be gone by now (a closed VideoFrame); the caller sets the next frame anyway.
      if (imageSource) uploadImage(imageSource, true)
    } catch {
      imageSource = null
      imageSize = null
    }
  }
  target.addEventListener('webglcontextlost', onLost)
  target.addEventListener('webglcontextrestored', onRestored)

  function live(): GlResources {
    if (disposed) throw new JobError('invalid-input', 'The parallax renderer was disposed.')
    if (lost || !resources || gl.isContextLost())
      throw new JobError('unsupported', 'The WebGL context was lost.')
    return resources
  }

  function uploadImage(source: TexImageSource, forceRealloc: boolean): void {
    const r = live()
    const size = texSourceSize(source)
    if (!(size.width > 0 && size.height > 0))
      throw new JobError('invalid-input', 'The image source has no pixels.')
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
    if (size.width > max || size.height > max)
      throw new JobError('invalid-input', `Image ${size.width}x${size.height} exceeds the GPU limit ${max}.`)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, r.imageTex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    if (!forceRealloc && imageSize && imageSize.width === size.width && imageSize.height === size.height) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source)
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source)
    }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    imageSize = size
  }

  function uploadDepth(map: DepthMap): void {
    const r = live()
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, r.depthTex)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, map.width, map.height, 0, gl.RED, gl.UNSIGNED_BYTE, map.data)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
  }

  return {
    canvas: target,
    setImage(source) {
      uploadImage(source, false)
      imageSource = source
    },
    setDepth(map) {
      if (!(map.width > 0 && map.height > 0) || map.data.length !== map.width * map.height) {
        throw new JobError(
          'invalid-input',
          `Depth data has ${map.data.length} values for ${map.width}x${map.height}.`,
        )
      }
      uploadDepth(map)
      depth = map
    },
    render(pose, size) {
      const r = live()
      if (!imageSize || !depth)
        throw new JobError('invalid-input', 'setImage and setDepth must be called before render.')
      if (size) {
        const width = Math.max(1, Math.round(size.width))
        const height = Math.max(1, Math.round(size.height))
        if (target.width !== width) target.width = width
        if (target.height !== height) target.height = height
      }
      const output = { width: target.width, height: target.height }
      const u = parallaxUniformValues(pose, imageSize, output, depth)
      const loc = r.locations
      gl.viewport(0, 0, output.width, output.height)
      gl.disable(gl.BLEND)
      gl.useProgram(r.program)
      gl.bindVertexArray(r.vao)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, r.imageTex)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, r.depthTex)
      gl.uniform1i(loc.image, 0)
      gl.uniform1i(loc.depth, 1)
      gl.uniform2f(loc.uvScale, u.u_uvScale[0], u.u_uvScale[1])
      gl.uniform1f(loc.zoom, u.u_zoom)
      gl.uniform2f(loc.pan, u.u_pan[0], u.u_pan[1])
      gl.uniform2f(loc.offset, u.u_offset[0], u.u_offset[1])
      gl.uniform1f(loc.dolly, u.u_dolly)
      gl.uniform1f(loc.focus, u.u_focus)
      gl.uniform2f(loc.depthSize, u.u_depthSize[0], u.u_depthSize[1])
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      gl.bindVertexArray(null)
    },
    dispose() {
      if (disposed) return
      disposed = true
      target.removeEventListener('webglcontextlost', onLost)
      target.removeEventListener('webglcontextrestored', onRestored)
      if (resources && !gl.isContextLost()) {
        gl.deleteTexture(resources.imageTex)
        gl.deleteTexture(resources.depthTex)
        gl.deleteVertexArray(resources.vao)
        gl.deleteProgram(resources.program)
      }
      resources = null
      imageSource = null
      depth = null
      // Free the GPU context right away instead of waiting for GC, but never for a caller-owned canvas.
      if (ownsCanvas) gl.getExtension('WEBGL_lose_context')?.loseContext()
    },
  }
}

function defaultCanvas(): Canvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(1, 1)
  if (typeof document !== 'undefined') return document.createElement('canvas')
  throw new JobError('unsupported', 'No canvas implementation is available.')
}

const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  premultipliedAlpha: true,
  antialias: false,
  depth: false,
  stencil: false,
  // The compositor may read the canvas after the task that rendered it (drawImage, VideoFrame, readback).
  preserveDrawingBuffer: true,
}

function getWebGl2(canvas: Canvas): WebGL2RenderingContext | null {
  try {
    const ctx = isHtmlCanvas(canvas)
      ? canvas.getContext('webgl2', CONTEXT_ATTRIBUTES)
      : canvas.getContext('webgl2', CONTEXT_ATTRIBUTES)
    return ctx ?? null
  } catch {
    return null
  }
}

function isHtmlCanvas(canvas: Canvas): canvas is HTMLCanvasElement {
  return typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement
}

function createResources(gl: WebGL2RenderingContext): GlResources {
  const program = linkProgram(gl, PARALLAX_VERTEX_SHADER, PARALLAX_FRAGMENT_SHADER)
  const vao = gl.createVertexArray()
  const imageTex = createTexture(gl)
  const depthTex = createTexture(gl)
  if (!vao) throw new JobError('unsupported', 'Could not create WebGL resources.')
  const u = PARALLAX_UNIFORMS
  const loc = (name: string) => gl.getUniformLocation(program, name)
  const locations: GlResources['locations'] = {
    image: loc(u.image),
    depth: loc(u.depth),
    uvScale: loc(u.uvScale),
    zoom: loc(u.zoom),
    pan: loc(u.pan),
    offset: loc(u.offset),
    dolly: loc(u.dolly),
    focus: loc(u.focus),
    depthSize: loc(u.depthSize),
  }
  return { program, vao, imageTex, depthTex, locations }
}

function createTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = gl.createTexture()
  if (!tex) throw new JobError('unsupported', 'Could not create a WebGL texture.')
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return tex
}

function linkProgram(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const program = gl.createProgram()
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertex)
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragment)
  if (!program) throw new JobError('unsupported', 'Could not create a WebGL program.')
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
    const log = gl.getProgramInfoLog(program)
    gl.deleteProgram(program)
    throw new JobError('unsupported', `Parallax shader failed to link: ${log ?? ''}`)
  }
  return program
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new JobError('unsupported', 'Could not create a WebGL shader.')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new JobError('unsupported', `Parallax shader failed to compile: ${log ?? ''}`)
  }
  return shader
}

function texSourceSize(source: TexImageSource): Size {
  if ('displayWidth' in source) return { width: source.displayWidth, height: source.displayHeight }
  if ('videoWidth' in source) return { width: source.videoWidth, height: source.videoHeight }
  if ('naturalWidth' in source) return { width: source.naturalWidth, height: source.naturalHeight }
  return { width: source.width, height: source.height }
}
