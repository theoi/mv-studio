/**
 * Synthetic benchmark media made in the browser (no files needed): a beat-driven song as WAV and moving test-pattern
 * videos encoded to H.264 MP4 with mediabunny. Used by the ?bench=1 page so anyone can benchmark their machine.
 */
import { BufferTarget, CanvasSource, Mp4OutputFormat, Output } from 'mediabunny'

/** 120 BPM kick on every beat over a three-note pad, stereo 48 kHz 16-bit WAV. */
export function syntheticSong(seconds: number): Blob {
  const rate = 48_000
  const frames = Math.round(seconds * rate)
  const data = new DataView(new ArrayBuffer(44 + frames * 4))
  const text = (offset: number, s: string) =>
    [...s].forEach((c, i) => data.setUint8(offset + i, c.charCodeAt(0)))
  text(0, 'RIFF')
  data.setUint32(4, 36 + frames * 4, true)
  text(8, 'WAVEfmt ')
  data.setUint32(16, 16, true)
  data.setUint16(20, 1, true)
  data.setUint16(22, 2, true)
  data.setUint32(24, rate, true)
  data.setUint32(28, rate * 4, true)
  data.setUint16(32, 4, true)
  data.setUint16(34, 16, true)
  text(36, 'data')
  data.setUint32(40, frames * 4, true)
  for (let i = 0; i < frames; i++) {
    const t = i / rate
    const beat = t % 0.5
    const kick = 0.6 * Math.sin(2 * Math.PI * (45 + 120 * Math.exp(-25 * beat)) * t) * Math.exp(-7 * beat)
    const pad =
      0.1 *
      (Math.sin(2 * Math.PI * 220 * t) +
        Math.sin(2 * Math.PI * 277.2 * t) +
        Math.sin(2 * Math.PI * 329.6 * t))
    const v = Math.max(-1, Math.min(1, kick + pad)) * 32767
    data.setInt16(44 + i * 4, v, true)
    data.setInt16(46 + i * 4, v, true)
  }
  return new Blob([data.buffer], { type: 'audio/wav' })
}

/**
 * Moving gradient, shapes and a frame counter, so every frame differs, encoded as H.264 MP4. With `frameCode`, a strip
 * at the top encodes the frame number N in gray levels (left half (N % 16) * 16 + 8, right half floor(N / 16) * 16 + 8)
 * for measureCuts().
 */
export async function syntheticVideo(
  width: number,
  height: number,
  seconds: number,
  fps = 30,
  onProgress?: (fraction: number) => void,
  options: { frameCode?: boolean } = {},
): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas is not available')
  const target = new BufferTarget()
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target })
  const source = new CanvasSource(canvas, {
    codec: 'avc',
    bitrate: Math.round(width * height * fps * 0.1),
    keyFrameInterval: 1,
  })
  output.addVideoTrack(source, { frameRate: fps })
  await output.start()
  const frames = Math.round(seconds * fps)
  for (let i = 0; i < frames; i++) {
    const t = i / fps
    const g = ctx.createLinearGradient(0, 0, width, height)
    g.addColorStop(0, `hsl(${(t * 40) % 360} 70% 45%)`)
    g.addColorStop(1, `hsl(${(t * 40 + 160) % 360} 70% 25%)`)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, width, height)
    for (let k = 0; k < 6; k++) {
      const a = t * (0.6 + k * 0.2) + k
      ctx.fillStyle = `hsl(${k * 60} 90% 60% / 0.8)`
      ctx.beginPath()
      ctx.arc(
        width * (0.5 + 0.38 * Math.cos(a)),
        height * (0.5 + 0.38 * Math.sin(a * 1.3)),
        height * (0.05 + 0.02 * k),
        0,
        Math.PI * 2,
      )
      ctx.fill()
    }
    ctx.fillStyle = '#ffffff'
    ctx.font = `bold ${Math.round(height / 8)}px sans-serif`
    ctx.fillText(String(i), width * 0.05, height * 0.9)
    if (options.frameCode) {
      const strip = Math.max(8, Math.round(height * 0.06))
      const gray = (v: number) => `rgb(${v} ${v} ${v})`
      ctx.fillStyle = gray((i % 16) * 16 + 8)
      ctx.fillRect(0, 0, width / 2, strip)
      ctx.fillStyle = gray(Math.floor(i / 16) * 16 + 8)
      ctx.fillRect(width / 2, 0, width / 2, strip)
    }
    await source.add(t, 1 / fps)
    if (i % 10 === 0) onProgress?.(i / frames)
  }
  source.close()
  await output.finalize()
  if (!target.buffer) throw new Error('Video encoding produced no data')
  return new Blob([target.buffer], { type: 'video/mp4' })
}
