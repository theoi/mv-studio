import type { Page } from '@playwright/test'
import { expect, openHarness, test } from './fixtures.ts'

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
