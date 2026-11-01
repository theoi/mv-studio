import type { Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

/** Zooming the timeline: Ctrl or Mod with the wheel, and clips that follow the zoom. */

async function openEditor(page: Page, hash: string) {
  await openHarness(page)
  await page.evaluate((h) => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = h
  }, hash)
  await waitForPreview(page)
}

test('wheel notches within one frame zoom once, around the pointer, and the clips follow the zoom', async ({
  page,
}) => {
  await openEditor(page, '#/editor?t=67')
  const clip = page.getByRole('button', { name: 'Spectrum bars, 1:04.0 to 1:36.0' })
  await expect(clip).toBeVisible()
  const r = await page.evaluate(async () => {
    const { ui } = window.mvStudio.app
    const el = document.querySelector<HTMLElement>('[data-timeline-scroller]')!
    const box = el.getBoundingClientRect()
    const x = box.left + box.width * 0.6
    const before = ui.get().pxPerSec
    const zooms: number[] = []
    const off = ui.useUi.subscribe((s: { pxPerSec: number }, p: { pxPerSec: number }) => {
      if (s.pxPerSec !== p.pxPerSec) zooms.push(s.pxPerSec)
    })
    const scroller = () => el.getBoundingClientRect().left
    const timeAt = (pps: number) => (el.scrollLeft + x - scroller() - 148) / pps
    const tBefore = timeAt(before)
    // Five notches in one task, as a fast wheel or a trackpad sends them.
    for (let i = 0; i < 5; i++)
      el.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -40, ctrlKey: true, clientX: x, bubbles: true, cancelable: true }),
      )
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
    off()
    const after = ui.get().pxPerSec
    return { before, zooms, after, tBefore, tAfter: timeAt(after) }
  })
  expect(r.zooms).toHaveLength(1)
  expect(r.after).toBeCloseTo(r.before * Math.exp(200 * 0.0025), 6)
  // The time under the pointer stays under it.
  expect(r.tAfter).toBeCloseTo(r.tBefore, 1)

  // The clip's place and length follow the new zoom.
  const ruler = (await page.locator('[data-timeline-scroller] [class*="ruler"]').first().boundingBox())!
  const box = (await clip.boundingBox())!
  expect(box.x - ruler.x).toBeCloseTo(64 * r.after, 0)
  expect(box.width).toBeCloseTo(32 * r.after, 0)
})

test('in every frame of a wheel zoom, the time under the pointer stays under it', async ({ page }) => {
  await openEditor(page, '#/editor?t=67')
  await expect(page.getByRole('button', { name: 'Spectrum bars, 1:04.0 to 1:36.0' })).toBeVisible()
  const frames = await page.evaluate(async () => {
    const el = document.querySelector<HTMLElement>('[data-timeline-scroller]')!
    const box = el.getBoundingClientRect()
    const x = box.left + box.width * 0.6
    // As laid out, from the clip's box: it runs from 64 s to 96 s.
    const sample = () => {
      const clip = el
        .querySelector<HTMLElement>('[aria-label="Spectrum bars, 1:04.0 to 1:36.0"]')!
        .getBoundingClientRect()
      const scale = clip.width / 32
      return { scale, time: 64 + (x - clip.left) / scale }
    }
    // Ten notches in, ten out, then larger ones in until the zoom stops at its limit, one notch a frame.
    const notches = [...Array(10).fill(-40), ...Array(10).fill(40), ...Array(10).fill(-120)]
    const frames: { scale: number; time: number }[] = []
    await new Promise<void>((resolve) => {
      let i = 0
      const after = () => {
        frames.push(sample())
        if (i === notches.length) return requestAnimationFrame(() => resolve(void frames.push(sample())))
        // Next frame: a sample ahead of the wheel's step (what this frame left, and whatever ran between frames),
        // the step, then a sample after it (what the step paints).
        requestAnimationFrame(() => frames.push(sample()))
        el.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: notches[i++],
            ctrlKey: true,
            clientX: x,
            bubbles: true,
            cancelable: true,
          }),
        )
        requestAnimationFrame(after)
      }
      requestAnimationFrame(after)
    })
    return frames
  })
  const steps = frames.filter((f, i) => i > 0 && f.scale !== frames[i - 1]!.scale).length
  expect(steps).toBeGreaterThan(20)
  // Against the frame before, not the first: rounding of each step's scroll position adds up over 30 steps and
  // grows with the zoom, but no frame moves the time under the pointer by more than that rounding.
  const worst = Math.max(...frames.slice(1).map((f, i) => Math.abs(f.time - frames[i]!.time) * f.scale))
  expect(worst).toBeLessThan(1.5)
})

test('a short clip shows its name once a zoom makes it wide enough, and hides it again zooming out', async ({
  page,
}) => {
  await openEditor(page, '#/editor?t=67')
  await page.evaluate(() => {
    const { app, plugins } = window.mvStudio
    const project = app.project.editor.getProject()
    const track = project.tracks.find((t: { name: string }) => t.name === 'Overlay')
    const clip = plugins.library.createGeneratorClip({
      trackId: track.id,
      generatorId: 'visualizer.circle',
      start: 66,
      duration: 1.5,
    })
    app.project.editor.dispatch({ type: 'clip.add', clip: { ...clip, id: 'e2e-short' } })
  })
  const label = page.locator('[data-clip-id="e2e-short"] [class*="clipLabel"]')
  const zoom = (pps: number) =>
    page.evaluate(async (v) => {
      window.mvStudio.app.ui.set({ pxPerSec: v })
      await new Promise(requestAnimationFrame)
      document.querySelector('[data-timeline-scroller]')!.scrollLeft = 66 * v - 200
    }, pps)
  // 1.5 s is 45 px at 30 px/s, too narrow for a name, and 60 px at 40 px/s.
  // Inner text: the name stays in the DOM and hides by the clip's width.
  await zoom(30)
  await expect(label).toHaveText('', { useInnerText: true })
  await zoom(40)
  await expect(label).toHaveText('Circle spectrum', { useInnerText: true })
  await zoom(30)
  await expect(label).toHaveText('', { useInnerText: true })
})

test('a short footage clip shows its name chip only when the name fits or the clip is wide, else its picture and a title', async ({
  page,
}) => {
  await openEditor(page, '#/editor?t=67')
  const duration = await page.evaluate(
    () => window.mvStudio.app.project.editor.getProject().clips['c-s-c1-1'].duration as number,
  )
  const tile = page.locator('[data-clip-id="c-s-c1-1"]')
  const label = tile.locator('[class*="mediaLabel"]')
  const zoom = (pps: number) =>
    page.evaluate(async (v) => {
      window.mvStudio.app.ui.set({ pxPerSec: v })
      await new Promise(requestAnimationFrame)
      document.querySelector('[data-timeline-scroller]')!.scrollLeft = 66 * v - 200
    }, pps)
  // 96 px, as the sample's 8 s shots are at the default zoom: room for a short name whole.
  await zoom(96 / duration)
  await expect(label).toHaveText('Singer close-up')
  await expect(label).toBeVisible()
  await expect(tile).not.toHaveAttribute('title')

  // A long file name would show as "clip…" over most of the picture: the picture shows alone, the name on hover.
  const long = 'clip05_16x9_bay-4k.webm'
  await page.evaluate(
    (name) =>
      window.mvStudio.app.project.editor.dispatch({
        type: 'clip.set',
        clipId: 'c-s-c1-1',
        path: ['name'],
        value: name,
      }),
    long,
  )
  await expect(label).toHaveCount(0)
  await expect(tile).toHaveAttribute('title', long)
  await expect(tile).toHaveCSS('background-image', /^url\(/)
  await zoom(200 / duration)
  await expect(label).toBeVisible()
  await expect(tile).not.toHaveAttribute('title')
  await zoom(96 / duration)
  await expect(label).toHaveCount(0)
})

test('the zoom buttons, keys and slider keep the playhead where it is on screen, or the middle of the view when the playhead is out of view', async ({
  page,
}) => {
  await openEditor(page, '#/editor?t=85.44')
  const spectrum = 'Spectrum bars, 1:04.0 to 1:36.0'
  await expect(page.getByRole('button', { name: spectrum })).toBeVisible()
  /** Where `t` is, in px from the lanes' left edge, from the Spectrum bars clip's box as laid out (64 s to 96 s). */
  const view = (t: number) =>
    page.evaluate(
      ({ label, t }) => {
        const el = document.querySelector<HTMLElement>('[data-timeline-scroller]')!
        const clip = el.querySelector<HTMLElement>(`[aria-label="${label}"]`)!.getBoundingClientRect()
        const lanes = el.getBoundingClientRect().left + 148
        const width = el.clientWidth - 148
        const scale = clip.width / 32
        return {
          x: clip.left + (t - 64) * scale - lanes,
          middle: 64 + (lanes + width / 2 - clip.left) / scale,
          scale,
          width,
          pps: window.mvStudio.app.ui.get().pxPerSec as number,
        }
      },
      { label: spectrum, t },
    )
  const start = await view(85.44)
  expect(start.x).toBeGreaterThan(0)
  expect(start.x).toBeLessThan(start.width)
  const stays = async () => {
    const now = await view(85.44)
    expect(Math.abs(now.x - start.x)).toBeLessThan(3)
    return now
  }

  // Up to the closest zoom, a press at a time.
  let at = start
  while (at.pps < 80) {
    await page.getByRole('button', { name: 'Zoom in' }).click()
    const before = at.pps
    at = await stays()
    expect(at.pps).toBeGreaterThan(before)
  }
  expect(at.scale).toBeCloseTo(80, 1)
  await page.getByRole('button', { name: 'Zoom out' }).click()
  at = await stays()
  expect(at.pps).toBeCloseTo(80 / 1.4, 3)
  await page.keyboard.press(`${mod}+Equal`)
  at = await stays()
  expect(at.pps).toBe(80)
  await page.keyboard.press(`${mod}+Minus`)
  at = await stays()
  expect(at.pps).toBeCloseTo(80 / 1.4, 3)
  await page.getByRole('slider', { name: 'Timeline zoom' }).press('ArrowRight')
  const slid = await stays()
  expect(slid.pps).toBeGreaterThan(at.pps)

  // The playhead 2 s past the right edge of the view: Zoom out keeps the time in the middle of the view in place.
  await page.evaluate((s) => {
    const el = document.querySelector<HTMLElement>('[data-timeline-scroller]')!
    el.scrollLeft = (85.44 - s.width / s.pps - 2) * s.pps
  }, slid)
  const away = await view(85.44)
  expect(away.x).toBeGreaterThan(away.width)
  await page.getByRole('button', { name: 'Zoom out' }).click()
  const out = await view(85.44)
  expect(out.pps).toBeLessThan(away.pps)
  expect(Math.abs(out.middle - away.middle) * out.scale).toBeLessThan(2)
})
