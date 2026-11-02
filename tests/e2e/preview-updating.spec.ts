import path from 'node:path'
import { expect, openHarness, test } from './fixtures.ts'

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../fixtures/.cache')

/**
 * A paused frame far past a key frame of 4K footage takes a while to decode, and the frame before stays on screen
 * meanwhile: the stage says it's updating, and stops once the new frame shows.
 */
test('the stage says “Updating…” while a slow paused frame decodes, and stops once it shows', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?project=empty&kind=blank'
  })
  await expect(page.getByText('Start with a song')).toBeVisible()
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Import a song' }).click()
  await (await chooser).setFiles(path.join(FIXTURE_DIR, 'song.mp3'))
  await page.getByLabel('Import media files').setInputFiles(path.join(FIXTURE_DIR, 'clip4k.mp4'))
  const card = page.getByRole('tabpanel', { name: 'Media' }).getByLabel('clip4k, video')
  await card.hover({ timeout: 30_000 })
  await card.getByRole('button', { name: 'Add at playhead' }).click()
  await expect(page.getByRole('button', { name: /^clip4k, 0:00/ })).toHaveCount(1)

  const stillPending = () => page.evaluate(() => window.mvStudio.app.stillPending() as boolean)
  const updating = page.getByRole('status').filter({ hasText: 'Updating…' })
  // Near the clip's key frame first, so its video is loaded and that frame shows.
  await page.evaluate(() => window.mvStudio.app.ui.set({ playhead: 0.2 }))
  await expect.poll(stillPending, { timeout: 30_000 }).toBe(false)
  await expect(updating).toHaveCount(0)

  // 5.5 s is 330 frames past the clip's only key frame.
  const seekAt = Date.now()
  await page.evaluate(() => window.mvStudio.app.ui.set({ playhead: 5.5 }))
  await expect(updating).toBeVisible({ timeout: 3_000 })
  const shownAfter = Date.now() - seekAt
  expect(await stillPending()).toBe(true)
  await expect(updating).toBeHidden({ timeout: 60_000 })
  console.log(`“Updating…” shown ${shownAfter} ms after the seek, gone after ${Date.now() - seekAt} ms`)
  expect(await stillPending()).toBe(false)
  const time = await page.evaluate(() => window.mvStudio.app.stagePreview()?.getSnapshot().time)
  expect(time).toBeCloseTo(5.5, 2)

  /** Shows 0.2 s, then 5.5 s again, and returns the note's box once it shows. */
  const slowSeek = async () => {
    await page.evaluate(() => window.mvStudio.app.ui.set({ playhead: 0.2 }))
    await expect.poll(stillPending, { timeout: 30_000 }).toBe(false)
    await expect(updating).toHaveCount(0, { timeout: 5_000 })
    await page.evaluate(() => window.mvStudio.app.ui.set({ playhead: 5.5 }))
    await expect(updating).toBeVisible({ timeout: 3_000 })
    const box = await updating.boundingBox()
    if (!box) throw new Error('The note has no box')
    return box
  }
  const canvas = page.getByRole('img', { name: 'Video preview' })

  // At 200% the frame is larger than the stage: the note is in the stage's visible bottom-right corner, not the
  // frame's, which is off screen.
  await page.evaluate(() => window.mvStudio.app.ui.set({ previewZoom: 2 }))
  const zoomed = await slowSeek()
  const stage = await canvas.locator('xpath=../..').boundingBox()
  const frame = await canvas.boundingBox()
  if (!stage || !frame) throw new Error('No stage')
  expect(frame.width).toBeGreaterThan(stage.width)
  expect(zoomed.x).toBeGreaterThanOrEqual(stage.x)
  expect(zoomed.y).toBeGreaterThanOrEqual(stage.y)
  // Within the stage, its scroll bars aside.
  expect(stage.x + stage.width - (zoomed.x + zoomed.width)).toBeGreaterThan(0)
  expect(stage.x + stage.width - (zoomed.x + zoomed.width)).toBeLessThan(40)
  expect(stage.y + stage.height - (zoomed.y + zoomed.height)).toBeGreaterThan(0)
  expect(stage.y + stage.height - (zoomed.y + zoomed.height)).toBeLessThan(40)
  await expect(updating).toBeHidden({ timeout: 60_000 })

  // In a narrow 9:16 frame the note is its spinner alone, still named for screen readers.
  await page.evaluate(() => window.mvStudio.app.ui.set({ previewZoom: 'fit' }))
  await page.getByRole('button', { name: '16:9', exact: true }).click()
  await page.getByRole('menuitem', { name: /^9:16/ }).click()
  await expect.poll(async () => (await canvas.boundingBox())?.width ?? 0).toBeLessThan(300)
  const narrow = await slowSeek()
  expect(narrow.width).toBeLessThan(30)
  expect(narrow.height).toBeCloseTo(zoomed.height, 0)
})
