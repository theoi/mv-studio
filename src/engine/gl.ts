/** Small WebGL2 helpers: programs, textures, render targets and a full-screen quad. */

export type GL = WebGL2RenderingContext

export interface RenderTarget {
  fbo: WebGLFramebuffer
  texture: WebGLTexture
  width: number
  height: number
}

export interface Program {
  program: WebGLProgram
  uniform(name: string): WebGLUniformLocation | null
}

function compile(gl: GL, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('createShader failed')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? ''
    gl.deleteShader(shader)
    throw new Error(`Shader compile error: ${log}`)
  }
  return shader
}

export function createProgram(gl: GL, vertex: string, fragment: string): Program {
  const program = gl.createProgram()
  if (!program) throw new Error('createProgram failed')
  const vs = compile(gl, gl.VERTEX_SHADER, vertex)
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment)
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.bindAttribLocation(program, 0, 'a_pos')
  gl.linkProgram(program)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(`Program link error: ${gl.getProgramInfoLog(program)}`)
  const cache = new Map<string, WebGLUniformLocation | null>()
  return {
    program,
    uniform(name) {
      if (!cache.has(name)) cache.set(name, gl.getUniformLocation(program, name))
      return cache.get(name) ?? null
    },
  }
}

export function createTexture(gl: GL): WebGLTexture {
  const tex = gl.createTexture()
  if (!tex) throw new Error('createTexture failed')
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return tex
}

/** Uploads a DOM image source (video frame, canvas, bitmap) with premultiplied alpha. Row 0 = top = v 0. */
export function uploadSource(gl: GL, tex: WebGLTexture, source: TexImageSource): void {
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
}

export function createTarget(gl: GL, width: number, height: number): RenderTarget {
  const texture = createTexture(gl)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  const fbo = gl.createFramebuffer()
  if (!fbo) throw new Error('createFramebuffer failed')
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  return { fbo, texture, width, height }
}

export function deleteTarget(gl: GL, t: RenderTarget): void {
  gl.deleteFramebuffer(t.fbo)
  gl.deleteTexture(t.texture)
}

/** Reusable render targets, canvas-sized unless a size is given; acquire() per pass, releaseAll() at frame end. */
export class TargetPool {
  private free: RenderTarget[] = []
  private used: RenderTarget[] = []
  private width = 0
  private height = 0
  private readonly gl: GL

  constructor(gl: GL) {
    this.gl = gl
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return
    for (const t of [...this.free, ...this.used]) deleteTarget(this.gl, t)
    this.free = []
    this.used = []
    this.width = width
    this.height = height
  }

  acquire(width = this.width, height = this.height): RenderTarget {
    const i = this.free.findIndex((t) => t.width === width && t.height === height)
    const t = i >= 0 ? this.free.splice(i, 1)[0]! : createTarget(this.gl, width, height)
    this.used.push(t)
    return t
  }

  release(t: RenderTarget): void {
    const i = this.used.indexOf(t)
    if (i >= 0) {
      this.used.splice(i, 1)
      this.free.push(t)
    }
  }

  releaseAll(): void {
    this.free.push(...this.used)
    this.used = []
  }

  dispose(): void {
    this.resize(0, 0)
  }
}

/** A VAO holding the unit square as a triangle strip at attribute 0. */
export function createUnitQuad(gl: GL): WebGLVertexArrayObject {
  const vao = gl.createVertexArray()
  const buf = gl.createBuffer()
  if (!vao || !buf) throw new Error('VAO creation failed')
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
  gl.bindVertexArray(null)
  return vao
}
