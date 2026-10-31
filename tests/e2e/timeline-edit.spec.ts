import type { Locator, Page } from '@playwright/test'
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

  // From the keyboard: Enter selects the focused clip; with Shift or Mod, Enter adds or removes it.
  await singer.focus()
  await page.keyboard.press('Enter')
  expect(await selectedIds(page)).toHaveLength(1)
  await next.focus()
  await page.keyboard.press('Shift+Enter')
  await expect(next).toHaveAttribute('aria-pressed', 'true')
  await expect(singer).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press(`${mod}+Enter`)
  await expect(next).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('Shift+Enter')
  expect(await selectedIds(page)).toHaveLength(2)
  await expect(page.getByText(`Shift-click or ${mod === 'Meta' ? '⌘' : 'Ctrl'}-click a clip`)).toBeVisible()

  // Blend reads "Mixed" while the selected clips differ.
  const blend = page.getByRole('combobox', { name: 'Blend mode' })
  const before = (await blend.textContent()) ?? ''
  expect(before).not.toBe('Mixed')
  await page.evaluate(
    (id) => {
      window.mvStudio.app.project.editor.dispatch(
        { type: 'clip.set', clipId: id, path: ['blendMode'], value: 'screen' },
        { history: 'skip' },
      )
    },
    (await selectedIds(page))[0]!,
  )
  await expect(blend).toHaveText('Mixed')

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

  // Esc while drawing a marquee cancels it and keeps the selection it started with.
  await singer.click()
  await page.mouse.move(xAt(50.5), spec.y + spec.height / 2)
  await page.mouse.down()
  await page.mouse.move(xAt(69.5), video.y + video.height / 2, { steps: 10 })
  expect((await selectedIds(page)).length).toBeGreaterThan(1)
  await page.keyboard.press('Escape')
  await page.mouse.move(xAt(70), video.y + video.height / 2, { steps: 2 })
  await page.mouse.up()
  await expect(singer).toHaveAttribute('aria-pressed', 'true')
  expect(await selectedIds(page)).toHaveLength(1)

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

test('a marquee or a dragged clip held at the timeline’s edge scrolls it, and keeps up with the scroll', async ({
  page,
}) => {
  await openEditor(page, '#/editor?t=67')
  // Snapping off: a drag moves the clip by exactly the pointer's distance plus the scroll.
  await page.keyboard.press('n')
  const scroller = page.locator('[data-timeline-scroller]')
  const scrollLeft = (): Promise<number> => scroller.evaluate((el) => el.scrollLeft)
  // 40 px a second, showing 1:00 to about 1:32: the clips after that are off screen.
  const pps = 40
  await page.evaluate((v) => window.mvStudio.app.ui.set({ pxPerSec: v }), pps)
  const showFrom = async (t: number) => {
    await scroller.evaluate((el, x) => (el.scrollLeft = x), t * pps)
    await expect.poll(scrollLeft).toBe(t * pps)
  }
  await expect.poll(() => scroller.evaluate((el) => el.scrollWidth)).toBeGreaterThan(200 * pps)
  await showFrom(60)
  await expect(page.getByRole('button', { name: 'Spectrum bars, 1:04.0 to 1:36.0' })).toBeVisible()
  const box = (await scroller.boundingBox())!
  const laneLeft = box.x + 148
  const xAt = (t: number) => laneLeft + (t - 60) * pps
  const right = box.x + box.width - 4
  const visibleEnd = 60 + (right - laneLeft) / pps
  const spectrum = page.getByRole('button', { name: 'Spectrum bars, 1:04.0 to 1:36.0' })
  const spec = (await spectrum.boundingBox())!
  const singer = page.getByRole('button', { name: /, 1:06\.0 to 1:08\.0$/ }).last()
  const video = (await singer.boundingBox())!

  // A marquee from empty Overlay space at 1:02.5, held at the right edge down on the Video track.
  await page.mouse.move(xAt(62.5), spec.y + spec.height / 2)
  await page.mouse.down()
  await page.mouse.move(right, video.y + video.height / 2, { steps: 10 })
  await expect.poll(scrollLeft).toBeGreaterThan(60 * pps + 400)
  await page.mouse.up()
  const scrolled = (await scrollLeft()) / pps - 60
  const reach = visibleEnd + scrolled
  const picked = (await clipsOn(page, ['t-overlay', 't-video'])).filter(
    (c) => c.start < reach - 0.5 && c.end > 62.5,
  )
  // It reaches clips that were off screen when it started.
  expect(picked.some((c) => c.start > visibleEnd + 2)).toBe(true)
  expect(new Set(await selectedIds(page))).toEqual(new Set(picked.map((c) => c.id)))

  // A clip dragged to the right edge and held there moves on with the scroll.
  await page.keyboard.press('Escape')
  await showFrom(60)
  const grab = xAt(81)
  await page.mouse.move(grab, spec.y + spec.height / 2)
  await page.mouse.down()
  await page.mouse.move(right, spec.y + spec.height / 2, { steps: 10 })
  await expect.poll(scrollLeft).toBeGreaterThan(60 * pps + 200)
  await page.mouse.up()
  const extra = (await scrollLeft()) - 60 * pps
  const [moved] = (await clipsOn(page, ['t-overlay'])).filter((c) => c.end - c.start === 32 && c.start < 120)
  expect(moved.start).toBeCloseTo(64 + (right - grab + extra) / pps, 1)
  expect(moved.start - 64).toBeGreaterThan((right - grab) / pps + 4)
})
test('pasted and duplicated clips are scrolled into view, on a numbered track when theirs is taken; the palette runs them', async ({
  page,
}) => {
  await openEditor(page, '#/editor?t=67')
  // With no clips selected or copied, the palette shows why Copy and Paste can't run yet, and Enter does nothing.
  const palette = page.getByRole('dialog')
  await page.keyboard.press(`${mod}+k`)
  await palette.getByRole('combobox').fill('Copy')
  const copyItem = palette.getByRole('option', { name: /^Copy/ })
  await expect(copyItem).toHaveAttribute('aria-selected', 'true')
  await expect(copyItem).toContainText('Select clips first')
  await page.keyboard.press('Enter')
  await expect(copyItem).toBeVisible()
  await palette.getByRole('combobox').fill('Paste')
  await expect(palette.getByRole('option', { name: /^Paste at playhead/ })).toContainText('Copy clips first')
  await page.keyboard.press('Escape')
  await expect(palette).toBeHidden()

  const singer = page.getByRole('button', { name: 'Singer close-up, 1:06.0 to 1:08.0' })
  await singer.click()
  await page.keyboard.press(`${mod}+c`)
  // Zoomed in and scrolled to the start, 1:07 is far off to the right.
  await page.evaluate(() => window.mvStudio.app.ui.set({ pxPerSec: 40 }))
  const scroller = page.locator('[data-timeline-scroller]')
  await scroller.evaluate((el) => (el.scrollLeft = 0))
  const pasted = page.getByRole('button', { name: 'Singer close-up, 1:07.0 to 1:09.0' })
  await page.keyboard.press(`${mod}+v`)
  await expect(pasted).toBeInViewport()
  // The Video track is taken at 1:07, so the copy goes on a new track named apart from it.
  expect(
    await page.evaluate(() =>
      window.mvStudio.app.project.editor.getProject().tracks.map((t: { name: string }) => t.name),
    ),
  ).toContain('Video 2')

  await scroller.evaluate((el) => (el.scrollLeft = 0))
  await page.keyboard.press(`${mod}+k`)
  await palette.getByRole('combobox').fill('Duplicate')
  await page.keyboard.press('Enter')
  await expect(palette).toBeHidden()
  const copy = page.getByRole('button', { name: 'Singer close-up, 1:09.0 to 1:11.0' })
  await expect(copy).toHaveAttribute('aria-pressed', 'true')
  await expect(copy).toBeInViewport()
})

test('Paste here on an empty stretch of a lane pastes at that time, on that track when it can take the clips', async ({
  page,
}) => {
  await openEditor(page, '#/editor?t=60')
  // Snapping off first, so the copies land exactly at the right-clicked time; it is checked at the end.
  await page.evaluate(() => window.mvStudio.app.ui.set({ review: false, snap: false }))
  const pps: number = await page.evaluate(() => window.mvStudio.app.ui.get().pxPerSec)
  const spectrum = page.getByRole('button', { name: 'Spectrum bars, 1:04.0 to 1:36.0' })
  const box = (await spectrum.boundingBox())!
  /** A right-click on the Overlay track at t seconds; the spectrum starts at 64 s. */
  const rightClickOverlay = (t: number) =>
    page.mouse.click(box.x + (t - 64) * pps, box.y + box.height / 2, { button: 'right' })
  const item = page.getByRole('menu').getByRole('menuitem', { name: /^Paste here/ })

  // Before anything is copied it says why, and Generate a shot here stays last.
  await rightClickOverlay(61.55)
  await expect(item).toBeDisabled()
  await expect(item).toContainText('Copy clips first')
  await expect(page.getByRole('menu').getByRole('menuitem').last()).toContainText('Generate a shot here')
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Singer close-up, 1:06.0 to 1:08.0' }).click()
  await page.keyboard.press(`${mod}+c`)
  await expect(page.getByText('Copied 1 clip')).toBeVisible()

  // Free there: the copy lands on the Overlay track at the right-clicked time, selected.
  await rightClickOverlay(61.55)
  await expect(item).toBeEnabled()
  await expect(item).toContainText(/At 1:01\.5$/)
  await item.click()
  const pasted = page.getByRole('button', { name: /^Singer close-up, 1:01\.5 to 1:03\.5$/ })
  await expect(pasted).toHaveAttribute('aria-pressed', 'true')
  const placed = await page.evaluate(() => {
    const { ui, project } = window.mvStudio.app
    const [id] = ui.selectedClipIds(ui.get().selection)
    const clip = project.editor.getProject().clips[id]
    return { trackId: clip.trackId, label: project.editor.undoLabel() }
  })
  expect(placed).toEqual({ trackId: 't-overlay', label: 'Paste clip' })
  await page.keyboard.press(`${mod}+z`)
  await expect(pasted).toHaveCount(0)

  // Where the spectrum is in the way, the usual rules apply. The clip's own Video track is full there too, so the copy
  // goes on a new track, and the line says so.
  await rightClickOverlay(63.05)
  await expect(item).toContainText(/At 1:03\.0 · on a new track$/)
  await item.click()
  const elsewhere = await page.evaluate(() => {
    const { ui, project } = window.mvStudio.app
    const [id] = ui.selectedClipIds(ui.get().selection)
    const p = project.editor.getProject()
    const clip = p.clips[id]
    return { track: p.tracks.find((t: { id: string }) => t.id === clip.trackId)?.name, start: clip.start }
  })
  expect(elsewhere.track).toBe('Video 2')
  expect(elsewhere.start).toBeCloseTo(63.05, 1)
  await page.keyboard.press(`${mod}+z`)

  // With snapping on, the paste lands on the nearest beat, and the line shows that time.
  await page.evaluate(() => window.mvStudio.app.ui.set({ snap: true, beatSnap: true }))
  await rightClickOverlay(61.37)
  await expect(item).toContainText(/At 1:01\.5$/)
  await item.click()
  const snapped = await page.evaluate(() => {
    const { ui, project } = window.mvStudio.app
    const [id] = ui.selectedClipIds(ui.get().selection)
    const p = project.editor.getProject()
    return { start: p.clips[id].start, beats: p.analysis.audio[p.songAssetId].beats as number[] }
  })
  expect(snapped.start).not.toBeCloseTo(61.37, 2)
  expect(snapped.beats.some((b) => Math.abs(b - snapped.start) < 1e-6)).toBe(true)
})

test('with the split tool, a click cuts a clip where it is clicked, snapping to the playhead, as one undo step; Esc or V puts it down', async ({
  page,
}) => {
  await openEditor(page, '#/editor?t=67')
  // 40 px a second, so the snap distance (8 px) is 0.2 s.
  await page.evaluate(() => window.mvStudio.app.ui.set({ pxPerSec: 40 }))
  const split = page.getByRole('radio', { name: 'Split: click a clip to cut it' })
  const selectTool = page.getByRole('radio', { name: 'Select', exact: true })
  const singer = page.getByRole('button', { name: 'Singer close-up, 1:06.0 to 1:08.0' })
  // Clips are drawn only where the timeline is scrolled to.
  await page.locator('[data-timeline-scroller]').evaluate((el) => (el.scrollLeft = 66 * 40 - 200))
  await expect(singer).toBeVisible()
  const h = (await singer.boundingBox())!.height
  const undoDepth = () =>
    page.evaluate(() => window.mvStudio.app.project.editor.history().undo.length as number)
  const before = await undoDepth()

  await split.click()
  await expect(split).toHaveAttribute('aria-checked', 'true')
  // The crosshair shows only where a click cuts: on clips and their trim handles, not on a lyric line's handles.
  const cursor = (l: Locator) => l.evaluate((el) => getComputedStyle(el).cursor)
  expect(await cursor(singer)).toBe('crosshair')
  expect(await cursor(singer.locator('span[class*="handle"]').first())).toBe('crosshair')
  const lyric = page
    .getByRole('button', { name: /^Lyric: / })
    .filter({ visible: true })
    .first()
  expect(await cursor(lyric.locator('span[class*="handle"]').first())).toBe('ew-resize')
  // 4 px after the playhead at 1:07.0: the cut snaps to the playhead.
  await singer.click({ position: { x: 1.1 * 40, y: h / 2 } })
  await expect(page.getByRole('button', { name: 'Singer close-up, 1:06.0 to 1:07.0' })).toBeVisible()
  const right = page.getByRole('button', { name: 'Singer close-up, 1:07.0 to 1:08.0' })
  await expect(right).toBeVisible()
  expect(await undoDepth()).toBe(before + 1)
  expect(await page.evaluate(() => window.mvStudio.app.project.editor.undoLabel())).toBe('Split clip')

  // Away from anything to snap to, it cuts at the click point.
  await page.evaluate(() => window.mvStudio.app.ui.set({ snap: false }))
  await right.click({ position: { x: 0.6 * 40, y: h / 2 } })
  const cut = (await clipsOn(page, ['t-video'])).find((c) => Math.abs(c.end - 67.6) < 0.05)
  expect(cut?.start).toBeCloseTo(67, 5)
  await page.keyboard.press(`${mod}+z`)
  await page.keyboard.press(`${mod}+z`)
  await expect(singer).toBeVisible()
  expect(await undoDepth()).toBe(before)

  // Esc puts the split tool down without clearing the selection; so does V.
  await page.evaluate(() => window.mvStudio.app.ui.set({ snap: true }))
  await selectTool.click()
  await singer.click()
  await split.click()
  await page.keyboard.press('Escape')
  await expect(selectTool).toHaveAttribute('aria-checked', 'true')
  await expect(singer).toHaveAttribute('aria-pressed', 'true')
  await split.click()
  await page.keyboard.press('v')
  await expect(selectTool).toHaveAttribute('aria-checked', 'true')

  // The tools say what they do in the app's tooltip, with the key that picks Select.
  await selectTool.hover()
  await expect(page.getByRole('tooltip').filter({ hasText: 'Select' }).first()).toBeVisible()
  await expect(selectTool).toHaveAttribute('aria-keyshortcuts', 'V')
  expect(await split.getAttribute('title')).toBeNull()

  // On a locked track a click only says the track is locked, so its clips keep their usual cursor.
  await split.click()
  await page.evaluate(() =>
    window.mvStudio.app.project.editor.dispatch({
      type: 'track.update',
      trackId: 't-video',
      patch: { locked: true },
    }),
  )
  expect(await cursor(singer)).toBe('grab')
})

test('lyric chips join Shift and Mod click and marquee selections; Delete takes their lines out in one undo step, and copies paste as text', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await openEditor(page, '#/editor?t=67')
  const singer = page.getByRole('button', { name: 'Singer close-up, 1:06.0 to 1:08.0' })
  // Clips are drawn only where the timeline is scrolled to; a paste scrolls to the copies.
  const scroller = page.locator('[data-timeline-scroller]')
  const scrolled = await scroller.evaluate((el) => el.scrollLeft)
  // The two lyric lines nearest the singer clip, in time order.
  const lines: { id: string; lineId: string; start: number }[] = await page.evaluate(() => {
    const p = window.mvStudio.app.project.editor.getProject()
    return (Object.values(p.clips) as { id: string; type: string; lyricLineId: string; start: number }[])
      .filter((c) => c.type === 'text' && c.lyricLineId)
      .sort((a, b) => Math.abs(a.start - 66) - Math.abs(b.start - 66))
      .slice(0, 2)
      .sort((a, b) => a.start - b.start)
      .map((c) => ({ id: c.id, lineId: c.lyricLineId, start: c.start }))
  })
  const [first, second] = lines
  if (!first || !second) throw new Error('The sample has lyric lines near 1:06')
  // Chorus lines repeat, so a chip is found by its line.
  const chipOf = (lineId: string) =>
    page.getByRole('button', { name: /^Lyric: / }).and(page.locator(`[data-lyric-line="${lineId}"]`))
  const chip1 = chipOf(first.lineId)
  const chip2 = chipOf(second.lineId)
  const lineIds = (): Promise<string[]> =>
    page.evaluate(() =>
      (window.mvStudio.app.project.editor.getProject().lyrics?.lines ?? []).map((l: { id: string }) => l.id),
    )
  const undoLabel = () => page.evaluate(() => window.mvStudio.app.project.editor.undoLabel())
  const allLines = await lineIds()

  // Shift and Mod click add a chip to the selection and take it out; Shift Enter adds it from the keyboard.
  await singer.click()
  await chip1.click({ modifiers: ['Shift'] })
  await expect(singer).toHaveAttribute('aria-pressed', 'true')
  await expect(chip1).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('2 clips', { exact: true })).toBeVisible()
  // A selected chip shows the selection's outline, as a selected clip does, hovered or not.
  const shadow = (l: Locator) => l.evaluate((el) => getComputedStyle(el).boxShadow)
  expect(await shadow(chip1)).toBe(await shadow(singer))
  await chip1.click({ modifiers: [mod] })
  await expect(chip1).toHaveAttribute('aria-pressed', 'false')
  await expect(singer).toHaveAttribute('aria-pressed', 'true')
  await chip1.focus()
  await page.keyboard.press('Shift+Enter')
  await expect(chip1).toHaveAttribute('aria-pressed', 'true')
  expect(await selectedIds(page)).toHaveLength(2)

  // A selected line takes a Shift-clicked clip along.
  await chip2.click()
  await singer.click({ modifiers: ['Shift'] })
  await expect(chip2).toHaveAttribute('aria-pressed', 'true')
  await expect(singer).toHaveAttribute('aria-pressed', 'true')
  expect(await selectedIds(page)).toContain(second.id)

  // Delete removes the clip, the chip and its line, as one undo step.
  await page.keyboard.press('Delete')
  await expect(singer).toHaveCount(0)
  await expect(chip2).toHaveCount(0)
  expect(await lineIds()).toEqual(allLines.filter((id) => id !== second.lineId))
  expect(await undoLabel()).toBe('Delete 1 clip and 1 lyric line')
  await page.keyboard.press(`${mod}+z`)
  await expect(singer).toBeVisible()
  await expect(chip2).toBeVisible()
  expect(await lineIds()).toEqual(allLines)

  // Copies of lyric chips paste as text clips on a Text track; the lyrics stay as they are.
  await singer.click()
  await chip1.click({ modifiers: ['Shift'] })
  await page.keyboard.press(`${mod}+c`)
  await expect(page.getByRole('status').getByText('Copied 1 clip and 1 lyric line')).toBeVisible()
  await page.evaluate(() => window.mvStudio.app.ui.set({ playhead: 150 }))
  await page.keyboard.press(`${mod}+v`)
  await expect(page.getByRole('status').getByText('Pasted 1 clip and 1 lyric line as text')).toBeVisible()
  const pasted = await page.evaluate(() => {
    const p = window.mvStudio.app.project.editor.getProject()
    const track = p.tracks.find((t: { name: string }) => t.name === 'Text')
    return (
      Object.values(p.clips) as { trackId: string; type: string; lyricLineId?: string; start: number }[]
    )
      .filter((c) => c.trackId === track?.id)
      .map((c) => [c.type, c.lyricLineId ?? null, +c.start.toFixed(3)])
  })
  const earliest = Math.min(66, first.start)
  expect(pasted).toEqual([['text', null, +(150 + first.start - earliest).toFixed(3)]])
  expect(await lineIds()).toEqual(allLines)
  await page.keyboard.press(`${mod}+z`)

  // A marquee from empty Overlay space up into the lyrics takes the chips it touches with the other clips.
  await scroller.evaluate((el, x) => (el.scrollLeft = x), scrolled)
  await expect(chip1).toBeVisible()
  const pps: number = await page.evaluate(() => window.mvStudio.app.ui.get().pxPerSec)

  // A group drag moves the clips and leaves the chips with their sung lines; the toast says so.
  await page.keyboard.press('n')
  const spectrum = page.getByRole('button', { name: 'Spectrum bars, 1:04.0 to 1:36.0' })
  await spectrum.click()
  await chip1.click({ modifiers: ['Shift'] })
  const chipStart = () =>
    page.evaluate((id) => window.mvStudio.app.project.editor.getProject().clips[id].start as number, first.id)
  const chipBefore = await chipStart()
  const from = (await spectrum.boundingBox())!
  await page.mouse.move(from.x + 20, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + 20 - 2 * pps, from.y + from.height / 2, { steps: 10 })
  await page.mouse.up()
  await expect(
    page.getByRole('status').getByText('Moved 1 clip. Lyric lines stay with the vocals.'),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Spectrum bars, 1:02.0 to 1:34.0' })).toBeVisible()
  expect(await chipStart()).toBe(chipBefore)
  await page.keyboard.press(`${mod}+z`)
  await page.keyboard.press('n')

  const spec = (await page.getByRole('button', { name: 'Spectrum bars, 1:04.0 to 1:36.0' }).boundingBox())!
  const lyricRow = (await chip1.boundingBox())!
  const xAt = (t: number) => spec.x + (t - 64) * pps
  await page.mouse.move(xAt(50.5), spec.y + spec.height / 2)
  await page.mouse.down()
  await page.mouse.move(xAt(second.start + 0.2), lyricRow.y + lyricRow.height / 2, { steps: 20 })
  await page.mouse.up()
  const picked = await selectedIds(page)
  expect(picked).toEqual(expect.arrayContaining([first.id, second.id]))
  expect(picked.length).toBeGreaterThan(2)

  // On a locked Lyrics track, the delete is refused as a whole.
  await page.evaluate(() => {
    const { editor } = window.mvStudio.app.project
    const lyrics = editor.getProject().tracks.find((t: { name: string }) => t.name === 'Lyrics')
    editor.dispatch({ type: 'track.update', trackId: lyrics.id, patch: { locked: true } })
  })
  await page.keyboard.press('Delete')
  await expect(page.getByRole('status').getByText('That track is locked. Unlock it to edit.')).toBeVisible()
  await expect(chip1).toBeVisible()
  expect(await lineIds()).toEqual(allLines)
  expect(await selectedIds(page)).toEqual(picked)
})
