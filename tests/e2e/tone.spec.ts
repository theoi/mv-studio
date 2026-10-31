import { expect, openHarness, test } from './fixtures.ts'

// Bright and dark test stills: a gray ramp on top, saturated and tinted patches below, fine stripes for texture.
const STILLS = {
  bright: { ramp: [0.55, 0.95], patches: ['#ff6a4a', '#ffd84a', '#4ae0ff', '#ff6ad8', '#f2c9a8', '#e8f0ff'] },
  dark: { ramp: [0.0, 0.3], patches: ['#3a0d08', '#2a2408', '#082a33', '#300a2a', '#3a2a20', '#101418'] },
}

test('adjustments roll off instead of clipping, and near-neutral settings change nothing', async ({
  page,
}) => {
  await openHarness(page)
  const r = await page.evaluate(async (still) => {
    const { model, media, testing, plugins } = window.mvStudio
    const W = 256
    const H = 128
    const canvas = new OffscreenCanvas(W, H)
    const ctx = canvas.getContext('2d')!
    for (let x = 0; x < W; x++) {
      const v = Math.round(255 * (still.ramp[0] + ((still.ramp[1] - still.ramp[0]) * x) / (W - 1)))
      ctx.fillStyle = `rgb(${v},${v},${v})`
      ctx.fillRect(x, 0, 1, H / 2)
    }
    still.patches.forEach((color, i) => {
      ctx.fillStyle = color
      ctx.fillRect((i * W) / still.patches.length, H / 2, W / still.patches.length, H / 2)
    })
    const image = await media.mediaStore.storeBlob(await canvas.convertToBlob({ type: 'image/png' }), {
      kind: 'image',
      name: 'tone.png',
      origin: { type: 'generated' },
    })
    const { compositor } = testing.createCompositor('export', W, H)
    const render = async (adjustments: Record<string, number>, effects: unknown[] = []) => {
      const p = model.createProject({ name: 'tone' })
      p.assets[image.id] = image
      const clip = model.createImageClip({
        trackId: p.tracks[0]!.id,
        assetId: image.id,
        start: 0,
        duration: 4,
      })
      clip.fit = 'stretch'
      clip.adjustments = Object.fromEntries(Object.entries(adjustments).map(([k, value]) => [k, { value }]))
      clip.effects = effects as typeof clip.effects
      p.clips[clip.id] = clip
      await compositor.render(p, 1)
      return testing.readPixels(compositor.canvas, W, H)
    }
    const hue = (px: Uint8ClampedArray, x0: number) => {
      let r = 0
      let g = 0
      let b = 0
      for (let y = H / 2 + 8; y < H - 8; y++)
        for (let x = Math.ceil(x0) + 4; x < x0 + W / still.patches.length - 4; x++) {
          const i = (y * W + x) * 4
          r += px[i]!
          g += px[i + 1]!
          b += px[i + 2]!
        }
      return (Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b) * 180) / Math.PI
    }
    const source = await render({})
    const strong = await render({ contrast: 1, saturation: 1 })
    const nearNeutral = await render({ exposure: 0.001 })
    const grade = plugins.library.createEffectInstance('color-grade')
    grade.params.look = { value: 'natural' }
    grade.params.amount = { value: 1 }
    const natural = await render({}, [grade])
    compositor.dispose()
    const rampLuma = (px: Uint8ClampedArray) =>
      Array.from({ length: 24 }, (_, k) => {
        const i = ((H / 4) * W + Math.round(((W - 1) * k) / 23)) * 4
        return 0.2126 * px[i]! + 0.7152 * px[i + 1]! + 0.0722 * px[i + 2]!
      })
    const maxDiff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
      let m = 0
      for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!))
      return m
    }
    return {
      ramp: rampLuma(strong),
      hueShift: still.patches.map((_, i) => {
        const x0 = (i * W) / still.patches.length
        const d = Math.abs(hue(strong, x0) - hue(source, x0)) % 360
        return Math.min(d, 360 - d)
      }),
      nearNeutral: maxDiff(nearNeutral, source),
      natural: maxDiff(natural, source),
    }
  }, STILLS.bright)
  console.log('tone', JSON.stringify(r))
  // Maximum contrast and saturation on a bright still: the highlight ramp keeps rising instead of flattening at
  // white, and saturated colors keep their hue instead of shifting where channels clip.
  for (let k = 1; k < r.ramp.length; k++) expect(r.ramp[k]!, `ramp step ${k}`).toBeGreaterThan(r.ramp[k - 1]!)
  expect(r.ramp.at(-1)!).toBeLessThan(254.5)
  for (const [i, d] of r.hueShift.entries()) expect(d, `patch ${i} hue shift`).toBeLessThan(8)
  // Saturated colors stay put when a setting is (nearly) neutral, in the finish pass and in the color grade.
  expect(r.nearNeutral).toBeLessThanOrEqual(2)
  expect(r.natural).toBeLessThanOrEqual(2)
})

test('no look blows out a bright still or crushes a dark one', async ({ page }) => {
  await openHarness(page)
  const r = await page.evaluate(async (stills) => {
    const { model, media, plugins, testing } = window.mvStudio
    const W = 256
    const H = 144
    const { compositor } = testing.createCompositor('export', W, H)
    const out: Record<string, { blown: number; crushed: number }> = {}
    const share = (px: Uint8ClampedArray, test: (r: number, g: number, b: number) => boolean) => {
      let n = 0
      for (let i = 0; i < px.length; i += 4) if (test(px[i]!, px[i + 1]!, px[i + 2]!)) n++
      return (100 * n) / (px.length / 4)
    }
    const blown = (r: number, g: number, b: number) => Math.min(r, g, b) >= 250
    const crushed = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b <= 3
    for (const [kind, still] of Object.entries(stills)) {
      const canvas = new OffscreenCanvas(W, H)
      const ctx = canvas.getContext('2d')!
      for (let x = 0; x < W; x++) {
        const v = Math.round(255 * (still.ramp[0] + ((still.ramp[1] - still.ramp[0]) * x) / (W - 1)))
        ctx.fillStyle = `rgb(${v},${v},${v})`
        ctx.fillRect(x, 0, 1, H / 2)
      }
      // Fine texture in the ramp, the kind of detail that disappears when highlights or shadows clip.
      ctx.fillStyle = kind === 'bright' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.25)'
      for (let x = 0; x < W; x += 4) ctx.fillRect(x, 0, 2, H / 2)
      still.patches.forEach((color, i) => {
        ctx.fillStyle = color
        ctx.fillRect((i * W) / still.patches.length, H / 2, W / still.patches.length, H / 2)
      })
      const image = await media.mediaStore.storeBlob(await canvas.convertToBlob({ type: 'image/png' }), {
        kind: 'image',
        name: `${kind}.png`,
        origin: { type: 'generated' },
      })
      const base = model.createProject({ name: kind })
      base.assets[image.id] = image
      const clip = model.createImageClip({
        trackId: base.tracks[0]!.id,
        assetId: image.id,
        start: 0,
        duration: 4,
      })
      clip.fit = 'stretch'
      base.clips[clip.id] = clip
      await compositor.render(base, 1)
      const ref = testing.readPixels(compositor.canvas, W, H)
      for (const look of plugins.looks.lookRegistry.list()) {
        const editor = new model.ProjectEditor(structuredClone(base))
        plugins.looks.applyLook(editor, look.id)
        await compositor.render(editor.getProject(), 1)
        const px = testing.readPixels(compositor.canvas, W, H)
        const entry = (out[look.id] ??= { blown: 0, crushed: 0 })
        if (kind === 'bright') entry.blown = share(px, blown) - share(ref, blown)
        else entry.crushed = share(px, crushed) - share(ref, crushed)
      }
    }
    compositor.dispose()
    return out
  }, STILLS)
  console.log('looks blown/crushed %', JSON.stringify(r))
  expect(Object.keys(r).length).toBeGreaterThan(10)
  for (const [id, s] of Object.entries(r)) {
    expect(s.blown, `${id} blown`).toBeLessThan(5)
    expect(s.crushed, `${id} crushed`).toBeLessThan(5)
  }
})
