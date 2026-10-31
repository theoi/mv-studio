import { readFile } from 'node:fs/promises'
import type { Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function openEditor(page: Page, hash: string) {
  await openHarness(page)
  await page.evaluate((h) => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = h
  }, hash)
  await waitForPreview(page)
}

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
  await openEditor(page, '#/editor?t=67.2')
  const preview = page.getByRole('img', { name: 'Video preview' })
  const toasts = page.getByRole('status')
  const saving = toasts.getByText('Saving frame…')
  const saved = toasts.getByText('Saved Neon Skyline - 1m07.2s.png (1920 × 1080)')

  await preview.click({ button: 'right' })
  await expect(page.getByRole('menu').getByText('PNG · 1920 × 1080')).toBeVisible()
  const download = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: /^Save frame/ }).click()
  await expect(saving).toBeVisible()
  const file = await download
  expect(file.suggestedFilename()).toBe('Neon Skyline - 1m07.2s.png')
  await expect(saved).toBeVisible()
  await expect(saving).toBeHidden()
  // The sample's chorus: a lit, detailed frame, not a blank canvas.
  const png = await describePng(page, await file.path())
  expect(png).toMatchObject({ width: 1920, height: 1080 })
  expect(png.mean).toBeGreaterThan(10)
  expect(png.spread).toBeGreaterThan(10)
})

test('a second Save frame while one is drawn joins it: one file, one result', async ({ page }) => {
  await openEditor(page, '#/editor?t=20')
  const downloads: string[] = []
  page.on('download', (d) => downloads.push(d.suggestedFilename()))
  // Both requests in one task: the UI can't click twice faster than a fast machine draws the frame.
  const joined = await page.evaluate(async () => {
    const { saveFrame } = window.mvStudio.app.stills
    const first = saveFrame(20)
    const second = saveFrame(20)
    await Promise.all([first, second])
    return first === second
  })
  expect(joined).toBe(true)
  // Not retried: both requests have finished, so a second save would have shown its result by now.
  expect(
    await page
      .getByRole('status')
      .getByText(/^Saved Neon Skyline - 0m20\.0s\.png/)
      .count(),
  ).toBe(1)
  await expect.poll(() => downloads).toEqual(['Neon Skyline - 0m20.0s.png'])
})

/** Starts playback and waits until the playhead moves. */
async function play(page: Page) {
  const start = await playhead(page)
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect.poll(() => playhead(page), { timeout: 30_000 }).toBeGreaterThan(start + 0.2)
}

const playhead = (page: Page) => page.evaluate(() => window.mvStudio.app.ui.get().playhead)

/** The moment in a saved frame's name, in seconds. */
function timeInName(name: string): number {
  const [, minutes, seconds] = /(\d+)m([\d.]+)s\.png$/.exec(name) ?? []
  return Number(minutes) * 60 + Number(seconds)
}

// Playback goes on while a menu or the palette is open; the saved frame is the one on screen when it opened. The
// name rounds to a tenth of a second.
test('during playback, Save frame saves the frame that was right-clicked', async ({ page }) => {
  await openEditor(page, '#/editor?t=20')
  await play(page)
  const before = await playhead(page)
  await page.getByRole('img', { name: 'Video preview' }).click({ button: 'right' })
  const item = page.getByRole('menuitem', { name: /^Save frame/ })
  await expect(item).toBeVisible()
  const opened = await playhead(page)
  await expect.poll(() => playhead(page)).toBeGreaterThan(opened + 0.6)
  const download = page.waitForEvent('download')
  await item.click()
  const time = timeInName((await download).suggestedFilename())
  expect(time).toBeGreaterThanOrEqual(before - 0.06)
  expect(time).toBeLessThanOrEqual(opened + 0.06)
})

test('the command palette saves the frame too, the one when the palette opened', async ({ page }) => {
  await openEditor(page, '#/editor?t=20')
  await play(page)
  const before = await playhead(page)
  await page.keyboard.press(`${mod}+k`)
  const palette = page.getByRole('dialog')
  await palette.getByRole('combobox').fill('Save frame')
  const opened = await playhead(page)
  await expect.poll(() => playhead(page)).toBeGreaterThan(opened + 0.6)
  const download = page.waitForEvent('download')
  await palette.getByRole('option', { name: 'Save frame' }).click()
  const name = (await download).suggestedFilename()
  expect(name).toMatch(/^Neon Skyline - 0m2\d\.\ds\.png$/)
  expect(timeInName(name)).toBeGreaterThanOrEqual(before - 0.06)
  expect(timeInName(name)).toBeLessThanOrEqual(opened + 0.06)
})
