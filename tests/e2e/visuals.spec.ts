import type { Page } from '@playwright/test'
import type { Project } from '../../src/model/types.ts'
import { expect, openHarness, test } from './fixtures.ts'

function collectErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  return errors
}

test('every visual draws at its defaults, moves over time and follows the music', async ({ page }) => {
  const errors = collectErrors(page)
  await openHarness(page)
  const r = await page.evaluate(async () => {
    const { engine, plugins, testing } = window.mvStudio
    const W = 256
    const H = 144
    const { compositor } = testing.createCompositor('export', W, H)
    const grab = async (p: unknown, t: number) => {
      await compositor.render(p, t)
      return testing.readPixels(compositor.canvas, W, H)
    }
    const meanDiff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
      let d = 0
      for (let i = 0; i < a.length; i += 4)
        d += Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!)
      return d / (a.length / 4) / 3
    }
    const out: Record<string, { lit: number; moves: number; music: number }> = {}
    for (const def of engine.pluginRegistry.list('generator')) {
      const { project, time } = plugins.preview.pluginPreview(def.id)
      const silent: Project = structuredClone(project)
      for (const analysis of Object.values(silent.analysis.audio)) {
        const features = analysis.features!
        features.loudness = features.loudness.map(() => 0)
        features.bands = features.bands.map((b) => b.map(() => 0))
        features.onsets = []
        analysis.beats = []
        analysis.downbeats = []
      }
      const a = await grab(project, time)
      const later = await grab(project, time + 0.5)
      const quiet = await grab(silent, time)
      let lit = 0
      for (let i = 0; i < a.length; i += 4) if (a[i]! + a[i + 1]! + a[i + 2]! > 90) lit++
      out[def.id] = { lit: lit / (a.length / 4), moves: meanDiff(a, later), music: meanDiff(a, quiet) }
    }
    compositor.dispose()
    return out
  })
  expect(Object.keys(r).length).toBeGreaterThanOrEqual(12)
  for (const [id, s] of Object.entries(r)) {
    expect(s.lit, `${id} draws something`).toBeGreaterThan(0.01)
    expect(s.moves, `${id} moves over time`).toBeGreaterThan(0.2)
    expect(s.music, `${id} follows the music`).toBeGreaterThan(0.2)
  }
  expect(errors).toEqual([])
})

test('scenes lay over footage with a transparent background, and the circle shows artwork', async ({
  page,
}) => {
  const errors = collectErrors(page)
  await openHarness(page)
  const r = await page.evaluate(async () => {
    const { engine, media, plugins, testing } = window.mvStudio
    const W = 128
    const H = 72
    const { compositor } = testing.createCompositor('export', W, H)
    const meanRgb = async (p: unknown, t: number) => {
      await compositor.render(p, t)
      const d = testing.readPixels(compositor.canvas, W, H)
      const sum = [0, 0, 0]
      for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) sum[c]! += d[i + c]!
      return sum.map((s) => s / (d.length / 4))
    }
    const scenes: Record<string, number> = {}
    for (const def of engine.pluginRegistry.list('generator')) {
      if (!def.params.some((p: { key: string }) => p.key === 'background')) continue
      const { project, time }: { project: Project; time: number } = plugins.preview.pluginPreview(def.id)
      const clip = Object.values(project.clips).find((c) => c.type === 'generator')!
      if (clip.type !== 'generator') continue
      clip.params.background = { value: '#00000000' }
      project.settings.backgroundColor = '#ff0000'
      const red = await meanRgb(project, time)
      project.settings.backgroundColor = '#0000ff'
      const blue = await meanRgb(project, time)
      scenes[def.id] = red[0]! - blue[0]!
    }
    const image = await media.mediaStore.storeBlob(await plugins.preview.sampleSceneBlob(), {
      kind: 'image',
      name: 'cover.png',
      origin: { type: 'generated' },
    })
    const { project, time }: { project: Project; time: number } =
      plugins.preview.pluginPreview('visualizer.circle')
    project.assets[image.id] = image
    const clip = Object.values(project.clips).find((c) => c.type === 'generator')!
    await compositor.render(project, time)
    const plain = testing.readPixels(compositor.canvas, W, H)
    if (clip.type === 'generator') clip.params.artwork = { value: image.id }
    await compositor.render(project, time)
    const withArt = testing.readPixels(compositor.canvas, W, H)
    const center = ((H / 2) * W + W / 2) * 4
    compositor.dispose()
    return {
      scenes,
      artCenter: [withArt[center], withArt[center + 1], withArt[center + 2]],
      plainCenter: [plain[center], plain[center + 1], plain[center + 2]],
    }
  })
  expect(Object.keys(r.scenes).length).toBeGreaterThanOrEqual(7)
  for (const [id, shows] of Object.entries(r.scenes))
    expect(shows, `${id} shows what is below`).toBeGreaterThan(20)
  const brightness = (c: (number | undefined)[]) => c.reduce<number>((s, v) => s + (v ?? 0), 0)
  expect(brightness(r.artCenter) - brightness(r.plainCenter)).toBeGreaterThan(25)
  expect(errors).toEqual([])
})

test('spectrum bars keep the shape of a loud, compressed chorus and calm down in quiet parts', async ({
  page,
}) => {
  const errors = collectErrors(page)
  await openHarness(page)
  const r = await page.evaluate(async () => {
    const { plugins, testing } = window.mvStudio
    const W = 256
    const H = 144
    const { compositor } = testing.createCompositor('export', W, H)
    const { project, time } = plugins.preview.pluginPreview('visualizer.spectrum')
    // Features of a compressed master: every band at about its loud level (0.9), or all quiet.
    const withLevels = (loudness: number, bands: number[]) => {
      const p: Project = structuredClone(project)
      for (const analysis of Object.values(p.analysis.audio)) {
        const features = analysis.features!
        features.loudness = features.loudness.map(() => loudness)
        features.bands = features.bands.map(() => [...bands])
      }
      return p
    }
    const barHeights = async (p: unknown) => {
      await compositor.render(p, time)
      const px = testing.readPixels(compositor.canvas, W, H)
      return Array.from({ length: 32 }, (_, bar) => {
        const x = Math.round((bar + 0.5) * (W / 32))
        let top = H
        for (let y = 0; y < H; y++) {
          const i = (y * W + x) * 4
          if (px[i]! + px[i + 1]! + px[i + 2]! > 200) {
            top = y
            break
          }
        }
        return (H - top) / (0.6 * H)
      })
    }
    const loud = await barHeights(withLevels(0.9, [0.95, 0.9, 0.88, 0.9, 0.86, 0.9, 0.84]))
    const quiet = await barHeights(withLevels(0.4, [0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4]))
    compositor.dispose()
    return { loud, quiet }
  })
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  const spread = (xs: number[]) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2))) / mean(xs)
  console.log(
    'spectrum heights',
    JSON.stringify({ loud: r.loud.map((h) => +h.toFixed(2)), quiet: mean(r.quiet) }),
  )
  // Loud: tall bars that still differ from one another instead of a flat wall at one height, few touching the top.
  expect(mean(r.loud)).toBeGreaterThan(0.55)
  expect(spread(r.loud)).toBeGreaterThan(0.1)
  expect(r.loud.filter((h) => h >= 0.97).length).toBeLessThanOrEqual(8)
  // Quiet: clearly lower.
  expect(mean(r.quiet)).toBeLessThan(0.6 * mean(r.loud))
  expect(errors).toEqual([])
})
