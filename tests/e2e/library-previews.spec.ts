import type { Locator, Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

async function openEffectsTab(page: Page) {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?lib=effects&t=66.9'
  })
  await waitForPreview(page)
  return page.getByRole('tabpanel', { name: 'Effects' })
}

/** Mean absolute pixel difference (0..255) between two same-sized PNGs. */
async function imageDiff(page: Page, a: Buffer, b: Buffer): Promise<number> {
  return page.evaluate(
    async ([a64, b64]) => {
      const read = async (s: string) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob())
        const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!
        ctx.drawImage(bitmap, 0, 0)
        return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
      }
      const [x, y] = await Promise.all([read(a64), read(b64)])
      let sum = 0
      for (let i = 0; i < x.length; i++) if (i % 4 !== 3) sum += Math.abs(x[i] - y[i])
      return sum / ((x.length / 4) * 3)
    },
    [a.toString('base64'), b.toString('base64')],
  )
}

/** How much a tile changes over a quarter of a second. */
async function motion(page: Page, tile: Locator): Promise<number> {
  const a = await tile.screenshot()
  await page.waitForTimeout(250)
  return imageDiff(page, a, await tile.screenshot())
}

test('hovering a look tile plays the look on the sample scene in place, until the pointer leaves', async ({
  page,
}) => {
  const library = await openEffectsTab(page)
  const tile = library.getByRole('button', { name: 'Golden hour', exact: true })
  const still = await tile.screenshot()
  expect(await motion(page, tile)).toBeLessThan(0.5)

  await tile.hover()
  await expect.poll(() => motion(page, tile)).toBeGreaterThan(1)
  // Hovering only previews: the project keeps its look.
  await expect(library.getByRole('button', { name: 'Neon night', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  await page.mouse.move(700, 450)
  await expect.poll(async () => imageDiff(page, still, await tile.screenshot())).toBeLessThan(0.5)
  expect(await motion(page, tile)).toBeLessThan(0.5)
})

test('with reduced motion, tiles keep their still thumbnails on hover', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const library = await openEffectsTab(page)
  const tile = library.getByRole('button', { name: 'Golden hour', exact: true })
  await tile.hover()
  await page.waitForTimeout(800)
  expect(await motion(page, tile)).toBeLessThan(0.5)
})

test('with Settings › Reduce motion on, tiles keep their still thumbnails on hover', async ({ page }) => {
  await openHarness(page)
  await page.evaluate(() => localStorage.setItem('mv-studio.prefs', JSON.stringify({ reduceMotion: true })))
  const library = await openEffectsTab(page)
  const tile = library.getByRole('button', { name: 'Golden hour', exact: true })
  await tile.hover()
  await page.waitForTimeout(800)
  expect(await motion(page, tile)).toBeLessThan(0.5)
})
