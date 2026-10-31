import path from 'node:path'
import type { Page } from '@playwright/test'
import { FIXTURE_DIR } from './global-setup.ts'
import { expect, openHarness, test } from './fixtures.ts'

type Rgb = [number, number, number]

function expectColor(actual: Rgb, expected: Rgb, tolerance = 3) {
  const ok = actual.every((v, i) => Math.abs(v - (expected[i] as number)) <= tolerance)
  expect(
    ok,
    `expected ${JSON.stringify(actual)} to be within ${tolerance} of ${JSON.stringify(expected)}`,
  ).toBe(true)
}

/** Fails the test on page errors and console errors (shader compile failures are logged as errors). */
function collectErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  return errors
}

test('composites solids with transforms, opacity, blend modes, adjustment layers and transitions', async ({
  page,
}) => {
  const errors = collectErrors(page)
  await openHarness(page)
  const r = await page.evaluate(async () => {
    const { model, testing } = window.mvStudio
    const W = 160
    const H = 90
    const { compositor } = testing.createCompositor('export', W, H)
    const px = (x: number, y: number): Rgb => {
      const d = testing.readPixels(compositor.canvas, W, H)
      const i = (y * W + x) * 4
      return [d[i], d[i + 1], d[i + 2]]
    }
    const scene = (background = '#336699') => {
      const p = model.createProject({ name: 'render' })
      p.settings.backgroundColor = background
      const bottom = p.tracks[0]
      const top = model.createTrack('visual', 'Top')
      p.tracks.unshift(top)
      const solid = (color: string, start = 0, duration = 4, track = bottom) => {
        const c = model.createSolidClip({ trackId: track.id, color, start, duration })
        p.clips[c.id] = c
        return c
      }
      return { p, top, bottom, solid }
    }
    const out: Record<string, Rgb> = {}

    let s = scene()
    await compositor.render(s.p, 0)
    out.background = px(80, 45)

    s = scene()
    const half = s.solid('#ff0000')
    half.transform.scaleX = { value: 0.5 }
    half.transform.x = { value: 0.25 }
    half.opacity = { value: 0.5 }
    await compositor.render(s.p, 1)
    out.halfLeft = px(20, 45)
    out.halfRight = px(140, 45)

    for (const mode of ['multiply', 'screen', 'difference']) {
      s = scene('#808080')
      s.solid('#ff0000').blendMode = mode
      await compositor.render(s.p, 1)
      out[mode] = px(80, 45)
    }

    s = scene()
    s.solid('#ff0000')
    const { color: _c, ...adjustBase } = model.createSolidClip({
      trackId: s.top.id,
      color: '#000',
      start: 0,
      duration: 4,
    })
    const adjustment = { ...adjustBase, type: 'adjustment', adjustments: { saturation: { value: -1 } } }
    s.p.clips[adjustment.id] = adjustment
    await compositor.render(s.p, 1)
    out.desaturated = px(80, 45)

    s = scene()
    s.solid('#ff0000', 0, 2)
    s.solid('#0000ff', 2, 2).transitionIn = { kind: 'fade', duration: 1, easing: 'linear' }
    await compositor.render(s.p, 2.5)
    out.crossfade = px(80, 45)

    s = scene()
    s.solid('#ff0000', 0, 2)
    s.solid('#0000ff', 2, 2).transitionIn = { kind: 'wipe-left', duration: 1, easing: 'linear' }
    await compositor.render(s.p, 2.5)
    out.wipeLeft = px(20, 45)
    out.wipeRight = px(140, 45)

    s = scene()
    s.solid('#ff0000', 1, 3).transitionIn = { kind: 'fade', duration: 1, easing: 'linear' }
    await compositor.render(s.p, 1.5)
    out.fadeIn = px(80, 45)
    compositor.dispose()
    return out
  })
  expectColor(r.background, [51, 102, 153])
  expectColor(r.halfLeft, [153, 51, 77])
  expectColor(r.halfRight, [51, 102, 153])
  expectColor(r.multiply, [128, 0, 0])
  expectColor(r.screen, [255, 128, 128])
  expectColor(r.difference, [127, 128, 128])
  expectColor(r.desaturated, [54, 54, 54])
  expectColor(r.crossfade, [128, 0, 128])
  expectColor(r.wipeLeft, [255, 0, 0])
  expectColor(r.wipeRight, [0, 0, 255])
  expectColor(r.fadeIn, [153, 51, 77])
  expect(errors).toEqual([])
})

test('every built-in effect, generator, transition and text preset compiles and draws', async ({ page }) => {
  const errors = collectErrors(page)
  await openHarness(page)
  const r = await page.evaluate(async () => {
    const { model, engine, media, testing } = window.mvStudio
    const W = 480
    const H = 270
    const { compositor } = testing.createCompositor('export', W, H)
    const pixels = (): Uint8ClampedArray => testing.readPixels(compositor.canvas, W, H)
    const changed = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
      let n = 0
      for (let i = 0; i < a.length; i += 4)
        if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 12) n++
      return n / (a.length / 4)
    }
    const lit = (a: Uint8ClampedArray) => {
      let n = 0
      for (let i = 0; i < a.length; i += 4) if (a[i] + a[i + 1] + a[i + 2] > 60) n++
      return n / (a.length / 4)
    }

    // A checkerboard image with hard edges and bright squares, so every effect has something to change.
    const checker = new OffscreenCanvas(W, H)
    const cctx = checker.getContext('2d')!
    for (let y = 0; y < H; y += 30)
      for (let x = 0; x < W; x += 30) {
        cctx.fillStyle = (x + y) % 60 === 0 ? '#f0f0f0' : '#202020'
        cctx.fillRect(x, y, 30, 30)
      }
    const image = await media.mediaStore.storeBlob(await checker.convertToBlob({ type: 'image/png' }), {
      kind: 'image',
      name: 'checker.png',
      origin: { type: 'generated' },
    })

    const base = () => {
      const p = model.createProject({ name: 'plugins' })
      p.settings.backgroundColor = '#000000'
      p.assets[image.id] = image
      // Analysis for a silent song so visualizers have band values to draw.
      const songId = 'song'
      p.songAssetId = songId
      const audioTrack = p.tracks.find((t: { kind: string }) => t.kind === 'audio')
      const song = model.createAudioClip({ trackId: audioTrack.id, assetId: songId, start: 0, duration: 10 })
      p.clips[song.id] = song
      p.analysis.audio[songId] = {
        assetId: songId,
        version: 'test',
        beats: [0.5, 1, 1.5],
        features: {
          rate: 10,
          loudness: Array(100).fill(0.7),
          bands: Array.from({ length: 100 }, () =>
            Array.from({ length: 16 }, (_, i) => 0.3 + (i % 5) * 0.15),
          ),
          bandEdgesHz: [],
          onsets: [],
        },
      }
      return p
    }
    const visualTrack = (p: { tracks: { kind: string; id: string }[] }) =>
      p.tracks.find((t) => t.kind === 'visual')!.id

    const out: Record<string, number> = {}
    const plain = base()
    const img = model.createImageClip({
      trackId: visualTrack(plain),
      assetId: image.id,
      start: 0,
      duration: 4,
    })
    img.fit = 'stretch'
    plain.clips[img.id] = img
    await compositor.render(plain, 1)
    const reference = pixels()

    for (const effect of engine.pluginRegistry.list('effect')) {
      const p = structuredClone(plain)
      p.clips[img.id].effects = [{ id: 'fx', effectId: effect.id, enabled: true, params: {} }]
      await compositor.render(p, 1)
      out[`effect:${effect.id}`] = changed(reference, pixels())
    }

    for (const generator of engine.pluginRegistry.list('generator')) {
      const p = base()
      const clip = {
        ...model.createSolidClip({ trackId: visualTrack(p), color: '#000', start: 0, duration: 4 }),
        type: 'generator',
        generatorId: generator.id,
        params: {},
      }
      delete clip.color
      p.clips[clip.id] = clip
      await compositor.render(p, 1)
      out[`generator:${generator.id}`] = lit(pixels())
    }

    for (const transition of engine.pluginRegistry.list('transition')) {
      const p = base()
      const a = model.createSolidClip({ trackId: visualTrack(p), color: '#ff0000', start: 0, duration: 2 })
      const b = model.createSolidClip({ trackId: visualTrack(p), color: '#0000ff', start: 2, duration: 2 })
      b.transitionIn = { kind: transition.id, duration: 1, easing: 'linear' }
      p.clips[a.id] = a
      p.clips[b.id] = b
      await compositor.render(p, 2.5)
      const d = pixels()
      // Fraction of pixels that are neither the outgoing red nor the incoming blue: 1 for blends, ~0.5 for wipes.
      let mixed = 0
      for (let i = 0; i < d.length; i += 4) {
        const isRed = d[i] > 245 && d[i + 2] < 10
        const isBlue = d[i + 2] > 245 && d[i] < 10
        if (!isRed && !isBlue) mixed++
      }
      const center = (Math.floor(H / 2) * W + Math.floor(W / 2)) * 4
      out[`transition:${transition.id}`] = mixed / (d.length / 4)
      out[`transition:${transition.id}:hasBlue`] = d.some(
        (_, i) => i % 4 === 2 && d[i] > 200 && d[i - 2] < 60,
      )
        ? 1
        : 0
      out[`transition:${transition.id}:center`] = d[center] + d[center + 1] + d[center + 2]
    }

    for (const preset of engine.pluginRegistry.list('text-animation')) {
      const p = base()
      const clip = model.createTextClip({
        trackId: visualTrack(p),
        text: 'Hello brave new world',
        start: 0,
        duration: 4,
      })
      clip.animation = { presetId: preset.id, params: {} }
      p.clips[clip.id] = clip
      await compositor.render(p, 0.05)
      const early = lit(pixels())
      await compositor.render(p, 3)
      const late = lit(pixels())
      out[`text:${preset.id}:early`] = early
      out[`text:${preset.id}:late`] = late
    }
    compositor.dispose()
    return out
  })

  for (const id of ['glow', 'blur', 'rgb-split', 'vignette', 'film-grain'])
    expect(r[`effect:${id}`], `effect ${id} changes the picture`).toBeGreaterThan(0.02)
  for (const id of ['visualizer.spectrum', 'visualizer.waveform', 'visualizer.particles'])
    expect(r[`generator:${id}`], `generator ${id} draws`).toBeGreaterThan(0.002)
  expect(r['generator:visualizer.spectrum']).toBeGreaterThan(0.1)
  for (const id of ['fade', 'zoom']) expect(r[`transition:${id}`], `${id} blends`).toBeGreaterThan(0.9)
  expect(r['transition:flash:center'], 'flash is bright at the midpoint').toBeGreaterThan(600)
  expect(r['transition:wipe-left'], 'wipe edge is narrow').toBeLessThan(0.2)
  expect(r['transition:wipe-left:hasBlue']).toBe(1)
  for (const id of ['pop', 'fade-up', 'typewriter']) {
    expect(r[`text:${id}:late`], `${id} shows the text`).toBeGreaterThan(0.01)
    expect(r[`text:${id}:early`], `${id} starts hidden or partial`).toBeLessThan(r[`text:${id}:late`] * 0.5)
  }
  expect(errors).toEqual([])
})

test('draws images upright and video frames frame-exactly in both preview and export', async ({ page }) => {
  const errors = collectErrors(page)
  await openHarness(page)
  await page.setInputFiles(
    '#e2e-file-input',
    ['clip.mp4', 'image.png'].map((f) => path.join(FIXTURE_DIR, f)),
  )
  const r = await page.evaluate(async () => {
    const { model, media, testing } = window.mvStudio
    const W = 320
    const H = 180
    const [video, image] = await Promise.all(
      window.mvStudio.files().map((f: File) => media.mediaStore.importFile(f)),
    )
    const meanDiff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
      let sum = 0
      for (let i = 0; i < a.length; i += 4)
        sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
      return sum / (a.length / 4) / 3
    }
    const project = (asset: { id: string }, type: 'image' | 'video') => {
      const p = model.createProject({ name: 'media' })
      p.assets[asset.id] = asset
      const trackId = p.tracks[0].id
      const clip =
        type === 'image'
          ? model.createImageClip({ trackId, assetId: asset.id, start: 0, duration: 4 })
          : model.createVideoClip({ trackId, assetId: asset.id, start: 0, duration: 4 })
      clip.fit = 'stretch'
      p.clips[clip.id] = clip
      return p
    }

    const exp = testing.createCompositor('export', W, H)
    await exp.compositor.render(project(image, 'image'), 1)
    const bitmap = await createImageBitmap(await media.mediaStore.getFile(image))
    const imageDiff = meanDiff(
      testing.readPixels(exp.compositor.canvas, W, H),
      testing.readPixels(bitmap, W, H),
    )

    const videoProject = project(video, 'video')
    const frameTime = (n: number) => n / 30
    const grab = async (
      c: { compositor: { render: (p: unknown, t: number) => Promise<void>; canvas: CanvasImageSource } },
      t: number,
    ) => {
      await c.compositor.render(videoProject, t)
      return testing.readPixels(c.compositor.canvas, W, H)
    }
    const pre = testing.createCompositor('preview', W, H)
    const exportFrames: Uint8ClampedArray[] = []
    const previewFrames: Uint8ClampedArray[] = []
    // Frame 30 and 31 (1 s and 1 s + 1 frame), then back to frame 15 to exercise backwards seeking.
    for (const n of [30, 31, 15]) {
      exportFrames.push(await grab(exp, frameTime(n)))
      previewFrames.push(await grab(pre, frameTime(n)))
    }
    exp.compositor.dispose()
    pre.compositor.dispose()
    return {
      imageDiff,
      sameFrame: [0, 1, 2].map((i) => meanDiff(exportFrames[i], previewFrames[i])),
      nextFrame: meanDiff(exportFrames[0], exportFrames[1]),
      backwards: meanDiff(exportFrames[2], exportFrames[0]),
    }
  })
  console.log('media render diffs', JSON.stringify(r))
  expect(r.imageDiff).toBeLessThan(1)
  // Preview (<video>) and export (WebCodecs) agree on the same frame, including YUV conversion of untagged footage.
  for (const d of r.sameFrame) expect(d).toBeLessThan(1)
  expect(r.nextFrame).toBeGreaterThan(2)
  expect(r.backwards).toBeGreaterThan(1)
  expect(errors).toEqual([])
})

test('renders text with karaoke highlighting and restricts layers to a matte', async ({ page }) => {
  const errors = collectErrors(page)
  await openHarness(page)
  const r = await page.evaluate(async () => {
    const { model, media, testing } = window.mvStudio
    const W = 320
    const H = 180
    const { compositor } = testing.createCompositor('export', W, H)
    const count = (pred: (r: number, g: number, b: number) => boolean) => {
      const d = testing.readPixels(compositor.canvas, W, H)
      let n = 0
      for (let i = 0; i < d.length; i += 4) if (pred(d[i], d[i + 1], d[i + 2])) n++
      return n
    }
    const isRed = (r: number, g: number, b: number) => r > 200 && g < 80 && b < 80
    const isWhite = (r: number, g: number, b: number) => r > 200 && g > 200 && b > 200

    const p = model.createProject({ name: 'text' })
    const text = model.createTextClip({ trackId: p.tracks[0].id, text: 'HELLO WORLD', start: 0, duration: 4 })
    text.karaoke = { highlightColor: '#ff0000', mode: 'word' }
    p.clips[text.id] = text
    await compositor.render(p, 0.9)
    const mid = { red: count(isRed), white: count(isWhite) }
    await compositor.render(p, 3.9)
    const end = { red: count(isRed), white: count(isWhite) }

    // Matte: a mask that is white on the left half, aligned with a host image clip below.
    const maskCanvas = new OffscreenCanvas(W, H)
    const mctx = maskCanvas.getContext('2d')!
    mctx.fillStyle = '#000'
    mctx.fillRect(0, 0, W, H)
    mctx.fillStyle = '#fff'
    mctx.fillRect(0, 0, W / 2, H)
    const store = (blob: Blob, name: string) =>
      media.mediaStore.storeBlob(blob, { kind: 'image', name, origin: { type: 'generated' } })
    const mask = await store(await maskCanvas.convertToBlob({ type: 'image/png' }), 'mask.png')
    const hostCanvas = new OffscreenCanvas(W, H)
    const hctx = hostCanvas.getContext('2d')!
    hctx.fillStyle = '#00ff00'
    hctx.fillRect(0, 0, W, H)
    const host = await store(await hostCanvas.convertToBlob({ type: 'image/png' }), 'host.png')

    const matteResult: Record<string, Rgb[]> = {}
    for (const mode of ['inside', 'outside']) {
      const q = model.createProject({ name: 'matte' })
      q.assets[mask.id] = mask
      q.assets[host.id] = host
      const top = model.createTrack('visual', 'Top')
      q.tracks.unshift(top)
      const hostClip = model.createImageClip({
        trackId: q.tracks[1].id,
        assetId: host.id,
        start: 0,
        duration: 4,
      })
      hostClip.fit = 'stretch'
      const red = model.createSolidClip({ trackId: top.id, color: '#ff0000', start: 0, duration: 4 })
      red.matte = { maskAssetId: mask.id, sourceAssetId: host.id, mode, feather: 0 }
      q.clips[hostClip.id] = hostClip
      q.clips[red.id] = red
      await compositor.render(q, 1)
      const d = testing.readPixels(compositor.canvas, W, H)
      const at = (x: number, y: number): Rgb => {
        const i = (y * W + x) * 4
        return [d[i], d[i + 1], d[i + 2]]
      }
      matteResult[mode] = [at(60, 90), at(260, 90)]
    }
    compositor.dispose()
    return { mid, end, matte: matteResult }
  })
  expect(r.mid.red).toBeGreaterThan(20)
  expect(r.mid.white).toBeGreaterThan(20)
  expect(r.end.red).toBeGreaterThan(r.mid.red)
  expect(r.end.white).toBeLessThan(r.mid.white / 4)
  expectColor(r.matte.inside[0], [255, 0, 0])
  expectColor(r.matte.inside[1], [0, 255, 0])
  expectColor(r.matte.outside[0], [0, 255, 0])
  expectColor(r.matte.outside[1], [255, 0, 0])
  expect(errors).toEqual([])
})
