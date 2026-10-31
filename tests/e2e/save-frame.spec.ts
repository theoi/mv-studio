import { readFile } from 'node:fs/promises'
import type { Page } from '@playwright/test'
import { expect, openApp, test, waitForPreview } from './fixtures.ts'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

/** Width, height and the spread of a few hundred sampled pixel values of a PNG, decoded by the browser. */
async function describePng(page: Page, path: string) {
  const bytes = await readFile(path)
  // PNG signature, then the IHDR chunk with the size.
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  return page.evaluate(async (base64) => {
    const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob()
    const bitmap = await createImageBitmap(blob)
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const values: number[] = []
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const [r, g, b] = ctx.getImageData(
          ((x + 0.5) / 16) * bitmap.width,
          ((y + 0.5) / 16) * bitmap.height,
          1,
          1,
        ).data
        values.push((r! + g! + b!) / 3)
      }
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    const spread = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length)
    return { width: bitmap.width, height: bitmap.height, mean, spread }
  }, bytes.toString('base64'))
}

test('Preview › Save frame downloads the frame at the playhead as a full-size PNG', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=67.2'
  })
  await waitForPreview(page)
  await page.getByRole('img', { name: 'Video preview' }).click({ button: 'right' })
  const download = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: /^Save frame/ }).click()
  const file = await download
  expect(file.suggestedFilename()).toBe('Neon Skyline - 1m07.2s.png')
  await expect(
    page
      .getByRole('status')
      .getByText('Saved Neon Skyline - 1m07.2s.png (1920 × 1080) to your Downloads folder.'),
  ).toBeVisible()
  // The sample's chorus: a lit, detailed frame, not a blank canvas.
  const png = await describePng(page, await file.path())
  expect(png).toMatchObject({ width: 1920, height: 1080 })
  expect(png.mean).toBeGreaterThan(10)
  expect(png.spread).toBeGreaterThan(10)
})

test('the command palette saves the frame too', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=20'
  })
  await waitForPreview(page)
  await page.keyboard.press(`${mod}+k`)
  await page.getByRole('dialog').getByRole('combobox').fill('Save frame')
  const download = page.waitForEvent('download')
  await page.keyboard.press('Enter')
  expect((await download).suggestedFilename()).toBe('Neon Skyline - 0m20.0s.png')
})
