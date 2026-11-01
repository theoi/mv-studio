import type { Page } from '@playwright/test'
import { expect, openApp, openHarness, test, waitForPreview } from './fixtures.ts'

/** Mean luminance (0..255) of a PNG, decoded in the page. */
async function meanLuma(page: Page, png: Buffer): Promise<number> {
  return page.evaluate(async (b64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob())
    const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const d = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
    let sum = 0
    for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!
    return sum / (d.length / 4)
  }, png.toString('base64'))
}

/**
 * "Preparing the preview" goes away with the first frame. On the render worker that frame used to be reported when
 * it was queued, and the canvas stayed black while the GPU drew it (first-use shader compiles take a while).
 */
test('the editor preview shows its first frame as soon as "Preparing the preview" goes away', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=66.9'
  })
  const preview = page.getByRole('img', { name: 'Video preview' })
  await preview.waitFor()
  // Screenshots as fast as they come, each labeled with the busy state read just before it.
  const shots: { busy: string | null; luma: number }[] = []
  let readyAt = 0
  while (!readyAt || Date.now() - readyAt < 1500) {
    const busy = await preview.getAttribute('aria-busy')
    const box = await preview.boundingBox()
    if (!box || box.width < 10) continue
    if (busy === 'false' && !readyAt) readyAt = Date.now()
    shots.push({ busy, luma: await meanLuma(page, await page.screenshot({ clip: box })) })
    if (!readyAt && shots.length > 400) break
  }
  console.log('first frame shots', JSON.stringify(shots.map((s) => `${s.busy}:${s.luma.toFixed(1)}`)))
  const ready = shots.filter((s) => s.busy === 'false')
  expect(ready.length).toBeGreaterThan(2)
  // The scene at 1:06.9, not the black canvas behind it.
  expect(ready.filter((s) => s.luma < 12).map((s) => s.luma.toFixed(1))).toEqual([])
})

/** Starts (once) or restarts recording, before each paint, the editor preview's box, or null while it is not there. */
async function recordPaints(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { paints: ({ width: number; height: number } | null)[]; recording?: true }
    w.paints = []
    if (w.recording) return
    w.recording = true
    const tick = () => {
      const r = document.querySelector('canvas[aria-label="Video preview"]')?.getBoundingClientRect()
      w.paints.push(r ? { width: r.width, height: r.height } : null)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

async function expectFirstPaintAtSize(page: Page, from: string): Promise<void> {
  await waitForPreview(page)
  const { paints, settled } = await page.evaluate(() => {
    const r = document.querySelector('canvas[aria-label="Video preview"]')!.getBoundingClientRect()
    return {
      paints: (window as unknown as { paints: ({ width: number; height: number } | null)[] }).paints,
      settled: { width: r.width, height: r.height },
    }
  })
  const first = paints.findIndex((p) => p !== null)
  // Recorded from before the editor opened.
  expect(first, `paints ${from}`).toBeGreaterThan(0)
  expect(paints[first], `the editor's first paint ${from}`).toEqual(settled)
  expect(settled.width).toBeGreaterThan(100)
}

test("the editor's first paint has the preview at its size, from a link, from VJ mode and from the start screen", async ({
  page,
}) => {
  await openApp(page)
  await page.evaluate(() => localStorage.setItem('mv-studio.guide-seen', '1'))
  await recordPaints(page)
  await page.evaluate(() => (window.location.hash = '#/editor?t=60'))
  await expectFirstPaintAtSize(page, 'from a link')

  await page.getByRole('button', { name: 'VJ', exact: true }).click()
  await expect(page.getByRole('img', { name: 'Live output' })).toHaveAttribute('aria-busy', 'false', {
    timeout: 30_000,
  })
  await recordPaints(page)
  await page.getByRole('button', { name: 'Back to editor' }).click()
  await expectFirstPaintAtSize(page, 'from VJ mode')

  // Kept, so the start screen lists it.
  await page.keyboard.press('ControlOrMeta+s')
  await expect(page.getByText('Saved in this browser')).toBeVisible()
  await page.getByRole('button', { name: 'Home' }).click()
  const recent = page.getByRole('region', { name: 'Recent projects' })
  const project = recent.getByRole('button', { name: /^Neon Skyline/ })
  await project.waitFor()
  await recordPaints(page)
  await project.click()
  await expectFirstPaintAtSize(page, 'from the start screen')
})
