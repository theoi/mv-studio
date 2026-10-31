import type { Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

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
