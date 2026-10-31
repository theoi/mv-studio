import type { Page } from '@playwright/test'
import { expect, openHarness, test } from './fixtures.ts'

/** Fails the test on page errors and console errors (shader compile failures are logged as errors). */
function collectErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  return errors
}

test('plugin shaders receive beat and bar phase, flow and stem features from the song analysis', async ({
  page,
}) => {
  const errors = collectErrors(page)
  await openHarness(page)
  const r = await page.evaluate(async () => {
    const { model, engine, testing } = window.mvStudio
    const W = 64
    const H = 36
    engine.pluginRegistry.register({
      kind: 'generator',
      id: 'test.uniforms',
      name: 'Uniforms',
      category: 'Test',
      params: [{ key: 'probe', label: 'Probe', type: 'number', default: 0, min: 0, max: 1 }],
      fragmentShader: `
vec4 mainImage(vec2 uv) {
  if (u_probe < 0.5) return vec4(u_beatPhase, u_barPhase, fract(u_flow), 1.0);
  return vec4(u_stems.y, u_stemOnsets.y, u_hasStems, 1.0);
}`,
    })
    const { compositor } = testing.createCompositor('export', W, H)
    const p = model.createProject({ name: 'uniforms' })
    p.songAssetId = 'song'
    const audioTrack = p.tracks.find((t: { kind: string }) => t.kind === 'audio')
    const song = model.createAudioClip({ trackId: audioTrack.id, assetId: 'song', start: 0, duration: 10 })
    p.clips[song.id] = song
    const n = 101
    p.analysis.audio.song = {
      assetId: 'song',
      version: 'test',
      beats: [0.5, 1.1, 1.6, 2.2, 2.8, 3.3],
      downbeats: [0.5, 2.8],
      features: {
        rate: 10,
        loudness: Array.from({ length: n }, (_, i) => 0.3 + 0.6 * Math.abs(Math.sin(i / 7))),
        bands: Array.from({ length: n }, () => [0.5, 0.5]),
        bandEdgesHz: [],
        onsets: [],
      },
    }
    const gen = {
      ...model.createSolidClip({ trackId: p.tracks[0].id, color: '#000', start: 0, duration: 10 }),
      type: 'generator',
      generatorId: 'test.uniforms',
      params: {},
    }
    delete gen.color
    p.clips[gen.id] = gen
    const px = () => {
      const d = testing.readPixels(compositor.canvas, W, H)
      return [d[0], d[1], d[2]].map((v) => v / 255)
    }
    const sampler = engine.createAudioSampler(p)
    const motion: { got: number[]; want: number[] }[] = []
    for (const t of [0.8, 1.35, 2.5, 3.0, 4.2]) {
      await compositor.render(p, t)
      const f = sampler.frame(t)
      motion.push({ got: px(), want: [f.beatPhase, f.barPhase, f.flow - Math.floor(f.flow)] })
    }
    gen.params = { probe: { value: 1 } }
    await compositor.render(p, 2.2)
    const noStems = px()
    p.analysis.audio.song.stemFeatures = {
      drums: { rate: 10, loudness: Array(n).fill(0.6), bands: [], bandEdgesHz: [], onsets: [2.2] },
    }
    await compositor.render(structuredClone(p), 2.2)
    const withStems = px()
    compositor.dispose()
    return { motion, noStems, withStems }
  })
  for (const { got, want } of r.motion)
    got.forEach((v, i) =>
      expect(Math.abs(v - (want[i] as number)), `channel ${i}: ${v} vs ${want[i]}`).toBeLessThan(0.01),
    )
  expect(r.noStems.map((v) => Math.round(v * 100))).toEqual([0, 0, 0])
  expect(r.withStems.map((v) => Math.round(v * 100))).toEqual([60, 100, 100])
  expect(errors).toEqual([])
})

test('image params bind project images and bundled files next to the plugin inputs', async ({ page }) => {
  const errors = collectErrors(page)
  await openHarness(page)
  const r = await page.evaluate(async () => {
    const { model, engine, media, testing } = window.mvStudio
    const W = 128
    const H = 72
    engine.pluginRegistry.register({
      kind: 'effect',
      id: 'test.image-effect',
      name: 'Image effect',
      category: 'Test',
      params: [{ key: 'map', label: 'Map', type: 'image', default: '' }],
      fragmentShader: `
vec4 mainImage(vec2 uv) {
  if (u_mapSize.x < 1.0) return vec4(texture(u_input, uv).rgb * 0.5, 1.0);
  vec4 m = texture(u_map, vec2(uv.x, 1.0 - uv.y));
  return vec4(m.r, m.g, u_mapSize.x / 2048.0, 1.0);
}`,
    })
    engine.pluginRegistry.register({
      kind: 'transition',
      id: 'test.image-transition',
      name: 'Image transition',
      category: 'Test',
      params: [{ key: 'map', label: 'Map', type: 'image', default: '' }],
      fragmentShader: `
vec4 transition(vec2 uv) {
  return vec4(texture(u_from, uv).r, texture(u_map, uv).g, texture(u_to, uv).b, 1.0);
}`,
    })
    const { compositor } = testing.createCompositor('export', W, H)
    const px = (x: number, y: number) => {
      const d = testing.readPixels(compositor.canvas, W, H)
      const i = (y * W + x) * 4
      return [d[i], d[i + 1], d[i + 2]]
    }
    // Image asset: red on the left half, green on the right half.
    const canvas = new OffscreenCanvas(200, 100)
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ff0000'
    ctx.fillRect(0, 0, 100, 100)
    ctx.fillStyle = '#00ff00'
    ctx.fillRect(100, 0, 100, 100)
    const image = await media.mediaStore.storeBlob(await canvas.convertToBlob({ type: 'image/png' }), {
      kind: 'image',
      name: 'map.png',
      origin: { type: 'generated' },
    })
    const scene = (map: string) => {
      const p = model.createProject({ name: 'images' })
      p.assets[image.id] = image
      const solid = model.createSolidClip({
        trackId: p.tracks[0].id,
        color: '#ffffff',
        start: 0,
        duration: 4,
      })
      solid.effects = [
        { id: 'fx', effectId: 'test.image-effect', enabled: true, params: { map: { value: map } } },
      ]
      p.clips[solid.id] = solid
      return p
    }
    const out: Record<string, number[]> = {}
    await compositor.render(scene(image.id), 1)
    out.assetLeft = px(20, 36)
    out.assetRight = px(108, 36)
    await compositor.render(scene('bundled:luts/neutral.png'), 1)
    // Neutral strip LUT (1024 x 32): x = r + 32 b, y = g. The top-left corner is black; x = 31 is pure red.
    out.lutCorner = px(0, 0)
    out.lutRed = px(3, 0)
    await compositor.render(scene('missing-asset'), 1)
    out.missing = px(64, 36)
    await compositor.render(scene('bundled:luts/does-not-exist.png'), 1)
    out.missingFile = px(64, 36)

    const p = model.createProject({ name: 'transition' })
    p.assets[image.id] = image
    const a = model.createSolidClip({ trackId: p.tracks[0].id, color: '#ff0000', start: 0, duration: 2 })
    const b = model.createSolidClip({ trackId: p.tracks[0].id, color: '#0000ff', start: 2, duration: 2 })
    b.transitionIn = {
      kind: 'test.image-transition',
      duration: 1,
      easing: 'linear',
      params: { map: image.id },
    }
    p.clips[a.id] = a
    p.clips[b.id] = b
    await compositor.render(p, 2.5)
    out.transitionRight = px(108, 36)
    out.transitionLeft = px(20, 36)
    compositor.dispose()
    return out
  })
  expect(r.assetLeft).toEqual([255, 0, 25])
  expect(r.assetRight).toEqual([0, 255, 25])
  // Canvas pixel x samples LUT column (x + 0.5) * 1024 / 128 - 0.5 with linear filtering; red = column / 31 there.
  const lutRedAt = (x: number) => ((((x + 0.5) * 1024) / 128 - 0.5) / 31) * 255
  expect(Math.abs((r.lutCorner[0] as number) - lutRedAt(0))).toBeLessThan(2)
  expect(Math.abs((r.lutRed[0] as number) - lutRedAt(3))).toBeLessThan(2)
  // Top row is g = 0; the blue channel carries the bound image width (1024 / 2048).
  expect([r.lutCorner[1], r.lutCorner[2]]).toEqual([0, 128])
  for (const fallback of [r.missing, r.missingFile]) expect(fallback).toEqual([128, 128, 128])
  expect(r.transitionRight).toEqual([255, 255, 255])
  expect(r.transitionLeft).toEqual([255, 0, 255])
  expect(errors.filter((e) => !e.includes('does-not-exist'))).toEqual([])
})

test('preview and export render plugin frames identically, in any order', async ({ page }) => {
  const errors = collectErrors(page)
  await openHarness(page)
  const r = await page.evaluate(async () => {
    const { model, engine, testing } = window.mvStudio
    const W = 160
    const H = 90
    engine.pluginRegistry.register({
      kind: 'generator',
      id: 'test.motion',
      name: 'Motion',
      category: 'Test',
      params: [],
      fragmentShader: `
vec4 mainImage(vec2 uv) {
  float rings = sin(length(uv - 0.5) * 40.0 - u_flow * 6.0 + u_beatPhase * 6.2831853);
  return vec4(0.5 + 0.5 * rings, u_barPhase, u_loudness, 1.0);
}`,
    })
    const p = model.createProject({ name: 'parity' })
    p.songAssetId = 'song'
    const audioTrack = p.tracks.find((t: { kind: string }) => t.kind === 'audio')
    p.clips.song = {
      ...model.createAudioClip({ trackId: audioTrack.id, assetId: 'song', start: 0, duration: 8 }),
      id: 'song',
    }
    p.analysis.audio.song = {
      assetId: 'song',
      version: 'test',
      beats: Array.from({ length: 16 }, (_, i) => 0.5 * i),
      features: {
        rate: 20,
        loudness: Array.from({ length: 160 }, (_, i) => (i % 10) / 10),
        bands: Array.from({ length: 160 }, () => [0.5]),
        bandEdgesHz: [],
        onsets: [],
      },
    }
    const gen = {
      ...model.createSolidClip({ trackId: p.tracks[0].id, color: '#000', start: 0, duration: 8 }),
      type: 'generator',
      generatorId: 'test.motion',
      params: {},
    }
    delete gen.color
    gen.effects = [
      {
        id: 'fx',
        effectId: 'rgb-split',
        enabled: true,
        params: {
          amount: {
            value: 6,
            modulation: [{ source: { kind: 'beat' }, amount: 20, mode: 'add', smoothing: 0 }],
          },
        },
      },
    ]
    p.clips[gen.id] = gen
    const text = model.createTextClip({ trackId: p.tracks[0].id, text: 'Same frame', start: 0, duration: 8 })
    text.animation = { presetId: 'pop', params: {} }
    const top = model.createTrack('visual', 'Text')
    p.tracks.unshift(top)
    text.trackId = top.id
    p.clips[text.id] = text

    const exp = testing.createCompositor('export', W, H)
    const pre = testing.createCompositor('preview', W, H)
    const grab = async (c: typeof exp, t: number) => {
      await c.compositor.render(p, t)
      return testing.readPixels(c.compositor.canvas, W, H)
    }
    const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
      let max = 0
      for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]))
      return max
    }
    const times = [0.4, 1.73, 3.2, 1.0, 6.05]
    const exportFrames = []
    for (const t of times) exportFrames.push(await grab(exp, t))
    const previewDiffs = []
    // Preview scrubs the same times in reverse order.
    for (let i = times.length - 1; i >= 0; i--)
      previewDiffs.push(diff(await grab(pre, times[i]), exportFrames[i]))
    const again = diff(await grab(exp, times[1]), exportFrames[1])
    const distinct = diff(exportFrames[0], exportFrames[1])
    exp.compositor.dispose()
    pre.compositor.dispose()
    return { previewDiffs, again, distinct }
  })
  expect(r.previewDiffs).toEqual([0, 0, 0, 0, 0])
  expect(r.again).toBe(0)
  expect(r.distinct).toBeGreaterThan(50)
  expect(errors).toEqual([])
})
