import type { Locator, Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

/**
 * Dragging clips between tracks on the sample project: a clip moves to another track of its kind as one undo step,
 * butts up against a neighbor it overlaps by a few pixels, and otherwise shows why it can't drop there (no room, a
 * locked track, a track that doesn't take its kind) and snaps back with one toast.
 */

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function openEditor(page: Page) {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=67'
  })
  await waitForPreview(page)
  // The design review bar covers the bottom of the timeline.
  await page.evaluate(() => window.mvStudio.app.ui.set({ review: false }))
}

interface Placed {
  trackId: string
  start: number
  end: number
}

const placed = (page: Page, id: string): Promise<Placed> =>
  page.evaluate((id) => {
    const clip = window.mvStudio.app.project.editor.getProject().clips[id] as {
      trackId: string
      start: number
      duration: number
    }
    const round = (t: number) => Math.round(t * 1000) / 1000
    return { trackId: clip.trackId, start: round(clip.start), end: round(clip.start + clip.duration) }
  }, id)

const undoLabel = (page: Page): Promise<string | undefined> =>
  page.evaluate(() => window.mvStudio.app.project.editor.undoLabel())

const center = async (el: Locator) => {
  const box = (await el.boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

test('a clip drags to another track of its kind, butts up against a near neighbor, and says why it cannot drop elsewhere', async ({
  page,
}) => {
  await openEditor(page)
  // Snapping off, so a drag moves a clip by exactly the pointer's distance.
  await page.keyboard.press('n')
  // Room on the Overlay track beside the Video clip used here: Spectrum bars starts at 1:09 instead of 1:04.
  await page.evaluate(() =>
    window.mvStudio.app.project.dispatch({ type: 'clip.move', moves: [{ clipId: 'o-spec1', start: 69 }] }),
  )
  const pps: number = await page.evaluate(() => window.mvStudio.app.ui.get().pxPerSec)
  const id: string = await page.evaluate(
    () =>
      (
        Object.values(window.mvStudio.app.project.editor.getProject().clips) as {
          id: string
          trackId: string
          start: number
        }[]
      ).find((c) => c.trackId === 't-video' && Math.abs(c.start - 66) < 0.01)!.id,
  )
  const singer = page.getByRole('button', { name: 'Singer close-up, 1:06.0 to 1:08.0' })
  const spectrum = page.getByRole('button', { name: 'Spectrum bars, 1:09.0 to 1:41.0' })
  const lyric = page.getByRole('button', { name: /^Lyric: / }).first()
  const content = page.locator('[data-timeline-scroller] > div')
  const from = await center(singer)
  const overlayY = (await center(spectrum)).y
  const lyricsY = (await center(lyric)).y
  const before = await placed(page, id)
  expect(before).toEqual({ trackId: 't-video', start: 66, end: 68 })
  const startLabel = await undoLabel(page)

  // No room: 1 s right along the Video track overlaps the next clip. Moving out and back in still gives one toast.
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + pps, from.y, { steps: 8 })
  await expect(page.getByText('No room', { exact: true })).toBeVisible()
  await expect(content).toHaveAttribute('data-refused', '')
  await expect(singer).toHaveCSS('cursor', 'not-allowed')
  await page.mouse.move(from.x + 1, from.y, { steps: 4 })
  await expect(page.getByText('No room', { exact: true })).toBeHidden()
  await page.mouse.move(from.x + pps, from.y, { steps: 4 })
  await page.mouse.up()
  const noRoom = page.getByText('No room there. Drop it on an empty stretch or another track.')
  await expect(noRoom).toHaveCount(1)
  await expect(content).not.toHaveAttribute('data-refused')
  expect(await placed(page, id)).toEqual(before)
  expect(await undoLabel(page)).toBe(startLabel)

  // Up onto the Overlay track, at the same time: one undo step.
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x, overlayY, { steps: 8 })
  await page.mouse.up()
  expect(await placed(page, id)).toEqual({ trackId: 't-overlay', start: 66, end: 68 })
  expect(await undoLabel(page)).toBe('Move clip')
  await page.keyboard.press(`${mod}+z`)
  expect(await placed(page, id)).toEqual(before)
  await page.keyboard.press(`${mod}+Shift+z`)
  expect(await placed(page, id)).toEqual({ trackId: 't-overlay', start: 66, end: 68 })

  // On the Overlay track, 1 s and 5 px right overlaps Spectrum bars (at 1:09) by 5 px: it butts up against it.
  const moved = await center(page.getByRole('button', { name: 'Singer close-up, 1:06.0 to 1:08.0' }))
  await page.mouse.move(moved.x, moved.y)
  await page.mouse.down()
  await page.mouse.move(moved.x + pps + 5, moved.y, { steps: 8 })
  await expect(page.getByText('No room', { exact: true })).toBeHidden()
  await page.mouse.up()
  expect(await placed(page, id)).toEqual({ trackId: 't-overlay', start: 67, end: 69 })
  await page.keyboard.press(`${mod}+z`)
  await page.keyboard.press(`${mod}+z`)
  expect(await placed(page, id)).toEqual(before)

  // A locked Overlay track takes nothing.
  await page.evaluate(() =>
    window.mvStudio.app.project.dispatch({
      type: 'track.update',
      trackId: 't-overlay',
      patch: { locked: true },
    }),
  )
  const locked = await undoLabel(page)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x, overlayY, { steps: 8 })
  await expect(page.getByText('Track is locked', { exact: true })).toBeVisible()
  await page.mouse.up()
  await expect(page.getByText('That track is locked. Unlock it to drop clips there.')).toBeVisible()
  expect(await placed(page, id)).toEqual(before)
  expect(await undoLabel(page)).toBe(locked)

  // The Lyrics track takes only lyric lines.
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x, lyricsY, { steps: 12 })
  await expect(page.getByText('Lyric lines only', { exact: true })).toBeVisible()
  await page.mouse.up()
  await expect(page.getByText("Video clips can't go on the Lyrics track.")).toBeVisible()
  expect(await placed(page, id)).toEqual(before)
  expect(await undoLabel(page)).toBe(locked)
})

test('looks stay on the look lane, a group drag labels the clip that cannot drop, and Esc cancels a drag', async ({
  page,
}) => {
  await openEditor(page)
  await page.keyboard.press('n')
  // An empty track below Video, where a look would no longer grade the picture.
  await page.evaluate(() =>
    window.mvStudio.app.project.dispatch([
      { type: 'clip.move', moves: [{ clipId: 'o-spec1', start: 69 }] },
      { type: 'track.add', track: window.mvStudio.model.createTrack('visual', 'Empty'), index: 4 },
    ]),
  )
  const id: string = await page.evaluate(
    () =>
      (
        Object.values(window.mvStudio.app.project.editor.getProject().clips) as {
          id: string
          trackId: string
          start: number
        }[]
      ).find((c) => c.trackId === 't-video' && Math.abs(c.start - 66) < 0.01)!.id,
  )
  const singer = page.getByRole('button', { name: 'Singer close-up, 1:06.0 to 1:08.0' })
  const spectrum = page.getByRole('button', { name: 'Spectrum bars, 1:09.0 to 1:41.0' })
  const look = page.getByRole('button', { name: /^Neon night\b.*, 0:00\.0 to / })
  const content = page.locator('[data-timeline-scroller] > div')
  const from = await center(singer)
  const lookY = (await center(look)).y
  const overlayY = (await center(spectrum)).y
  const emptyY = (await center(page.getByRole('button', { name: 'Move the Empty track' }))).y
  const before = await placed(page, id)
  const lookBefore = await placed(page, 'c-look')
  const startLabel = await undoLabel(page)

  // A video clip onto the Look track, which takes only looks, even where nothing else is in the way.
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x, lookY, { steps: 12 })
  await expect(page.getByText('Looks only', { exact: true })).toBeVisible()
  await page.mouse.up()
  await expect(page.getByText("Video clips can't go on the Look track.")).toHaveCount(1)
  expect(await placed(page, id)).toEqual(before)

  // The look onto the Overlay track, which holds other clips, and onto the empty track.
  await page.mouse.move(from.x, lookY)
  await page.mouse.down()
  await page.mouse.move(from.x, overlayY, { steps: 8 })
  await expect(page.getByText('No looks here', { exact: true })).toBeVisible()
  await page.mouse.up()
  await expect(page.getByText("Look clips can't go on the Overlay track.")).toHaveCount(1)
  await page.mouse.move(from.x, lookY)
  await page.mouse.down()
  await page.mouse.move(from.x, emptyY, { steps: 12 })
  await expect(page.getByText('No looks here', { exact: true })).toBeVisible()
  await page.mouse.up()
  await expect(page.getByText("Look clips can't go on the Empty track.")).toHaveCount(1)
  expect(await placed(page, 'c-look')).toEqual(lookBefore)
  expect(await undoLabel(page)).toBe(startLabel)

  // Singer close-up and Spectrum bars up one track together: Singer close-up has room on the Overlay track, Spectrum
  // bars can't go on the Look track, so its outline carries the label. Esc then puts both back with no toast.
  await singer.click()
  await spectrum.click({ modifiers: ['ControlOrMeta'] })
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x, overlayY, { steps: 8 })
  const label = page.getByText('Looks only', { exact: true })
  await expect(label).toBeVisible()
  const outline = (await label.locator('../..').boundingBox())!
  const bars = (await spectrum.boundingBox())!
  expect(Math.abs(outline.x - bars.x)).toBeLessThan(2)
  // Its outline starts in view, so the label crosses the lane's top edge.
  const across = (await label.boundingBox())!
  expect(across.y).toBeLessThan(outline.y)
  expect(across.y + across.height).toBeGreaterThan(outline.y)
  await page.keyboard.press('Escape')
  await expect(label).toBeHidden()
  await expect(content).not.toHaveAttribute('data-refused')
  await page.mouse.up()
  await expect(page.getByText("Visual clips can't go on the Look track.")).toHaveCount(0)
  expect(await placed(page, id)).toEqual(before)
  expect(await placed(page, 'o-spec1')).toEqual({ trackId: 't-overlay', start: 69, end: 101 })

  // Esc during a drag that would drop: the clip goes back, the drag ends, and the selection and history stay.
  await singer.click()
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x, overlayY, { steps: 8 })
  await expect.poll(() => placed(page, id)).toEqual({ ...before, trackId: 't-overlay' })
  await page.keyboard.press('Escape')
  expect(await placed(page, id)).toEqual(before)
  await page.mouse.move(from.x, lookY, { steps: 4 })
  await expect(page.getByText('Looks only', { exact: true })).toBeHidden()
  await page.mouse.up()
  expect(await placed(page, id)).toEqual(before)
  expect(await undoLabel(page)).toBe(startLabel)
  expect(await page.evaluate(() => window.mvStudio.app.ui.get().selection)).toEqual({ type: 'clip', id })
})

test('a refusal label stays in view at the left of the lanes, inside its outline, when the outline starts off screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await openEditor(page)
  const look = page.getByRole('button', { name: /^Neon night\b.*, 0:00\.0 to / })
  const spectrum = page.getByRole('button', { name: /^Spectrum bars, 1:04\.0 to / })
  const scroller = (await page.locator('[data-timeline-scroller]').boundingBox())!
  // Where the lanes start, right of the track headers (HEADER_W).
  const lanesLeft = scroller.x + 148
  // The look spans the whole song: in this view it starts well left of the lanes, under the track headers.
  const lookBox = (await look.boundingBox())!
  expect(lookBox.x).toBeLessThan(lanesLeft - 100)
  const from = { x: lanesLeft + 300, y: lookBox.y + lookBox.height / 2 }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x, (await center(spectrum)).y, { steps: 8 })
  const label = page.getByText('No looks here', { exact: true })
  await expect(label).toBeVisible()
  const pill = (await label.boundingBox())!
  const outline = (await label.locator('../..').boundingBox())!
  expect(outline.x).toBeLessThan(lanesLeft)
  expect(pill.x).toBeGreaterThanOrEqual(lanesLeft)
  expect(pill.x + pill.width).toBeLessThanOrEqual(
    Math.min(scroller.x + scroller.width, outline.x + outline.width),
  )
  // Inside the outline, off the Look lane above, where the look's own name sticks to the same edge.
  expect(pill.y).toBeGreaterThanOrEqual(outline.y)
  expect(pill.y + pill.height).toBeLessThanOrEqual(outline.y + outline.height)
  await page.keyboard.press('Escape')
  await page.mouse.up()
})
