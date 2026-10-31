import type { Page } from '@playwright/test'
import type { Project, TextClip } from '../../src/model/types.ts'
import { expect, openHarness, test } from './fixtures.ts'

function collectErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  return errors
}

test('every kinetic preset animates words in, settles fully visible and can exit', async ({ page }) => {
  const errors = collectErrors(page)
  await openHarness(page)
  const r = await page.evaluate(async () => {
    const { engine, plugins, testing } = window.mvStudio
    const W = 320
    const H = 180
    const { compositor } = testing.createCompositor('export', W, H)
    const lit = async (p: Project, t: number) => {
      await compositor.render(p, t)
      const d = testing.readPixels(compositor.canvas, W, H)
      let n = 0
      for (let i = 0; i < d.length; i += 4) if (d[i]! + d[i + 1]! + d[i + 2]! > 480) n++
      return n / (d.length / 4)
    }
    const out: Record<string, { early: number; settled: number; end: number }> = {}
    for (const def of engine.pluginRegistry.list('text-animation')) {
      const { project }: { project: Project } = plugins.preview.pluginPreview(def.id)
      const clip = Object.values(project.clips).find((c) => c.type === 'text') as TextClip
      clip.animation!.params = { exit: 'fade', exitDuration: 0.4 }
      const start = clip.start
      out[def.id] = {
        early: await lit(project, start + 0.04),
        settled: await lit(project, start + clip.duration * 0.92 - 0.45),
        end: await lit(project, start + clip.duration - 0.01),
      }
    }
    compositor.dispose()
    return out
  })
  expect(Object.keys(r).length).toBeGreaterThanOrEqual(15)
  for (const [id, s] of Object.entries(r)) {
    expect(s.settled, `${id} shows the text`).toBeGreaterThan(0.01)
    expect(s.early, `${id} animates in`).toBeLessThan(s.settled * 0.7)
    expect(s.end, `${id} exits by the clip end`).toBeLessThan(s.settled * 0.25)
  }
  expect(errors).toEqual([])
})

test('bundled fonts load from the production build and are used by text clips', async ({ page }) => {
  const errors = collectErrors(page)
  await openHarness(page)
  const r = await page.evaluate(async () => {
    const { model, plugins, testing } = window.mvStudio
    const { BUNDLED_FONTS, fontStack } = plugins.typography.fonts
    const loaded: Record<string, number> = {}
    for (const font of BUNDLED_FONTS as { family: string; weights: [number, number] }[]) {
      const faces = await document.fonts.load(`${font.weights[0]} 40px "${font.family}"`, 'Abc')
      loaded[font.family] = faces.filter((f) => f.status === 'loaded').length
    }
    const W = 320
    const H = 180
    const { compositor } = testing.createCompositor('export', W, H)
    const render = async (fontFamily: string) => {
      const p = model.createProject({ name: 'font' })
      const clip = model.createTextClip({
        trackId: p.tracks[0].id,
        text: 'Night drive',
        start: 0,
        duration: 4,
      })
      clip.style = { ...clip.style, fontFamily, fontWeight: 400, fontSize: 160 }
      p.clips[clip.id] = clip
      await compositor.render(p, 1)
      return testing.readPixels(compositor.canvas, W, H)
    }
    const anton = await render(fontStack('Anton'))
    const fallback = await render('monospace')
    compositor.dispose()
    let differ = 0
    for (let i = 0; i < anton.length; i += 4) if (Math.abs(anton[i]! - fallback[i]!) > 60) differ++
    return { loaded, differ: differ / (anton.length / 4) }
  })
  expect(Object.keys(r.loaded).length).toBeGreaterThanOrEqual(14)
  for (const [family, count] of Object.entries(r.loaded)) expect(count, family).toBeGreaterThan(0)
  expect(r.differ).toBeGreaterThan(0.02)
  expect(errors).toEqual([])
})

test('random-looking kinetic presets render identically in preview and export', async ({ page }) => {
  const errors = collectErrors(page)
  await openHarness(page)
  const r = await page.evaluate(async () => {
    const { plugins, testing } = window.mvStudio
    const W = 192
    const H = 108
    const exp = testing.createCompositor('export', W, H)
    const pre = testing.createCompositor('preview', W, H)
    const out: Record<string, number[]> = {}
    for (const id of ['glitch-text', 'flicker', 'stamp', 'blur-in', 'bounce', 'sweep']) {
      const { project }: { project: Project } = plugins.preview.pluginPreview(id)
      const diffs = []
      for (const t of [1.05, 1.21, 1.6, 2.3]) {
        await exp.compositor.render(project, t)
        const a = testing.readPixels(exp.compositor.canvas, W, H)
        await pre.compositor.render(project, t)
        const b = testing.readPixels(pre.compositor.canvas, W, H)
        let max = 0
        for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i]! - b[i]!))
        diffs.push(max)
      }
      out[id] = diffs
    }
    exp.compositor.dispose()
    pre.compositor.dispose()
    return out
  })
  for (const [id, diffs] of Object.entries(r)) expect(diffs, id).toEqual([0, 0, 0, 0])
  expect(errors).toEqual([])
})
