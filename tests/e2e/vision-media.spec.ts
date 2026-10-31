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
  const ortRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('ort-wasm')) ortRequests.push(request.url())
  })
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
  // Transformers.js runs on the ONNX Runtime binaries bundled with the app, not a CDN copy.
  expect(ortRequests.length).toBeGreaterThan(0)
  for (const url of ortRequests) expect(new URL(url).origin).toBe(new URL(page.url()).origin)
  expect(errors).toEqual([])
})

test('the 3D camera move effect renders the parallax renderer’s camera for every preset, and leaves letterboxes alone', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const errors = collectErrors(page)
  await openHarness(page)
  await page.setInputFiles('#e2e-file-input', [path.join(FIXTURE_DIR, 'image.png')])
  const r = await page.evaluate(async () => {
    const { model, media, testing, vision } = window.mvStudio
    const file: File = window.mvStudio.files()[0]
    const still = await media.mediaStore.importFile(file)
    // Far ramp with a near box, at the still's aspect so the stored PNG keeps these exact values.
    const dw = 160
    const dh = 90
    const data = new Uint8Array(dw * dh)
    for (let y = 0; y < dh; y++)
      for (let x = 0; x < dw; x++)
        data[y * dw + x] = x > 50 && x < 110 && y > 25 && y < 65 ? 230 : Math.round(40 + (80 * y) / dh)
    const depth = {
      version: 1,
      width: dw,
      height: dh,
      data,
      sourceSize: { width: 640, height: 360 },
      model: 'test',
      quality: 'full',
    }
    const depthAsset = await media.mediaStore.storeBlob(await vision.encodeDepthImage(depth), {
      kind: 'image',
      name: 'depth.png',
      origin: { type: 'derived', parentAssetId: still.id },
    })
    const p = model.createProject({ name: 'camera' })
    p.assets[still.id] = still
    p.assets[depthAsset.id] = depthAsset
    const track = p.tracks.find((t: { kind: string }) => t.kind === 'visual')
    const clip = model.createImageClip({ trackId: track.id, assetId: still.id, start: 0, duration: 4 })
    p.clips[clip.id] = clip
    const meanDiff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
      let s = 0
      for (let i = 0; i < a.length; i += 4)
        s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
      return s / (a.length / 4) / 3
    }

    const W = 320
    const H = 180
    const { compositor } = testing.createCompositor('export', W, H)
    const renderer = vision.createParallaxRenderer()
    renderer.setImage(await createImageBitmap(file))
    renderer.setDepth(depth)
    await compositor.render(p, 1)
    const plain = testing.readPixels(compositor.canvas, W, H)
    const results: { preset: string; progress: number; diff: number; moved: number }[] = []
    for (const preset of vision.CAMERA_PRESETS) {
      for (const progress of [0.3, 1]) {
        const effect = vision.cameraMoveEffect(clip, depthAsset.id, { focus: 0.4, preset, intensity: 0.8 })
        effect.params.progress = { value: progress }
        clip.effects = [effect]
        await compositor.render(p, 1)
        const fx = testing.readPixels(compositor.canvas, W, H)
        renderer.render(vision.cameraPoseAt({ preset, intensity: 0.8, focus: 0.4 }, progress), {
          width: W,
          height: H,
        })
        const ref = testing.readPixels(renderer.canvas, W, H)
        results.push({ preset, progress, diff: meanDiff(fx, ref), moved: meanDiff(fx, plain) })
      }
    }
    compositor.dispose()
    renderer.dispose()

    // Contain on a square canvas: 16:9 image with letterbox bands above and below.
    const S = 180
    const square = testing.createCompositor('export', S, S).compositor
    p.settings = model.createProject({ name: 'square', aspect: '1:1' }).settings
    p.settings.backgroundColor = '#0000ff'
    clip.fit = 'contain'
    clip.effects = []
    await square.render(p, 1)
    const containPlain = testing.readPixels(square.canvas, S, S)
    const effect = vision.cameraMoveEffect(clip, depthAsset.id, {
      focus: 0.4,
      preset: 'orbit-left',
      intensity: 1,
    })
    effect.params.progress = { value: 1 }
    clip.effects = [effect]
    await square.render(p, 1)
    const containFx = testing.readPixels(square.canvas, S, S)
    square.dispose()
    let bandChanged = 0
    let imageChanged = 0
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4
        const d = Math.abs(containFx[i] - containPlain[i]) + Math.abs(containFx[i + 2] - containPlain[i + 2])
        // The image spans rows 39.4 to 140.6.
        if (y < 36 || y >= S - 36) bandChanged = Math.max(bandChanged, d)
        else if (d > 30) imageChanged++
      }
    return { results, bandChanged, imageChanged }
  })
  console.log(
    'camera effect vs renderer',
    JSON.stringify(r.results.map((x) => [x.preset, x.progress, +x.diff.toFixed(2), +x.moved.toFixed(1)])),
  )
  expect(r.results).toHaveLength(20)
  for (const x of r.results) expect(x.diff, `${x.preset} at ${x.progress}`).toBeLessThan(3)
  // Dolly out ends on the plain view, so compare the larger change of the two progress values.
  for (const preset of new Set(r.results.map((x) => x.preset))) {
    const moved = Math.max(...r.results.filter((x) => x.preset === preset).map((x) => x.moved))
    expect(moved, `${preset} moves the picture`).toBeGreaterThan(3)
  }
  expect(r.bandChanged).toBeLessThan(8)
  expect(r.imageChanged).toBeGreaterThan(500)
  expect(errors).toEqual([])
})

test('"Add 3D camera move" on a still is one undo step: depth asset plus a keyframed camera effect', async ({
  page,
}) => {
  test.setTimeout(240_000)
  const errors = collectErrors(page)
  await openHarness(page)
  await page.setInputFiles('#e2e-file-input', [path.join(FIXTURE_DIR, 'image.png')])
  const r = await page.evaluate(async () => {
    const { model, media, testing, vision } = window.mvStudio
    const still = await media.mediaStore.importFile(window.mvStudio.files()[0])
    const p = model.createProject({ name: 'camera' })
    p.assets[still.id] = still
    const track = p.tracks.find((t: { kind: string }) => t.kind === 'visual')
    const clip = model.createImageClip({ trackId: track.id, assetId: still.id, start: 1, duration: 4 })
    p.clips[clip.id] = clip
    const editor = new model.ProjectEditor(p)
    const backends = vision.createWorkerBackends()
    const service = vision.createVisionService({ backends, cache: vision.createMemoryCache() })
    const deps = { editor, media: media.mediaStore, depth: service.depth }
    const stages: string[] = []
    const first = await vision.addCameraMove(deps, clip.id, {
      onProgress: (pr: { stage?: string }) => {
        if (pr.stage && !stages.includes(pr.stage)) stages.push(pr.stage)
      },
    })
    const added = editor.getProject()
    const effects = added.clips[clip.id].effects
    const depthAsset = added.assets[first.depthAssetId]

    const W = 320
    const H = 180
    const { compositor } = testing.createCompositor('export', W, H)
    const frame = async (t: number) => {
      await compositor.render(editor.getProject(), t)
      return testing.readPixels(compositor.canvas, W, H)
    }
    const a = await frame(1)
    const b = await frame(4.99)
    let moved = 0
    for (let i = 0; i < a.length; i += 4) moved += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1])
    compositor.dispose()

    editor.undo()
    const undone = editor.getProject()
    const afterUndo = {
      effects: undone.clips[clip.id].effects.length,
      hasDepth: first.depthAssetId in undone.assets,
      canUndo: editor.canUndo(),
    }
    editor.redo()
    const second = await vision.addCameraMove(deps, clip.id, { preset: 'orbit-left' })
    const final = editor.getProject()
    backends.dispose()
    return {
      stages,
      effect: {
        id: effects[0].effectId,
        count: effects.length,
        keyframes: effects[0].params.progress.keyframes,
      },
      depth: {
        kind: depthAsset.kind,
        parent: depthAsset.origin.parentAssetId,
        stillId: still.id,
        width: depthAsset.width,
        height: depthAsset.height,
      },
      moved: moved / (a.length / 4) / 2,
      afterUndo,
      second: {
        sameDepth: second.depthAssetId === first.depthAssetId,
        cameraEffects: final.clips[clip.id].effects.filter(
          (e: { effectId: string }) => e.effectId === 'camera-3d',
        ).length,
        preset: final.clips[clip.id].effects[0].params.preset.value,
        assets: Object.keys(final.assets).length,
      },
    }
  })
  console.log('add camera move', JSON.stringify(r))
  expect(r.effect).toMatchObject({ id: 'camera-3d', count: 1 })
  expect(r.effect.keyframes.map((k: { time: number; value: number }) => [k.time, k.value])).toEqual([
    [0, 0],
    [4, 1],
  ])
  expect(r.depth.kind).toBe('image')
  expect(r.depth.parent).toBe(r.depth.stillId)
  expect(r.depth.width / r.depth.height).toBeCloseTo(640 / 360, 2)
  expect(r.moved).toBeGreaterThan(2)
  expect(r.afterUndo).toEqual({ effects: 0, hasDepth: false, canUndo: false })
  expect(r.second).toEqual({ sameDepth: true, cameraEffects: 1, preset: 'orbit-left', assets: 2 })
  expect(r.stages).toContain('saving')
  expect(errors).toEqual([])
})
