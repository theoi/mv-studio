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
import { MASK_PREFIX, SAMPLE_VIDEO_FPS } from './demoProject.ts'
import { synthesizeSong } from './sampleSong.ts'

const WIDTH = 1280
const HEIGHT = 720

const SCENE_PREFIX = 'mock:'

export function isSampleAsset(asset: Asset): boolean {
  return asset.storageKey.startsWith(SCENE_PREFIX) || asset.storageKey.startsWith(MASK_PREFIX)
}

/** The scene as one canvas. `keep: false` leaves its layers out of the art cache unless they are there already. */
function sceneCanvas(scene: SceneId, keep = true): HTMLCanvasElement {
  const { bg, fg } = sceneLayers(scene, WIDTH, HEIGHT, keep)
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
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Couldn’t encode the image'))), type, quality),
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
  output.addVideoTrack(source, { frameRate: SAMPLE_VIDEO_FPS })
  await output.start()
  const frames = Math.max(2, Math.ceil(duration * SAMPLE_VIDEO_FPS))
  for (let i = 0; i < frames; i++) await source.add(i / SAMPLE_VIDEO_FPS, 1 / SAMPLE_VIDEO_FPS)
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

/** The file for `asset`, made by `make` unless it was made (or is being made) already. */
function fileFor(asset: Asset, make: () => Promise<Blob>): Promise<Blob> {
  const key = fileKey(asset)
  let file = cache.get(key)
  if (!file) {
    file = make()
    file.catch(() => cache.delete(key))
    cache.set(key, file)
  }
  return file
}

/** The generated file for a sample asset, made once per storage key and kind. */
export function sampleFile(asset: Asset): Promise<Blob> {
  return fileFor(asset, () => generate(asset))
}

/** The assets prepareSampleVideos() was last given, the videos among them still to make, and whether one is underway. */
let shown: Readonly<Record<string, Asset>> | null = null
let waiting: Asset[] = []
let preparing = false

/**
 * Makes the sample videos among a project's assets ahead of their first use, one at a time while the page is idle.
 * Encoding one takes a few hundred milliseconds, which the first jump to one of its clips would otherwise wait for.
 * Each call replaces the videos still waiting (the one underway finishes), so another project, or null when the
 * editor closes, stops it.
 */
export function prepareSampleVideos(assets: Readonly<Record<string, Asset>> | null): void {
  if (assets === shown) return
  shown = assets
  waiting = Object.values(assets ?? {}).filter(
    (a) => a.kind === 'video' && isSampleAsset(a) && !cache.has(fileKey(a)),
  )
  if (!preparing && waiting.length > 0) {
    preparing = true
    whenIdle(prepareNext)
  }
}

function prepareNext(): void {
  let asset = waiting.shift()
  // Made on demand meanwhile.
  while (asset && cache.has(fileKey(asset))) asset = waiting.shift()
  if (!asset) {
    preparing = false
    return
  }
  const video = asset
  // Drawing the scene and starting its encoder each take tens of milliseconds: separate tasks, each at idle. The
  // drawing is not kept: once the file is made, nothing needs it.
  const canvas = sceneCanvas(video.storageKey.slice(SCENE_PREFIX.length) as SceneId, false)
  whenIdle(() => {
    void fileFor(video, () => encodeStillVideo(canvas, video.duration ?? 10))
      .catch(() => undefined)
      .finally(() => whenIdle(prepareNext))
  })
}

function whenIdle(run: () => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 5000 })
  else setTimeout(run, 200)
}
