import path from 'node:path'
import type { Page } from '@playwright/test'
import { FIXTURE_DIR } from './global-setup.ts'
import { expect, openHarness, test } from './fixtures.ts'

/**
 * Counts live VideoDecoders (WebCodecs, which the export decoder uses), <video> elements with a source and WebGL
 * textures.
 */
interface MediaCounts {
  live: number
  maxLive: number
  made: number
  loadedVideos: number
  textures: number
}

async function countMedia(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>
    const Original = VideoDecoder
    const counts = { live: 0, maxLive: 0, made: 0, videos: [] as HTMLVideoElement[] }
    class Counted extends Original {
      constructor(init: VideoDecoderInit) {
        super(init)
        counts.made++
        counts.maxLive = Math.max(counts.maxLive, ++counts.live)
      }
      close() {
        if (this.state !== 'closed') counts.live--
        super.close()
      }
    }
    w.VideoDecoder = Counted
    let textures = 0
    const gl = WebGL2RenderingContext.prototype
    const { createTexture, deleteTexture } = gl
    gl.createTexture = function () {
      textures++
      return createTexture.call(this)
    }
    gl.deleteTexture = function (texture) {
      if (texture) textures--
      deleteTexture.call(this, texture)
    }
    const create = document.createElement.bind(document)
    document.createElement = ((tag: string, options?: ElementCreationOptions) => {
      const element = create(tag, options)
      if (element instanceof HTMLVideoElement) counts.videos.push(element)
      return element
    }) as typeof document.createElement
    w.mediaCounts = () => ({
      live: counts.live,
      maxLive: counts.maxLive,
      made: counts.made,
      loadedVideos: counts.videos.filter((v) => v.hasAttribute('src')).length,
      textures,
    })
  })
}

test('an export keeps decoders and textures only for the clips on screen, and each cut shows its own frames', async ({
  page,
}) => {
  await openHarness(page)
  await countMedia(page)
  await page.setInputFiles(
    '#e2e-file-input',
    ['frames.mp4', 'clip.mp4'].map((f) => path.join(FIXTURE_DIR, f)),
  )
  const r = await page.evaluate(async () => {
    const counts = () => (window as unknown as { mediaCounts(): MediaCounts }).mediaCounts()
    const { model, media, testing } = window.mvStudio
    const [framesFile, clipFile] = window.mvStudio.files()
    const frames = await media.mediaStore.importFile(framesFile)
    // Four copies of clip.mp4: footage the export has not decoded yet at each of its cuts.
    const clips = []
    for (let i = 0; i < 4; i++) clips.push(await media.mediaStore.importFile(clipFile))
    const p = model.createProject({ name: 'cuts' })
    for (const asset of [frames, ...clips]) p.assets[asset.id] = asset
    const track = p.tracks.find((t: { kind: string }) => t.kind === 'visual')
    // Beat cuts: a piece that continues the one before it, cuts back and ahead in the same footage, other footage.
    const cuts: [typeof frames, number][] = [
      [frames, 0],
      [frames, 0.6],
      [clips[0], 0],
      [frames, 0.1],
      [clips[1], 0.5],
      [frames, 3],
      [clips[2], 1],
      [frames, 1.5],
      [clips[3], 2],
      [frames, 2.1],
    ]
    const pieces = cuts.map(([asset, sourceStart], i) => {
      const c = model.createVideoClip({
        trackId: track.id,
        assetId: asset.id,
        start: i * 0.6,
        duration: 0.6,
        sourceStart,
      })
      p.clips[c.id] = c
      return { start: i * 0.6, sourceStart, frames: asset === frames }
    })

    // frames.mp4 encodes its frame number N in gray levels: left half (N % 16) * 16 + 8, right half N / 16 likewise.
    const W = 320
    const H = 180
    const reader = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true })!
    /** The frames.mp4 frame number shown, or -1 for colored footage (clip.mp4). */
    const frameNumber = (source: CanvasImageSource) => {
      reader.drawImage(source, 0, 0, W, H)
      const d = reader.getImageData(0, 0, W, H).data
      let colored = 0
      for (let i = 0; i < d.length; i += 4)
        if (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 40) colored++
      if (colored > W * H * 0.05) return -1
      const gray = (x: number, y: number) => {
        const i = (y * W + x) * 4
        return (d[i] + d[i + 1] + d[i + 2]) / 3
      }
      return Math.round((gray(80, 90) - 8) / 16) + 16 * Math.round((gray(240, 90) - 8) / 16)
    }
    const exp = testing.createCompositor('export', W, H)
    const shown: { t: number; expected: number; shown: number }[] = []
    let maxLive = 0
    let texturesFirstCut = 0
    let maxTextures = 0
    for (let k = 0; k < cuts.length * 6; k++) {
      const t = k / 10 + 0.05
      await exp.compositor.render(p, t)
      maxLive = Math.max(maxLive, counts().live)
      if (k === 5) texturesFirstCut = counts().textures
      maxTextures = Math.max(maxTextures, counts().textures)
      const piece = pieces[Math.floor(t / 0.6)]!
      shown.push({
        t,
        expected: piece.frames ? Math.floor((piece.sourceStart + t - piece.start + 1e-4) * 30) : -1,
        shown: frameNumber(exp.compositor.canvas),
      })
    }
    const afterLast = counts().live
    exp.compositor.dispose()
    exp.frames.dispose()
    return { shown, maxLive, afterLast, extraTextures: maxTextures - texturesFirstCut }
  })
  expect(r.shown).toHaveLength(60)
  expect(r.shown.filter((s) => s.shown !== s.expected)).toEqual([])
  // One cursor for the clip on screen; two only while a new clip's starts before the old one's closes.
  expect(r.maxLive).toBeLessThanOrEqual(2)
  expect(r.afterLast).toBeLessThanOrEqual(1)
  // Video textures of clips that went off screen a few frames ago are deleted (nine more than the first cut's if not).
  expect(r.extraTextures).toBeLessThanOrEqual(3)
})

test('the preview keeps footage it no longer shows loaded only within a pixel budget, and loads it again when needed', async ({
  page,
}) => {
  await openHarness(page)
  await countMedia(page)
  await page.setInputFiles('#e2e-file-input', [path.join(FIXTURE_DIR, 'clip1080.mp4')])
  const r = await page.evaluate(async () => {
    const counts = () => (window as unknown as { mediaCounts(): MediaCounts }).mediaCounts()
    const { model, media, testing } = window.mvStudio
    const [file] = window.mvStudio.files()
    // Fourteen copies of a 1080p clip: different footage to the preview, so no element can take over another's.
    const assets = []
    for (let i = 0; i < 14; i++) assets.push(await media.mediaStore.importFile(file))
    const p = model.createProject({ name: 'many' })
    const track = p.tracks.find((t: { kind: string }) => t.kind === 'visual')
    assets.forEach((asset, i) => {
      p.assets[asset.id] = asset
      const c = model.createVideoClip({
        trackId: track.id,
        assetId: asset.id,
        start: i,
        duration: 1,
        sourceStart: 1,
      })
      p.clips[c.id] = c
    })
    const W = 160
    const H = 90
    const pixels = (source: CanvasImageSource) => {
      const ctx = new OffscreenCanvas(W, H).getContext('2d')!
      ctx.drawImage(source, 0, 0, W, H)
      return Array.from(ctx.getImageData(0, 0, W, H).data)
    }
    const preview = testing.createCompositor('preview', W, H)
    await preview.compositor.render(p, 0.5)
    const first = pixels(preview.compositor.canvas)
    for (let i = 1; i < 14; i++) await preview.compositor.render(p, i + 0.5)
    // Past the frames an element may sit idle before it counts as unused.
    for (let i = 0; i < 3; i++) await preview.compositor.render(p, 13.5)
    const loaded = counts().loadedVideos
    await preview.compositor.render(p, 0.5)
    const again = pixels(preview.compositor.canvas)
    const changed = again.filter((v, i) => Math.abs(v - first[i]!) > 2).length
    preview.compositor.dispose()
    preview.frames.dispose()
    return { loaded, changed }
  })
  // The clip on screen and eight 1080p elements (the budget is two 4K frames' worth of pixels).
  expect(r.loaded).toBeLessThanOrEqual(9)
  expect(r.changed).toBe(0)
})
