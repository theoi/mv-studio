/*
 * Media bytes for the sample project. Its assets point at procedural scenes ('mock:<scene>'), so the real engine
 * gets generated files instead: a JPEG per still, a short video per video scene (the scene on every frame), a mask
 * image per scene with a subject ('mock-mask:<scene>') and a synthesized song. Each is made on first use and kept
 * for the session.
 */
import {
  BufferTarget,
  CanvasSource,
  Output,
  WebMOutputFormat,
  Mp4OutputFormat,
  canEncodeVideo,
} from 'mediabunny'
import type { Asset } from '../../model/index.ts'
import { sceneLayers, type SceneId } from './art.ts'
import { MASK_PREFIX } from './demoProject.ts'
import { synthesizeSong } from './sampleSong.ts'

const WIDTH = 1280
const HEIGHT = 720
/** The scenes are still, so a low frame rate is enough and keeps encoding fast. */
const VIDEO_FPS = 2

const SCENE_PREFIX = 'mock:'

export function isSampleAsset(asset: Asset): boolean {
  return asset.storageKey.startsWith(SCENE_PREFIX) || asset.storageKey.startsWith(MASK_PREFIX)
}

function sceneCanvas(scene: SceneId): HTMLCanvasElement {
  const { bg, fg } = sceneLayers(scene, WIDTH, HEIGHT)
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bg, 0, 0)
  if (fg) ctx.drawImage(fg, 0, 0)
  return canvas
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the image'))), type, quality),
  )
}

/** White where the scene's subject is, black elsewhere (the matte reads the red channel). */
function maskCanvas(scene: SceneId): HTMLCanvasElement {
  const { fg } = sceneLayers(scene, WIDTH, HEIGHT)
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT
  const ctx = canvas.getContext('2d')!
  if (fg) {
    ctx.drawImage(fg, 0, 0)
    ctx.globalCompositeOperation = 'source-in'
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, WIDTH, HEIGHT)
  }
  ctx.globalCompositeOperation = 'destination-over'
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, WIDTH, HEIGHT)
  return canvas
}

let videoCodec: Promise<'vp9' | 'vp8' | 'avc'> | null = null

function pickCodec() {
  videoCodec ??= (async () => {
    for (const codec of ['vp9', 'vp8'] as const)
      if (await canEncodeVideo(codec, { width: WIDTH, height: HEIGHT })) return codec
    return 'avc'
  })()
  return videoCodec
}

async function encodeStillVideo(canvas: HTMLCanvasElement, duration: number): Promise<Blob> {
  const codec = await pickCodec()
  const webm = codec !== 'avc'
  const target = new BufferTarget()
  const output = new Output({ format: webm ? new WebMOutputFormat() : new Mp4OutputFormat(), target })
  const source = new CanvasSource(canvas, {
    codec,
    bitrate: 3_000_000,
    keyFrameInterval: 4,
    latencyMode: 'realtime',
  })
  output.addVideoTrack(source, { frameRate: VIDEO_FPS })
  await output.start()
  const frames = Math.max(2, Math.ceil(duration * VIDEO_FPS))
  for (let i = 0; i < frames; i++) await source.add(i / VIDEO_FPS, 1 / VIDEO_FPS)
  source.close()
  await output.finalize()
  if (!target.buffer) throw new Error('Video encoding produced no data')
  return new Blob([target.buffer], { type: webm ? 'video/webm' : 'video/mp4' })
}

async function generate(asset: Asset): Promise<Blob> {
  const key = asset.storageKey
  if (key.startsWith(MASK_PREFIX))
    return toBlob(maskCanvas(key.slice(MASK_PREFIX.length) as SceneId), 'image/png')
  const scene = key.slice(SCENE_PREFIX.length)
  if (asset.kind === 'audio') return synthesizeSong()
  const canvas = sceneCanvas(scene as SceneId)
  if (asset.kind === 'video') return encodeStillVideo(canvas, asset.duration ?? 10)
  return toBlob(canvas, 'image/jpeg', 0.92)
}

const cache = new Map<string, Promise<Blob>>()

function fileKey(asset: Asset): string {
  return `${asset.kind}:${asset.storageKey}:${asset.duration ?? ''}`
}

/** The generated file for a sample asset, made once per storage key and kind. */
export function sampleFile(asset: Asset): Promise<Blob> {
  const key = fileKey(asset)
  let file = cache.get(key)
  if (!file) {
    file = generate(asset)
    file.catch(() => cache.delete(key))
    cache.set(key, file)
  }
  return file
}

const queued = new Set<string>()
const toPrepare: Asset[] = []

/**
 * Makes the sample videos among `assets` ahead of their first use, one at a time while the page is idle. Encoding one
 * takes a few hundred milliseconds, which the first jump to one of its clips would otherwise wait for.
 */
export function prepareSampleVideos(assets: Iterable<Asset>): void {
  const idle = toPrepare.length === 0
  for (const asset of assets) {
    if (asset.kind !== 'video' || !isSampleAsset(asset)) continue
    const key = fileKey(asset)
    if (queued.has(key) || cache.has(key)) continue
    queued.add(key)
    toPrepare.push(asset)
  }
  if (idle && toPrepare.length > 0) whenIdle(prepareNext)
}

function prepareNext(): void {
  const asset = toPrepare[0]
  if (!asset) return
  // Drawing the scene and starting its encoder each take tens of milliseconds: separate tasks, each at idle.
  sceneLayers(asset.storageKey.slice(SCENE_PREFIX.length) as SceneId, WIDTH, HEIGHT)
  whenIdle(() => {
    void sampleFile(asset)
      .catch(() => undefined)
      .finally(() => {
        toPrepare.shift()
        if (toPrepare.length > 0) whenIdle(prepareNext)
      })
  })
}

function whenIdle(run: () => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 5000 })
  else setTimeout(run, 200)
}
