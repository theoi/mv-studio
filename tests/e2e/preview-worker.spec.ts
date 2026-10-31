import path from 'node:path'
import type { Page } from '@playwright/test'
import { FIXTURE_DIR } from './global-setup.ts'
import { expect, openHarness, test } from './fixtures.ts'

/**
 * The preview drawing in the render worker (PreviewOptions.renderer 'worker'): the canvas moves to the worker, which
 * gets each frame's video frames from the main thread's <video> elements.
 */

type Rgb = [number, number, number]

/** Fails the test on page errors and console errors (shader compile failures are logged as errors). */
function collectErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  return errors
}

test('draws the same frames in the render worker as on the main thread and in export', async ({ page }) => {
  const errors = collectErrors(page)
  await openHarness(page)
  await page.setInputFiles(
    '#e2e-file-input',
    ['clip.mp4', 'image.png'].map((f) => path.join(FIXTURE_DIR, f)),
  )
  const r = await page.evaluate(async () => {
    const { model, media, engine, testing } = window.mvStudio
    const W = 320
    const H = 180
    const [video, image] = await Promise.all(
      window.mvStudio.files().map((f: File) => media.mediaStore.importFile(f)),
    )
    const p = model.createProject({ name: 'worker parity' })
    p.assets[video.id] = video
    p.assets[image.id] = image
    const top = model.createTrack('visual', 'Top')
    p.tracks.unshift(top)
    const base = model.createVideoClip({ trackId: p.tracks[1].id, assetId: video.id, start: 0, duration: 4 })
    base.fit = 'stretch'
    base.effects.push({ id: 'fx1', effectId: 'vignette', enabled: true, params: {} })
    const still = model.createImageClip({ trackId: top.id, assetId: image.id, start: 0, duration: 4 })
    still.transform.scaleX.value = 0.4
    still.transform.scaleY.value = 0.4
    // The finish pass (contrast curve, gamut roll-off) must match too.
    still.adjustments = { contrast: { value: 0.6 }, saturation: { value: 0.4 } }
    base.adjustments = { exposure: { value: 0.2 } }
    still.transform.x.value = 0.3
    const title = model.createTextClip({ trackId: top.id, text: 'WORKER', start: 0, duration: 4 })
    // More video layers: one a second further into the footage, one showing the base's own frame. On the worker,
    // their frames go ahead of each still, and the copy shares the base's seek.
    const pipTrack = model.createTrack('visual', 'PiP')
    const copyTrack = model.createTrack('visual', 'Copy')
    p.tracks.unshift(pipTrack, copyTrack)
    const pip = model.createVideoClip({
      trackId: pipTrack.id,
      assetId: video.id,
      start: 0,
      duration: 4,
      sourceStart: 1,
    })
    const copy = model.createVideoClip({ trackId: copyTrack.id, assetId: video.id, start: 0, duration: 4 })
    for (const [clip, x, y] of [
      [pip, 0.78, 0.25],
      [copy, 0.22, 0.75],
    ] as const) {
      clip.transform.scaleX.value = 0.3
      clip.transform.scaleY.value = 0.3
      clip.transform.x.value = x
      clip.transform.y.value = y
    }
    for (const c of [base, still, title, pip, copy]) p.clips[c.id] = c

    const meanDiff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
      let sum = 0
      for (let i = 0; i < a.length; i += 4)
        sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
      return sum / (a.length / 4) / 3
    }
    const previewFrames = async (renderer: 'main' | 'worker', times: number[]) => {
      const preview = new engine.PreviewController({
        canvas: document.createElement('canvas'),
        media: media.mediaStore,
        renderer,
      })
      preview.setViewport(W, H, 1)
      preview.setProject(p)
      const out: Uint8ClampedArray[] = []
      for (const t of times) {
        preview.seek(t)
        const frame: ImageBitmap = await preview.captureFrame()
        out.push(testing.readPixels(frame, W, H))
        frame.close()
      }
      const stats = preview.stats()
      preview.dispose()
      return { frames: out, worker: stats.worker, size: [stats.width, stats.height] }
    }
    // Forward, the next frame, then backwards (exact seeks while paused).
    const times = [1, 31 / 30, 0.5]
    const main = await previewFrames('main', times)
    const worker = await previewFrames('worker', times)
    const exp = testing.createCompositor('export', W, H)
    const exported: Uint8ClampedArray[] = []
    for (const t of times) {
      await exp.compositor.render(p, t)
      exported.push(testing.readPixels(exp.compositor.canvas, W, H))
    }
    exp.compositor.dispose()
    return {
      worker: [main.worker, worker.worker],
      size: worker.size,
      vsMain: times.map((_, i) => meanDiff(worker.frames[i], main.frames[i])),
      vsExport: times.map((_, i) => meanDiff(worker.frames[i], exported[i])),
      nextFrame: meanDiff(worker.frames[0], worker.frames[1]),
    }
  })
  console.log('worker parity', JSON.stringify(r))
  expect(r.worker).toEqual([false, true])
  expect(r.size).toEqual([320, 180])
  for (const d of [...r.vsMain, ...r.vsExport]) expect(d).toBeLessThan(1)
  // The video moves between frames, so matching frames are not just matching stills.
  expect(r.nextFrame).toBeGreaterThan(1)
  expect(errors).toEqual([])
})

test('shows the worker frames on the page canvas', async ({ page }) => {
  const errors = collectErrors(page)
  await openHarness(page)
  await page.evaluate(async () => {
    const { model, media, engine } = window.mvStudio
    const canvas = document.createElement('canvas')
    canvas.id = 'worker-preview'
    canvas.style.cssText = 'position:fixed;left:0;top:0;width:320px;height:180px'
    document.body.appendChild(canvas)
    const solid = (color: string) => {
      const p = model.createProject({ name: color })
      const clip = model.createSolidClip({ trackId: p.tracks[0].id, color, start: 0, duration: 4 })
      p.clips[clip.id] = clip
      return p
    }
    const preview = new engine.PreviewController({ canvas, media: media.mediaStore, renderer: 'worker' })
    preview.setViewport(320, 180, 1)
    preview.setProject(solid('#ff0000'))
    await preview.rendered()
    window.mvStudio.workerPreview = { preview, solid }
  })
  const centerColor = async (): Promise<Rgb> => {
    const png = await page.locator('#worker-preview').screenshot()
    return page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
      const d = window.mvStudio.testing.readPixels(bitmap, 32, 18)
      const i = (9 * 32 + 16) * 4
      return [d[i], d[i + 1], d[i + 2]] as Rgb
    }, png.toString('base64'))
  }
  const near = (c: Rgb, e: Rgb) => c.every((v, i) => Math.abs(v - e[i]!) <= 8)
  await expect.poll(async () => near(await centerColor(), [255, 0, 0])).toBe(true)
  await page.evaluate(() => {
    const { preview, solid } = window.mvStudio.workerPreview
    preview.setProject(solid('#0000ff'))
  })
  await expect.poll(async () => near(await centerColor(), [0, 0, 255])).toBe(true)
  expect(await page.evaluate(() => window.mvStudio.workerPreview.preview.stats().worker)).toBe(true)
  expect(errors).toEqual([])
})

test('plays cuts in the render worker without stalls or wrong frames', async ({ page }) => {
  await openHarness(page)
  await page.setInputFiles(
    '#e2e-file-input',
    ['song.mp3', 'frames.mp4'].map((f) => path.join(FIXTURE_DIR, f)),
  )
  const r = await page.evaluate(async () => {
    const { media, testing } = window.mvStudio
    const [song, footage] = await Promise.all(
      window.mvStudio.files().map((f: File) => media.mediaStore.importFile(f)),
    )
    return testing.bench.measureCuts(testing.bench.cutProject({ song, footage }), undefined, {
      renderer: 'worker',
    })
  })
  console.log('cuts, render worker', JSON.stringify(r))
  expect(r.cuts).toHaveLength(4)
  expect(r.wrongFrames).toBeLessThanOrEqual(1)
  expect(r.maxStallMs).toBeLessThan(50)
})

test('draws on the main thread when the render worker cannot start', async ({ page }) => {
  await openHarness(page)
  const r = await page.evaluate(async () => {
    const { model, media, engine, testing } = window.mvStudio
    const RealWorker = window.Worker
    window.Worker = class {
      constructor() {
        throw new Error('Workers are blocked')
      }
    } as unknown as typeof Worker
    try {
      const p = model.createProject({ name: 'fallback' })
      const clip = model.createSolidClip({ trackId: p.tracks[0].id, color: '#00ff00', start: 0, duration: 4 })
      p.clips[clip.id] = clip
      const preview = new engine.PreviewController({
        canvas: document.createElement('canvas'),
        media: media.mediaStore,
        renderer: 'worker',
      })
      preview.setViewport(64, 36, 1)
      preview.setProject(p)
      await preview.rendered()
      const frame: ImageBitmap = await preview.captureFrame()
      const d = testing.readPixels(frame, 8, 8)
      const worker = preview.stats().worker
      preview.dispose()
      return { worker, center: [d[(4 * 8 + 4) * 4], d[(4 * 8 + 4) * 4 + 1], d[(4 * 8 + 4) * 4 + 2]] }
    } finally {
      window.Worker = RealWorker
    }
  })
  expect(r.worker).toBe(false)
  expect(r.center).toEqual([0, 255, 0])
})
