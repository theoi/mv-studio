import type { Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

/**
 * Timeline editing through the UI on the sample project: selecting several clips (Shift and Mod click, marquee,
 * Mod A), copy, cut, paste, duplicate and Delete from the keyboard and the clip menu, and dragging and trimming clips,
 * with the main thread measured during the drags.
 */

// Trace recording snapshots the DOM on every pointer move, which the drag measurements would count as the app's work.
test.use({ trace: 'off' })

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function openEditor(page: Page, hash: string) {
  await openHarness(page)
  await page.evaluate((h) => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = h
  }, hash)
  await waitForPreview(page)
}

interface ClipSpan {
  id: string
  trackId: string
  start: number
  end: number
}

const selectedIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const { ui } = window.mvStudio.app
    return ui.selectedClipIds(ui.get().selection)
  })

const clipsOn = (page: Page, trackIds: string[]): Promise<ClipSpan[]> =>
  page.evaluate(
    (ids) =>
      (
        Object.values(window.mvStudio.app.project.editor.getProject().clips) as {
          id: string
          trackId: string
          start: number
          duration: number
        }[]
      )
        .filter((c) => ids.includes(c.trackId))
        .map((c) => ({ id: c.id, trackId: c.trackId, start: c.start, end: c.start + c.duration }))
        .sort((a, b) => a.start - b.start),
    trackIds,
  )

const trackCount = (page: Page): Promise<number> =>
  page.evaluate(() => window.mvStudio.app.project.editor.getProject().tracks.length)

/** Waits until the main thread has no long tasks: the sample media (scene videos, the song) are made on first use. */
async function settle(page: Page) {
  for (let i = 0; i < 40; i++) {
    const quiet = await page.evaluate(async () => {
      const sample = window.mvStudio.testing.bench.sampleMainThread()
      await new Promise((resolve) => setTimeout(resolve, 500))
      return sample.stop().longTasks === 0
    })
    if (quiet) return
  }
}

/** Main-thread responsiveness while `action` runs (testing.bench.sampleMainThread). */
async function measured<T>(page: Page, action: () => Promise<T>) {
  await page.evaluate(() => {
    window.mvStudio.mainSample = window.mvStudio.testing.bench.sampleMainThread()
  })
  await action()
  return page.evaluate(() => window.mvStudio.mainSample.stop())
}

test('Shift and Mod click select several clips, and copy, paste, duplicate, cut and Delete are one undo step each', async ({
  page,
}) => {
  await openEditor(page, '#/editor?t=67')
  const singer = page.getByRole('button', { name: 'Singer close-up, 1:06.0 to 1:08.0' })
  const next = page.getByRole('button', { name: /, 1:08\.0 to 1:10\.0$/ })
  await singer.click()
  await next.click({ modifiers: ['Shift'] })
  await expect(singer).toHaveAttribute('aria-pressed', 'true')
  await expect(next).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('2 clips', { exact: true })).toBeVisible()
  await next.click({ modifiers: [mod] })
  await expect(next).toHaveAttribute('aria-pressed', 'false')
  await expect(singer).toHaveAttribute('aria-pressed', 'true')
  await next.click({ modifiers: [mod] })
  expect(await selectedIds(page)).toHaveLength(2)

  const tracks = await trackCount(page)
  await page.keyboard.press(`${mod}+c`)
  await expect(page.getByText('Copied 2 clips')).toBeVisible()
  await page.keyboard.press(`${mod}+v`)
  // The Video track is taken at the playhead (1:07), so the copies go on a new track above it.
  const pasted = [
    page.getByRole('button', { name: 'Singer close-up, 1:07.0 to 1:09.0' }),
    page.getByRole('button', { name: /, 1:09\.0 to 1:11\.0$/ }),
  ]
  for (const c of pasted) await expect(c).toHaveAttribute('aria-pressed', 'true')
  expect(await trackCount(page)).toBe(tracks + 1)
  await page.keyboard.press(`${mod}+z`)
  await expect(page.getByText('Undid: Paste 2 clips')).toBeVisible()
  for (const c of pasted) await expect(c).toBeHidden()
  expect(await trackCount(page)).toBe(tracks)

  await singer.click()
  await page.keyboard.press('Delete')
  await expect(singer).toBeHidden()
  await page.keyboard.press(`${mod}+z`)
  await expect(singer).toBeVisible()

  await singer.click()
  await page.keyboard.press(`${mod}+d`)
  const copy = page.getByRole('button', { name: 'Singer close-up, 1:08.0 to 1:10.0' })
  await expect(copy).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press(`${mod}+z`)
  await expect(page.getByText('Undid: Duplicate clip')).toBeVisible()
  await expect(copy).toBeHidden()

  await singer.click()
  await page.keyboard.press(`${mod}+x`)
  await expect(singer).toBeHidden()
  await page.keyboard.press(`${mod}+v`)
  await expect(page.getByRole('button', { name: 'Singer close-up, 1:07.0 to 1:09.0' })).toBeVisible()
  await page.keyboard.press(`${mod}+z`)
  await page.keyboard.press(`${mod}+z`)
  await expect(page.getByText('Undid: Cut clip')).toBeVisible()
  await expect(singer).toBeVisible()
})

test('the clip menu splits, copies, pastes, duplicates and deletes', async ({ page }) => {
  await openEditor(page, '#/editor?t=67')
  const menuItem = (name: RegExp) => page.getByRole('menu').getByRole('menuitem', { name })
  await page.getByRole('button', { name: 'Singer close-up, 1:06.0 to 1:08.0' }).click({ button: 'right' })
  await menuItem(/^Split at playhead/).click()
  const first = page.getByRole('button', { name: 'Singer close-up, 1:06.0 to 1:07.0' })
  const second = page.getByRole('button', { name: 'Singer close-up, 1:07.0 to 1:08.0' })
  await expect(first).toBeVisible()
  await expect(second).toBeVisible()

  // Right-clicking a clip selects it; the open menu hides the rest of the page from the accessibility tree.
  await second.click({ button: 'right' })
  await menuItem(/^Copy/).click()
  await expect(page.getByText('Copied 1 clip')).toBeVisible()
  await expect(second).toHaveAttribute('aria-pressed', 'true')
  await first.click({ button: 'right' })
  await menuItem(/^Paste/).click()
  await expect(second).toHaveCount(2)

  await first.click({ button: 'right' })
  await menuItem(/^Duplicate/).click()
  await expect(page.getByRole('button', { name: 'Singer close-up, 1:07.0 to 1:08.0' })).toHaveCount(3)

  await first.click({ button: 'right' })
  await menuItem(/^Delete/).click()
  await expect(first).toBeHidden()
})

test('a marquee and Mod A select clips, and dragging and trimming move them, smoothly', async ({ page }) => {
  test.setTimeout(120_000)
  await openEditor(page, '#/editor?t=67')
  // Snapping off: drags then move clips by exactly the pointer's distance.
  await page.keyboard.press('n')
  const pps: number = await page.evaluate(() => window.mvStudio.app.ui.get().pxPerSec)
  const spectrum = page.getByRole('button', { name: 'Spectrum bars, 1:04.0 to 1:36.0' })
  const singer = page.getByRole('button', { name: 'Singer close-up, 1:06.0 to 1:08.0' })
  const spec = (await spectrum.boundingBox())!
  const video = (await singer.boundingBox())!
  const xAt = (t: number) => spec.x + (t - 64) * pps
  await settle(page)
  const idle = await measured(page, () => page.waitForTimeout(1000))

  // Marquee from empty Overlay space at 0:50.5 down to the Video track at 1:09.5.
  const marquee = await measured(page, async () => {
    await page.mouse.move(xAt(50.5), spec.y + spec.height / 2)
    await page.mouse.down()
    await page.mouse.move(xAt(69.5), video.y + video.height / 2, { steps: 40 })
    await page.mouse.up()
  })
  const touched = (await clipsOn(page, ['t-overlay', 't-video']))
    .filter((c) => c.start < 69.5 && c.end > 50.5)
    .map((c) => c.id)
  expect(touched.length).toBeGreaterThan(5)
  expect(new Set(await selectedIds(page))).toEqual(new Set(touched))
  await expect(page.getByText(`${touched.length} clips`, { exact: true })).toBeVisible()

  // Mod A takes every clip on the selected clip's track.
  await spectrum.click()
  await page.keyboard.press(`${mod}+a`)
  const overlay = await clipsOn(page, ['t-overlay'])
  expect(new Set(await selectedIds(page))).toEqual(new Set(overlay.map((c) => c.id)))

  // Dragging one of them moves all four; the title, at 0:01, stops the group 1 s to the left.
  const group = await measured(page, async () => {
    await page.mouse.move(spec.x + spec.width / 2, spec.y + spec.height / 2)
    await page.mouse.down()
    await page.mouse.move(spec.x + spec.width / 2 - 3 * pps, spec.y + spec.height / 2, { steps: 30 })
    await page.mouse.up()
  })
  const moved = await clipsOn(page, ['t-overlay'])
  expect(moved.map((c) => c.start)).toEqual(overlay.map((c) => c.start - 1))
  await page.keyboard.press(`${mod}+z`)
  expect((await clipsOn(page, ['t-overlay'])).map((c) => c.start)).toEqual(overlay.map((c) => c.start))

  // One clip: drag it 2 s right, then trim 2 s off each end.
  await page.keyboard.press('Escape')
  await page.mouse.move(spec.x + spec.width / 2, spec.y + spec.height / 2)
  await page.mouse.down()
  await page.mouse.move(spec.x + spec.width / 2 + 2 * pps, spec.y + spec.height / 2, { steps: 20 })
  await page.mouse.up()
  const dragged = page.getByRole('button', { name: 'Spectrum bars, 1:06.0 to 1:38.0' })
  await expect(dragged).toHaveAttribute('aria-pressed', 'true')
  const box = (await dragged.boundingBox())!
  const trim = await measured(page, async () => {
    await page.mouse.move(box.x + 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + 2 + 2 * pps, box.y + box.height / 2, { steps: 20 })
    await page.mouse.up()
    await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 2 - 2 * pps, box.y + box.height / 2, { steps: 20 })
    await page.mouse.up()
  })
  await expect(page.getByRole('button', { name: 'Spectrum bars, 1:08.0 to 1:36.0' })).toBeVisible()
  await page.keyboard.press(`${mod}+z`)
  await expect(page.getByRole('button', { name: 'Spectrum bars, 1:08.0 to 1:38.0' })).toBeVisible()

  console.log(
    'timeline main thread (idle, marquee, group drag, trim)',
    JSON.stringify({ idle, marquee, group, trim }),
  )
  for (const sample of [marquee, group, trim]) {
    expect(sample.inputDelayP95Ms).toBeLessThan(100)
    expect(sample.longTaskMaxMs).toBeLessThan(200)
  }
})
