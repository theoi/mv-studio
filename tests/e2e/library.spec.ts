import type { Page } from '@playwright/test'
import { expect, openHarness, test } from './fixtures.ts'

function collectErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  return errors
}

/** Stores the sample scene as an image asset in the page and returns it. */
async function sceneAsset(page: Page) {
  return page.evaluate(async () => {
    const { media, plugins } = window.mvStudio
    return media.mediaStore.storeBlob(await plugins.preview.sampleSceneBlob(), {
      kind: 'image',
      name: 'scene.png',
      origin: { type: 'generated' },
    })
  })
}

test('every effect visibly changes the picture with its library defaults and audio mappings', async ({
  page,
}) => {
  const errors = collectErrors(page)
  await openHarness(page)
  const image = await sceneAsset(page)
  const r = await page.evaluate(async (image) => {
    const { engine, plugins, testing } = window.mvStudio
    const W = 320
    const H = 180
    const { compositor } = testing.createCompositor('export', W, H)
    const grab = async (p: unknown, t: number) => {
      await compositor.render(p, t)
      return testing.readPixels(compositor.canvas, W, H)
    }
    const out: Record<string, { changed: number; brightness: number }> = {}
    for (const def of engine.pluginRegistry.list('effect')) {
      const { project, time } = plugins.preview.pluginPreview(def.id, { image })
      const plain = structuredClone(project)
      for (const clip of Object.values(plain.clips) as { effects?: unknown[] }[])
        if (clip.effects) clip.effects = []
      const a = await grab(plain, time)
      const b = await grab(project, time)
      let changed = 0
      let brightness = 0
      for (let i = 0; i < a.length; i += 4) {
        if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 12)
          changed++
        brightness += (b[i] + b[i + 1] + b[i + 2]) / 3
      }
      out[def.id] = { changed: changed / (a.length / 4), brightness: brightness / (a.length / 4) }
    }
    compositor.dispose()
    return out
  }, image)
  expect(Object.keys(r).length).toBeGreaterThanOrEqual(22)
  for (const [id, { changed, brightness }] of Object.entries(r)) {
    expect(changed, `${id} changes the picture`).toBeGreaterThan(0.02)
    expect(brightness, `${id} keeps the picture visible`).toBeGreaterThan(15)
  }
  expect(errors).toEqual([])
})

test('every transition moves from the outgoing to the incoming shot, also when fading in from below', async ({
  page,
}) => {
  const errors = collectErrors(page)
  await openHarness(page)
  const r = await page.evaluate(async () => {
    const { engine, model, plugins, testing } = window.mvStudio
    const W = 160
    const H = 90
    const { compositor } = testing.createCompositor('export', W, H)
    const shares = async (p: unknown, t: number) => {
      await compositor.render(p, t)
      const d = testing.readPixels(compositor.canvas, W, H)
      let red = 0
      let blue = 0
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 150 && d[i] > d[i + 2] * 2) red++
        if (d[i + 2] > 150 && d[i + 2] > d[i] * 2) blue++
      }
      return { red: red / (d.length / 4), blue: blue / (d.length / 4) }
    }
    const out: Record<
      string,
      { early: number; mid: number; late: number; midBlue: number; lateBlue: number; fadeIn: number }
    > = {}
    for (const def of engine.pluginRegistry.list('transition')) {
      const p = model.createProject({ name: def.id })
      const track = p.tracks[0].id
      const a = model.createSolidClip({ trackId: track, color: '#ff0000', start: 0, duration: 2 })
      const b = model.createSolidClip({ trackId: track, color: '#0000ff', start: 2, duration: 2 })
      b.transitionIn = { ...plugins.library.createTransition(def.id, { duration: 1 }), easing: 'linear' }
      p.clips[a.id] = a
      p.clips[b.id] = b
      const early = await shares(p, 2.08)
      const mid = await shares(p, 2.5)
      const late = await shares(p, 2.92)
      const q = model.createProject({ name: def.id })
      const only = model.createSolidClip({ trackId: q.tracks[0].id, color: '#0000ff', start: 0, duration: 2 })
      only.transitionIn = { ...plugins.library.createTransition(def.id, { duration: 1 }), easing: 'linear' }
      q.clips[only.id] = only
      const fadeIn = await shares(q, 0.96)
      out[def.id] = {
        early: early.red,
        mid: mid.red,
        late: late.blue,
        midBlue: mid.blue,
        lateBlue: late.blue,
        fadeIn: fadeIn.blue,
      }
    }
    compositor.dispose()
    return out
  })
  expect(Object.keys(r).length).toBeGreaterThanOrEqual(18)
  for (const [id, s] of Object.entries(r)) {
    expect(s.early, `${id} starts on the outgoing shot`).toBeGreaterThan(0.5)
    expect(s.late, `${id} ends on the incoming shot`).toBeGreaterThan(0.5)
    expect(s.lateBlue + 0.05, `${id} progresses`).toBeGreaterThanOrEqual(s.midBlue)
    expect(s.fadeIn, `${id} reveals a clip over the layers below`).toBeGreaterThan(0.5)
  }
  expect(errors).toEqual([])
})

test('color grade applies imported .cube LUTs and bundled LUTs', async ({ page }) => {
  const errors = collectErrors(page)
  await openHarness(page)
  const r = await page.evaluate(async () => {
    const { model, media, plugins, testing } = window.mvStudio
    const W = 64
    const H = 36
    // A size-5 LUT that inverts colors.
    const rows: string[] = []
    for (let b = 0; b < 5; b++)
      for (let g = 0; g < 5; g++)
        for (let r = 0; r < 5; r++) rows.push([1 - r / 4, 1 - g / 4, 1 - b / 4].join(' '))
    const file = new File([`TITLE "Invert"\nLUT_3D_SIZE 5\n${rows.join('\n')}\n`], 'invert.cube')
    const asset = await plugins.lut.importLut(file, media.mediaStore)
    const { compositor } = testing.createCompositor('export', W, H)
    const render = async (lut: string, amount: number) => {
      const p = model.createProject({ name: 'lut' })
      p.assets[asset.id] = asset
      const solid = model.createSolidClip({
        trackId: p.tracks[0].id,
        color: '#c86432',
        start: 0,
        duration: 4,
      })
      const fx = plugins.library.createEffectInstance('color-grade')
      fx.params.look = { value: 'natural' }
      fx.params.lut = { value: lut }
      fx.params.lutAmount = { value: amount }
      solid.effects = [fx]
      p.clips[solid.id] = solid
      await compositor.render(p, 1)
      const d = testing.readPixels(compositor.canvas, W, H)
      return [d[0], d[1], d[2]]
    }
    const out = {
      asset: { name: asset.name, width: asset.width, isLut: plugins.lut.isLutAsset(asset) },
      none: await render('', 1),
      inverted: await render(asset.id, 1),
      half: await render(asset.id, 0.5),
      neutral: await render('bundled:luts/neutral.png', 1),
    }
    compositor.dispose()
    return out
  })
  expect(r.asset).toMatchObject({ name: 'Invert', isLut: true })
  expect(r.none).toEqual([200, 100, 50])
  r.inverted.forEach((v, i) => expect(Math.abs(v - (255 - [200, 100, 50][i]!))).toBeLessThanOrEqual(3))
  r.half.forEach((v, i) =>
    expect(Math.abs(v - 127.5)).toBeLessThanOrEqual(3 + Math.abs([200, 100, 50][i]! - 127.5) * 0.02),
  )
  r.neutral.forEach((v, i) => expect(Math.abs(v - [200, 100, 50][i]!)).toBeLessThanOrEqual(3))
  expect(errors).toEqual([])
})

test('blur and glow spread like a Gaussian of their radius at any canvas size', async ({ page }) => {
  const errors = collectErrors(page)
  await openHarness(page)
  const r = await page.evaluate(async () => {
    const { media, model, plugins, testing } = window.mvStudio
    const store = async (paint: (ctx: OffscreenCanvasRenderingContext2D) => void) => {
      const canvas = new OffscreenCanvas(640, 360)
      const ctx = canvas.getContext('2d')!
      paint(ctx)
      return media.mediaStore.storeBlob(await canvas.convertToBlob({ type: 'image/png' }), {
        kind: 'image',
        name: 'edge.png',
        origin: { type: 'generated' },
      })
    }
    const edge = await store((ctx) => {
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, 640, 360)
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, 320, 360)
    })
    const gray = await store((ctx) => {
      ctx.fillStyle = '#4d4d4d'
      ctx.fillRect(0, 0, 640, 360)
    })
    const row = async (asset: typeof edge, effectId: string, radius: number, W: number, H: number) => {
      const p = model.createProject({ name: 'edge' })
      p.assets[asset.id] = asset
      const clip = model.createImageClip({
        trackId: p.tracks[0].id,
        assetId: asset.id,
        start: 0,
        duration: 4,
      })
      if (effectId) {
        const fx = plugins.library.createEffectInstance(effectId)
        fx.params.radius = { value: radius }
        clip.effects = [fx]
      }
      p.clips[clip.id] = clip
      const { compositor } = testing.createCompositor('export', W, H)
      await compositor.render(p, 1)
      const d = testing.readPixels(compositor.canvas, W, H)
      compositor.dispose()
      const y = Math.floor(H / 2)
      return Array.from({ length: W }, (_, x) => d[(y * W + x) * 4]! / 255)
    }
    /** Pixels between the 90% and 10% points of the white-to-black edge, interpolated between pixels. */
    const crossing = (v: number[], level: number) => {
      const i = v.findIndex((x) => x < level)
      return i - (level - v[i]!) / (v[i - 1]! - v[i]!)
    }
    const edgeWidth = (v: number[]) => crossing(v, 0.1) - crossing(v, 0.9)
    const sizes = [
      [1280, 720],
      [640, 360],
    ] as const
    const out = []
    for (const [W, H] of sizes)
      for (const radius of [8, 24, 60]) {
        const v = await row(edge, 'blur', radius, W, H)
        out.push({ W, H, radius, width: edgeWidth(v), expected: 2.563 * 0.46 * radius * (H / 1080) })
      }
    const sharp = await row(edge, '', 0, 320, 180)
    const zero = await row(edge, 'blur', 0, 320, 180)
    const dim = await row(gray, '', 0, 320, 180)
    const dimGlow = await row(gray, 'glow', 24, 320, 180)
    return {
      widths: out,
      zeroUnchanged: zero.every((x, i) => x === sharp[i]),
      belowThresholdUnchanged: dimGlow.every((x, i) => Math.abs(x - dim[i]!) < 2 / 255),
    }
  })
  expect(r.widths).toHaveLength(6)
  for (const w of r.widths) {
    const label = `blur ${w.radius} at ${w.W}x${w.H}: ${w.width.toFixed(1)}px`
    expect(w.width / w.expected, label).toBeGreaterThan(0.85)
    expect(w.width / w.expected, label).toBeLessThan(1.15)
  }
  expect(r.zeroUnchanged).toBe(true)
  expect(r.belowThresholdUnchanged).toBe(true)
  expect(errors).toEqual([])
})

test('preview and export agree frame for frame on noisy and beat-driven library plugins', async ({
  page,
}) => {
  const errors = collectErrors(page)
  await openHarness(page)
  const image = await sceneAsset(page)
  const r = await page.evaluate(async (image) => {
    const { plugins, testing } = window.mvStudio
    const W = 192
    const H = 108
    const exp = testing.createCompositor('export', W, H)
    const pre = testing.createCompositor('preview', W, H)
    const ids = [
      'blur',
      'glow',
      'glitch',
      'shake',
      'old-film',
      'vhs',
      'displace',
      'kaleidoscope',
      'light-leak',
      'color-grade',
      'whip-pan',
      'glitch-cut',
      'noise-dissolve',
      'light-burn',
    ]
    const out: Record<string, number[]> = {}
    for (const id of ids) {
      const { project, time } = plugins.preview.pluginPreview(id, { image })
      const times = [time + 0.37, time, time - 0.21]
      const diffs = []
      for (const t of times) {
        await exp.compositor.render(project, t)
        const a = testing.readPixels(exp.compositor.canvas, W, H)
        await pre.compositor.render(project, t)
        const b = testing.readPixels(pre.compositor.canvas, W, H)
        let max = 0
        for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]))
        diffs.push(max)
      }
      out[id] = diffs
    }
    exp.compositor.dispose()
    pre.compositor.dispose()
    return out
  }, image)
  for (const [id, diffs] of Object.entries(r)) expect(diffs, id).toEqual([0, 0, 0])
  expect(errors).toEqual([])
})
