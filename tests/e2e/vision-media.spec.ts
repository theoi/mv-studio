import path from 'node:path'
import type { Page } from '@playwright/test'
import { FIXTURE_DIR } from './global-setup.ts'
import { expect, openHarness, test } from './fixtures.ts'

function collectErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    // MediaPipe's WASM routes its INFO log lines to console.error.
    if (m.type() === 'error' && !m.text().startsWith('INFO:')) errors.push(m.text())
  })
  return errors
}

test('mask videos from vision drive the compositor matte in preview and export, aligned to source time', async ({
  page,
}) => {
  const errors = collectErrors(page)
  await openHarness(page)
  await page.setInputFiles('#e2e-file-input', [path.join(FIXTURE_DIR, 'clip.mp4')])
  const r = await page.evaluate(async () => {
    const { model, media, testing, vision } = window.mvStudio
    const W = 320
    const H = 180
    const host = await media.mediaStore.importFile(window.mvStudio.files()[0])
    // Subject on the left half for the first 2 s of the source, then on the right half.
    const track = vision.createPackedTrack({
      version: 1,
      kind: 'person',
      mediaId: host.id,
      sourceSize: { width: 640, height: 360 },
      maskSize: { width: 320, height: 180 },
      fps: 10,
      start: 0,
      model: 'test',
      quality: 'standard',
    })
    for (let i = 0; i < 40; i++) {
      const data = new Uint8Array(320 * 180)
      for (let y = 0; y < 180; y++)
        for (let x = 0; x < 320; x++) if (i < 20 ? x < 160 : x >= 160) data[y * 320 + x] = 255
      vision.appendFrame(track, { width: 320, height: 180, data }, 0.5)
    }
    const blob = await vision.encodeMaskVideo(track, { duration: 4 })
    const mask = await media.mediaStore.storeBlob(blob, vision.maskAssetInfo(host, blob))

    const p = model.createProject({ name: 'matte' })
    p.assets[host.id] = host
    p.assets[mask.id] = mask
    const top = model.createTrack('visual', 'Lyrics')
    p.tracks.unshift(top)
    const video = model.createVideoClip({ trackId: p.tracks[1].id, assetId: host.id, start: 0, duration: 4 })
    video.fit = 'stretch'
    p.clips[video.id] = video
    const red = model.createSolidClip({ trackId: top.id, color: '#ff0000', start: 0, duration: 4 })
    red.matte = vision.behindSubjectMatte(mask.id, host.id, 0.1)
    p.clips[red.id] = red

    const results: Record<string, { left: boolean; right: boolean }[]> = {}
    for (const mode of ['export', 'preview'] as const) {
      const { compositor } = testing.createCompositor(mode, W, H)
      const isRed = (x: number) => {
        const d = testing.readPixels(compositor.canvas, W, H)
        const i = (90 * W + x) * 4
        return d[i] > 200 && d[i + 1] < 60 && d[i + 2] < 60
      }
      results[mode] = []
      for (const t of [1, 3]) {
        await compositor.render(p, t)
        results[mode].push({ left: isRed(60), right: isRed(260) })
      }
      compositor.dispose()
    }
    return { results, mime: blob.type, bytes: blob.size }
  })
  console.log('mask video', JSON.stringify(r))
  for (const mode of ['export', 'preview']) {
    // "Behind the subject": the red layer shows where the subject is not.
    expect(r.results[mode]).toEqual([
      { left: false, right: true },
      { left: true, right: false },
    ])
  }
  expect(errors).toEqual([])
})

test('vision frames decoded through the export path match <video> frames and feed the person track', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const errors = collectErrors(page)
  await openHarness(page)
  await page.setInputFiles('#e2e-file-input', [path.join(FIXTURE_DIR, 'clip.mp4')])
  const r = await page.evaluate(async () => {
    const { media, vision } = window.mvStudio
    const file: File = window.mvStudio.files()[0]
    const asset = await media.mediaStore.importFile(file)
    const decoded = vision.createAssetFrameSource(asset, media.mediaStore)
    const element = await vision.createVideoElementSource(file, 'clip-element', { frameRate: 30 })
    const pixels = (b: ImageBitmap) => {
      const c = new OffscreenCanvas(b.width, b.height)
      const ctx = c.getContext('2d')!
      ctx.drawImage(b, 0, 0)
      b.close()
      return ctx.getImageData(0, 0, c.width, c.height).data
    }
    const diffs: number[] = []
    for (const t of [0.5, 1.5, 3]) {
      const a = pixels(await decoded.frameAt(t + 0.01, { maxSide: 256 }))
      const b = pixels(await element.frameAt(t + 0.01, { maxSide: 256 }))
      let s = 0
      for (let i = 0; i < a.length; i += 4)
        s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
      diffs.push(s / (a.length / 4) / 3)
    }
    const throughput = async (source: typeof element) => {
      const t0 = performance.now()
      for (let i = 0; i < 40; i++) (await source.frameAt(i / 10, { maxSide: 384 })).close()
      return (performance.now() - t0) / 40
    }
    const decoderMs = await throughput(decoded)
    const elementMs = await throughput(element)
    const backends = vision.createWorkerBackends()
    const service = vision.createVisionService({ backends, cache: vision.createMemoryCache() })
    const res = await service.personTrack(decoded, { faceFps: 0, maxSide: 384 })
    backends.dispose()
    decoded.dispose()
    element.dispose()
    return {
      meta: {
        width: decoded.width,
        height: decoded.height,
        duration: decoded.duration,
        frameRate: decoded.frameRate,
      },
      diffs,
      decoderMs,
      elementMs,
      track: { mediaId: res.track.meta.mediaId, frames: res.track.meta.frameCount, assetId: asset.id },
    }
  })
  console.log('frame sources', JSON.stringify(r))
  expect(r.meta).toMatchObject({ width: 640, height: 360, frameRate: 30 })
  expect(r.meta.duration).toBeCloseTo(4, 1)
  for (const d of r.diffs) expect(d).toBeLessThan(4)
  expect(r.decoderMs).toBeLessThan(r.elementMs)
  expect(r.track.mediaId).toBe(r.track.assetId)
  expect(r.track.frames).toBeGreaterThan(30)
  expect(errors).toEqual([])
})
test('depth estimation and the parallax renderer produce a camera move', async ({ page }) => {
  test.setTimeout(240_000)
  const errors = collectErrors(page)
  await openHarness(page)
  await page.setInputFiles('#e2e-file-input', [path.join(FIXTURE_DIR, 'image.png')])
  const r = await page.evaluate(async () => {
    const { vision } = window.mvStudio
    const file: File = window.mvStudio.files()[0]
    const image = await createImageBitmap(file)
    const backends = vision.createWorkerBackends()
    const service = vision.createVisionService({ backends, cache: vision.createMemoryCache() })
    const request = {
      mediaId: 'image',
      quality: 'preview',
      sourceSize: { width: image.width, height: image.height },
      frame: (maxSide: number) => {
        const s = Math.min(1, maxSide / Math.max(image.width, image.height))
        return createImageBitmap(image, {
          resizeWidth: Math.round(image.width * s),
          resizeHeight: Math.round(image.height * s),
        })
      },
    }
    const t0 = performance.now()
    const depth = await service.depth.get(request)
    const firstMs = performance.now() - t0
    const t1 = performance.now()
    await service.depth.get(request)
    const cachedMs = performance.now() - t1
    let mean = 0
    for (const v of depth.data) mean += v
    mean /= depth.data.length
    let variance = 0
    for (const v of depth.data) variance += (v - mean) ** 2
    const prepared = vision.prepareDepthForParallax(depth)
    const renderer = vision.createParallaxRenderer()
    renderer.setImage(image)
    renderer.setDepth(prepared)
    const move = { ...vision.defaultCameraMove('orbit-left'), focus: vision.suggestFocus(prepared) }
    const frame = (progress: number) => {
      renderer.render(vision.cameraPoseAt(move, progress), { width: 320, height: 180 })
      const c = new OffscreenCanvas(320, 180)
      const ctx = c.getContext('2d')!
      ctx.drawImage(renderer.canvas, 0, 0)
      return ctx.getImageData(0, 0, 320, 180).data
    }
    const a = frame(0)
    const b = frame(1)
    let diff = 0
    for (let i = 0; i < a.length; i += 4)
      diff += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
    renderer.dispose()
    backends.dispose()
    return {
      size: [depth.width, depth.height],
      std: Math.sqrt(variance / depth.data.length),
      firstMs,
      cachedMs,
      moveDiff: diff / (a.length / 4) / 3,
    }
  })
  console.log('depth', JSON.stringify(r))
  expect(r.size).toEqual([644, 364])
  expect(r.std).toBeGreaterThan(5)
  expect(r.cachedMs).toBeLessThan(r.firstMs / 10)
  expect(r.moveDiff).toBeGreaterThan(2)
  expect(errors).toEqual([])
})
