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

test('contrast keeps fully saturated solids, text and visualizers at full strength', async ({ page }) => {
  await openHarness(page)
  const r = await page.evaluate(async () => {
    const { model, plugins, testing } = window.mvStudio
    const W = 256
    const H = 144
    const { compositor } = testing.createCompositor('export', W, H)
    const render = async (p: unknown, time = 1) => {
      await compositor.render(p, time)
      return testing.readPixels(compositor.canvas, W, H) as Uint8ClampedArray
    }
    const center = (px: Uint8ClampedArray) => {
      const i = ((H / 2) * W + W / 2) * 4
      return [px[i]!, px[i + 1]!, px[i + 2]!]
    }
    const project = () => {
      const p = model.createProject({ name: 'saturated' })
      p.settings.backgroundColor = '#000000'
      return p
    }
    /** Puts contrast on everything below, the way looks apply as adjustment layers. */
    const withContrastLayer = (p: ReturnType<typeof project>, contrast: number) => {
      const q = structuredClone(p)
      const track = model.createTrack('visual', 'Adjust')
      q.tracks.unshift(track)
      const { color: _c, ...base } = model.createSolidClip({
        trackId: track.id,
        color: '#000',
        start: 0,
        duration: 4,
      })
      const layer = { ...base, type: 'adjustment', adjustments: { contrast: { value: contrast } } }
      q.clips[layer.id] = layer
      return q
    }
    /** Largest channel difference over the pixels that hold exactly `color` in the reference render. */
    const fillDiff = (ref: Uint8ClampedArray, px: Uint8ClampedArray, color: number[]) => {
      let n = 0
      let d = 0
      for (let i = 0; i < ref.length; i += 4) {
        if (ref[i] !== color[0] || ref[i + 1] !== color[1] || ref[i + 2] !== color[2]) continue
        n++
        for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(px[i + c]! - ref[i + c]!))
      }
      return { n, d }
    }

    const solids: Record<string, Record<string, number[]>> = {}
    for (const color of [
      '#ff0000',
      '#00ff00',
      '#0000ff',
      '#ffff00',
      '#00ffff',
      '#ff00ff',
      '#ffffff',
      '#b3665c',
    ]) {
      for (const contrast of [0.3, 0.6]) {
        const p = project()
        const clip = model.createSolidClip({ trackId: p.tracks[0].id, color, start: 0, duration: 4 })
        clip.adjustments = { contrast: { value: contrast } }
        p.clips[clip.id] = clip
        ;(solids[color] ??= {})[contrast] = center(await render(p))
      }
    }

    const fills: Record<string, { n: number; d: number }> = {}
    for (const [color, rgb] of [
      ['#0000ff', [0, 0, 255]],
      ['#ff0000', [255, 0, 0]],
      ['#ffff00', [255, 255, 0]],
    ] as const) {
      const p = project()
      const text = model.createTextClip({
        trackId: p.tracks[0].id,
        text: 'LOUD',
        start: 0,
        duration: 4,
        style: { color, fontSize: 300 },
      })
      p.clips[text.id] = text
      fills[`text ${color}`] = fillDiff(await render(p), await render(withContrastLayer(p, 0.6)), [...rgb])
    }
    for (const [color, rgb] of [
      ['#0000ff', [0, 0, 255]],
      ['#ff0000', [255, 0, 0]],
    ] as const) {
      const { project: p, time } = plugins.preview.pluginPreview('visualizer.spectrum')
      for (const clip of Object.values(p.clips) as { type: string; params: Record<string, unknown> }[])
        if (clip.type === 'generator')
          Object.assign(clip.params, { color: { value: color }, color2: { value: color } })
      fills[`spectrum ${color}`] = fillDiff(
        await render(p, time),
        await render(withContrastLayer(p, 0.6), time),
        [...rgb],
      )
    }

    // Exposure alone past white: an orange highlight goes toward white with its hue, not to yellow.
    const p = project()
    const orange = model.createSolidClip({ trackId: p.tracks[0].id, color: '#ff8000', start: 0, duration: 4 })
    orange.adjustments = { exposure: { value: 0.3 } }
    p.clips[orange.id] = orange
    const exposed = center(await render(p))
    compositor.dispose()
    return { solids, fills, exposed }
  })
  console.log('saturated', JSON.stringify(r))
  // Primaries, secondaries and white have a channel at 1 and one at 0, so contrast leaves them as they are.
  for (const [color, byContrast] of Object.entries(r.solids)) {
    if (color === '#b3665c') continue
    const want = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16))
    for (const [contrast, got] of Object.entries(byContrast))
      for (let c = 0; c < 3; c++)
        expect(Math.abs(got[c]! - want[c]!), `${color} at contrast ${contrast}`).toBeLessThanOrEqual(2)
  }
  // A midtone color still gets contrast: its brightest channel rises, its darkest falls, so it gains saturation.
  const [mr, , mb] = r.solids['#b3665c']['0.6']
  expect(mr).toBeGreaterThan(0xb3 + 8)
  expect(mb).toBeLessThan(0x5c - 8)
  for (const [name, { n, d }] of Object.entries(r.fills)) {
    expect(n, `${name} draws its color`).toBeGreaterThan(50)
    expect(d, `${name} keeps its color under contrast`).toBeLessThanOrEqual(2)
  }
  // #ff8000 has a hue of 30 degrees; clamping channels would move it toward yellow (about 46 at this exposure).
  const [er, eg, eb] = r.exposed
  expect(er).toBeGreaterThanOrEqual(254)
  expect(eg).toBeGreaterThan(eb + 10)
  const hue = (Math.atan2(Math.sqrt(3) * (eg - eb), 2 * er - eg - eb) * 180) / Math.PI
  expect(Math.abs(hue - 30)).toBeLessThan(4)
})

test('hue turns saturated colors instead of darkening them, exposure keeps them saturated, every variant compiles', async ({
  page,
}) => {
  await openHarness(page)
  const r = await page.evaluate(async () => {
    const { model, testing } = window.mvStudio
    const W = 32
    const H = 18
    const { compositor } = testing.createCompositor('export', W, H)
    const solid = async (color: string, adjustments: Record<string, number>) => {
      const p = model.createProject({ name: 'solid' })
      const clip = model.createSolidClip({ trackId: p.tracks[0].id, color, start: 0, duration: 4 })
      clip.adjustments = Object.fromEntries(Object.entries(adjustments).map(([k, value]) => [k, { value }]))
      p.clips[clip.id] = clip
      await compositor.render(p, 1)
      const px = testing.readPixels(compositor.canvas, W, H) as Uint8ClampedArray
      const i = ((H / 2) * W + W / 2) * 4
      return [px[i]!, px[i + 1]!, px[i + 2]!]
    }
    const hue = {
      blueA: await solid('#0000ff', { hue: 0.2 }),
      blueWithContrast: await solid('#0000ff', { hue: 0.2, contrast: 0.3 }),
      blueHalfway: await solid('#0000ff', { hue: 1 }),
      muted: await solid('#806060', { hue: 0.3 }),
      mutedSource: await solid('#806060', {}),
    }
    const exposure: Record<string, number[][]> = {}
    for (const color of ['#00ff00', '#ffff00', '#00ffff', '#ff0000'])
      exposure[color] = [
        await solid(color, { exposure: 0.3 }),
        await solid(color, { exposure: 0.3, saturation: 0.001 }),
      ]
    const nearWhite = await solid('#e0e0e0', { exposure: 1 })
    // Every combination of adjustments, which reaches every finish-pass variant.
    const keys = ['exposure', 'brightness', 'contrast', 'saturation', 'temperature', 'tint', 'hue']
    const source = await solid('#3366cc', {})
    const unchanged: string[] = []
    for (let m = 1; m < 1 << keys.length; m++) {
      const set = keys.filter((_, i) => m & (1 << i))
      const c = await solid('#3366cc', Object.fromEntries(set.map((k) => [k, 0.3])))
      if (c.every((v, i) => Math.abs(v - source[i]!) < 2)) unchanged.push(set.join('+'))
    }
    compositor.dispose()
    return { hue, exposure, nearWhite, unchanged }
  })
  console.log('hue/exposure', JSON.stringify(r))
  const hueOf = ([red, g, b]: number[]) =>
    (Math.atan2(Math.sqrt(3) * (g! - b!), 2 * red! - g! - b!) * 180) / Math.PI
  const luma = ([red, g, b]: number[]) => 0.2126 * red! + 0.7152 * g! + 0.0722 * b!
  // A hue turn keeps a saturated blue saturated: violet a little way round, yellow halfway, never dark gray or black.
  for (const [red, g, b] of [r.hue.blueA, r.hue.blueWithContrast]) {
    expect(red).toBeGreaterThan(100)
    expect(g).toBeLessThanOrEqual(5)
    expect(b).toBeGreaterThanOrEqual(240)
  }
  const [hr, hg, hb] = r.hue.blueHalfway
  expect(Math.min(hr!, hg!)).toBeGreaterThan(200)
  expect(hb).toBeLessThan(40)
  // A color the turn keeps in range keeps its luma.
  expect(Math.abs(luma(r.hue.muted) - luma(r.hue.mutedSource))).toBeLessThan(3)
  expect(Math.abs(hueOf(r.hue.muted) - hueOf(r.hue.mutedSource))).toBeGreaterThan(20)
  // Exposure past white keeps saturated colors saturated and in their hue, with or without other adjustments.
  for (const [color, [alone, withSaturation]] of Object.entries(r.exposure)) {
    const want = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16))
    for (let c = 0; c < 3; c++) {
      if (want[c] === 255) expect(alone![c], `${color} channel ${c}`).toBeGreaterThanOrEqual(254)
      else expect(alone![c], `${color} channel ${c}`).toBeLessThan(45)
      expect(Math.abs(alone![c]! - withSaturation![c]!), `${color} with saturation`).toBeLessThanOrEqual(2)
    }
    const d = Math.abs(hueOf(alone!) - hueOf(want)) % 360
    expect(Math.min(d, 360 - d), `${color} hue`).toBeLessThan(3)
  }
  // Colors close to white do turn white when pushed far past it.
  for (const v of r.nearWhite) expect(v).toBeGreaterThanOrEqual(250)
  expect(r.unchanged).toEqual([])
})
