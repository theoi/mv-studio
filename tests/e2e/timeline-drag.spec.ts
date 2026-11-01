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
  // Room on the Overlay track beside the Video clip used here: Spectrum bars starts at 1:09 instead of 1:04. Neon grid,
  // after that clip, ends at 1:09.5 instead of 1:10, half a second short of the next clip.
  await page.evaluate(() => {
    const { editor, dispatch } = window.mvStudio.app.project
    const clips = Object.values(editor.getProject().clips) as { id: string; trackId: string; start: number }[]
    const neon = clips.find((c) => c.trackId === 't-video' && Math.abs(c.start - 68) < 0.01)!
    dispatch([
      { type: 'clip.move', moves: [{ clipId: 'o-spec1', start: 69 }] },
      { type: 'clip.trim', clipId: neon.id, start: 68, duration: 1.5 },
    ])
  })
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

  // No room: 2.75 s right along the Video track lets go in the half second after Neon grid. Moving out and back in
  // still gives one toast.
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 2.75 * pps, from.y, { steps: 8 })
  await expect(page.getByText('No room', { exact: true })).toBeVisible()
  await expect(content).toHaveAttribute('data-refused', '')
  await expect(singer).toHaveCSS('cursor', 'not-allowed')
  await page.mouse.move(from.x + 1, from.y, { steps: 4 })
  await expect(page.getByText('No room', { exact: true })).toBeHidden()
  await page.mouse.move(from.x + 2.75 * pps, from.y, { steps: 4 })
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
  expect(await undoLabel(page)).toBe('Move Singer close-up')
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
  const outline = (await label.locator('xpath=ancestor::div[1]').boundingBox())!
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
  const outline = (await label.locator('xpath=ancestor::div[1]').boundingBox())!
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

test('Mod pressed during a clip drag rearranges: the clip leaves its place, which closes up, and goes in at the drop point; releasing Mod goes back to a move', async ({
  page,
}) => {
  await openEditor(page)
  await page.keyboard.press('n')
  // Neon grid (1:08 to 1:10) ends at 1:09.5 instead, half a second short of the next clip: too little room there.
  await page.evaluate(() => {
    const { editor, dispatch } = window.mvStudio.app.project
    const clips = Object.values(editor.getProject().clips) as { id: string; trackId: string; start: number }[]
    const neon = clips.find((c) => c.trackId === 't-video' && Math.abs(c.start - 68) < 0.01)!
    dispatch({ type: 'clip.trim', clipId: neon.id, start: 68, duration: 1.5 })
  })
  const pps: number = await page.evaluate(() => window.mvStudio.app.ui.get().pxPerSec)
  /** The Video track's clips by id, with their starts rounded to the millisecond. */
  const video = () =>
    page.evaluate(() =>
      Object.fromEntries(
        (
          Object.values(window.mvStudio.app.project.editor.getProject().clips) as {
            id: string
            trackId: string
            start: number
          }[]
        )
          .filter((c) => c.trackId === 't-video')
          .map((c) => [c.id, Math.round(c.start * 1000) / 1000]),
      ),
    )
  const before = await video()
  const id = Object.keys(before).find((k) => before[k] === 66)!
  const neon = Object.keys(before).find((k) => before[k] === 68)!
  expect(Object.keys(before).filter((k) => before[k]! > 68).length).toBeGreaterThan(1)
  // The two swap places, and the clips after them stay where they were: no gap, and the track keeps its length.
  const inserted = { ...before, [id]: 68, [neon]: 66 }
  const singer = page.getByRole('button', { name: 'Singer close-up, 1:06.0 to 1:08.0' })
  const content = page.locator('[data-timeline-scroller] > div')
  const insertPill = page.getByText('Insert', { exact: true })
  const startLabel = await undoLabel(page)
  const from = await center(singer)

  // 2.75 s right lets go in the half second after Neon grid: no room, and the pill says how to insert.
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 2.75 * pps, from.y, { steps: 10 })
  await expect(page.getByText('No room', { exact: true })).toBeVisible()
  await expect(page.getByText(/^Hold (Ctrl|⌘) while dragging to insert$/)).toBeVisible()
  // The reason crosses the lane's top edge and the hint hangs below it, clear of the clip names in the lane above.
  const reason = (await page.getByText('No room', { exact: true }).boundingBox())!
  const hint = (await page.getByText(/^Hold (Ctrl|⌘) while dragging to insert$/).boundingBox())!
  const outline = (await page
    .getByText('No room', { exact: true })
    .locator('xpath=ancestor::div[1]')
    .boundingBox())!
  expect(reason.y).toBeLessThan(outline.y)
  expect(reason.y + reason.height).toBeGreaterThan(outline.y)
  expect(hint.y).toBeGreaterThanOrEqual(outline.y)

  // Mod during the drag: Neon grid moves left into the clip's place, and the clip goes in before the next clip (the
  // nearer edge of the clip now under the drop point), where that clip was.
  await page.keyboard.down(mod)
  await expect(insertPill).toBeVisible()
  await expect(page.getByText('No room', { exact: true })).toBeHidden()
  await expect(content).not.toHaveAttribute('data-refused')
  await expect.poll(video).toEqual(inserted)

  // Releasing Mod goes back to a move, which has no room there.
  await page.keyboard.up(mod)
  await expect(page.getByText('No room', { exact: true })).toBeVisible()
  await expect(insertPill).toBeHidden()
  await expect.poll(video).toEqual(before)

  // Mod again and drop: one undo step.
  await page.keyboard.down(mod)
  await expect(insertPill).toBeVisible()
  await page.mouse.up()
  await page.keyboard.up(mod)
  await expect(insertPill).toBeHidden()
  expect(await video()).toEqual(inserted)
  expect(await undoLabel(page)).toBe('Insert clip')
  await expect(page.getByText('No room there. Drop it on an empty stretch or another track.')).toHaveCount(0)
  await page.keyboard.press(`${mod}+z`)
  expect(await video()).toEqual(before)
  expect(await undoLabel(page)).toBe(startLabel)

  // Esc during an insert puts every clip back, with no undo step.
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 2 * pps, from.y, { steps: 10 })
  await page.keyboard.down(mod)
  await expect.poll(video).toEqual(inserted)
  await page.keyboard.press('Escape')
  await page.keyboard.up(mod)
  expect(await video()).toEqual(before)
  await expect(insertPill).toBeHidden()
  await page.mouse.up()
  expect(await video()).toEqual(before)
  expect(await undoLabel(page)).toBe(startLabel)
})

test('Mod dragging a clip to another track pushes the later clips there and leaves the track it comes from as it was', async ({
  page,
}) => {
  await openEditor(page)
  await page.keyboard.press('n')
  const pps: number = await page.evaluate(() => window.mvStudio.app.ui.get().pxPerSec)
  // A copy of Singer close-up on the Overlay track at 1:00 to 1:02, where a clip from the library lands, before
  // Spectrum bars at 1:04.
  await page.evaluate(() => {
    const { editor, dispatch } = window.mvStudio.app.project
    const clips = Object.values(editor.getProject().clips) as { id: string; trackId: string; start: number }[]
    const singer = clips.find((c) => c.trackId === 't-video' && Math.abs(c.start - 66) < 0.01)!
    dispatch({
      type: 'clip.add',
      clip: { ...structuredClone(singer), id: 'shot', trackId: 't-overlay', start: 60 },
    })
  })
  /** The clips of a track by id, with their starts rounded to the millisecond. */
  const starts = (trackId: string) =>
    page.evaluate(
      (trackId) =>
        Object.fromEntries(
          (
            Object.values(window.mvStudio.app.project.editor.getProject().clips) as {
              id: string
              trackId: string
              start: number
            }[]
          )
            .filter((c) => c.trackId === trackId)
            .map((c) => [c.id, Math.round(c.start * 1000) / 1000]),
        ),
      trackId,
    )
  const video = await starts('t-video')
  const overlay = await starts('t-overlay')
  const singerId = Object.keys(video).find((k) => video[k] === 66)!
  const later = (clips: Record<string, number>, from: number) =>
    Object.fromEntries(Object.entries(clips).map(([id, start]) => [id, start >= from ? start + 2 : start]))
  const without = (clips: Record<string, number>, id: string) =>
    Object.fromEntries(Object.entries(clips).filter(([k]) => k !== id))
  const insertPill = page.getByText('Insert', { exact: true })
  const shot = page.locator('[data-clip-id="shot"]')
  const singer = page.locator(`[data-clip-id="${singerId}"]`)
  const startLabel = await undoLabel(page)
  /** Drags a clip onto the row of `onto`, `by` seconds along, with Mod held from halfway, and drops it. */
  const insertDrag = async (clip: Locator, onto: Locator, by: number) => {
    const from = await center(clip)
    const to = await center(onto)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + by * pps, to.y, { steps: 10 })
    await page.keyboard.down(mod)
    await expect(insertPill).toBeVisible()
    await page.mouse.up()
    await page.keyboard.up(mod)
    await expect(insertPill).toBeHidden()
  }

  // Down into the Video track, let go half a second into Singer close-up: it goes in where Singer close-up started and
  // the Video clips from there move 2 s later. Spectrum bars stays at the chorus start.
  await insertDrag(shot, singer, 6.5)
  expect(await starts('t-video')).toEqual({ ...later(video, 66), shot: 66 })
  expect(await starts('t-overlay')).toEqual(without(overlay, 'shot'))
  expect(await undoLabel(page)).toBe('Insert clip')
  await page.keyboard.press(`${mod}+z`)
  expect([await starts('t-video'), await starts('t-overlay')]).toEqual([video, overlay])
  expect(await undoLabel(page)).toBe(startLabel)

  // Up from the Video track into Spectrum bars: Singer close-up goes in where Spectrum bars started, which moves 2 s
  // later with the Overlay clips after it. The Video clips after Singer close-up stay where they were.
  await insertDrag(singer, shot, 0)
  expect(await starts('t-overlay')).toEqual({ ...later(overlay, 64), [singerId]: 64 })
  expect(await starts('t-video')).toEqual(without(video, singerId))
})

test('a clip let go over a gap it fits fills it exactly, and one let go on its neighbor or a clip of its length swaps places with it', async ({
  page,
}) => {
  await openEditor(page)
  await page.keyboard.press('n')
  const pps: number = await page.evaluate(() => window.mvStudio.app.ui.get().pxPerSec)
  // Letting go 0.8 s off is more than a butt-up's few pixels, so only the gap under the pointer can place the clip.
  expect(0.8 * pps).toBeGreaterThan(8)
  /** The Video track's 2 s clips from 1:04 to 1:14, by start: 66 is Singer close-up and 68 is Neon grid. */
  const ids: Record<number, string> = await page.evaluate(() =>
    Object.fromEntries(
      (
        Object.values(window.mvStudio.app.project.editor.getProject().clips) as {
          id: string
          trackId: string
          start: number
        }[]
      )
        .filter((c) => c.trackId === 't-video' && c.start > 63.9 && c.start < 72.1)
        .map((c) => [Math.round(c.start), c.id]),
    ),
  )
  const clip = (t: number) => page.locator(`[data-clip-id="${ids[t]}"]`)
  const at = (t: number) => placed(page, ids[t]!)
  const span = (start: number, end: number) => ({ trackId: 't-video', start, end })
  const toastWith = (message: string) =>
    page.locator('[data-toast]').filter({ has: page.getByText(message, { exact: true }) })
  const noRoom = page.getByText('No room', { exact: true })
  /** Drags the clip that started at `t` by `by` seconds along its track from its middle, running `during` before the drop. */
  const drag = async (t: number, by: number, during?: () => Promise<void>) => {
    const from = await center(clip(t))
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + by * pps, from.y, { steps: 10 })
    await during?.()
    await page.mouse.up()
  }
  // A cutout of Singer close-up for text behind the subject, on a Subject track at the top.
  await page.evaluate((host) => {
    const { editor, dispatch } = window.mvStudio.app.project
    const track = window.mvStudio.model.createTrack('visual', 'Subject')
    const clip = { ...structuredClone(editor.getProject().clips[host]), id: 'cutout', trackId: track.id }
    dispatch([
      { type: 'track.add', track, index: 0 },
      { type: 'clip.add', clip: { ...clip, meta: { behindSubjectOf: host } } },
    ])
  }, ids[66]!)
  const cutoutAt = async () => (await placed(page, 'cutout')).start
  const hasCutout = () =>
    page.evaluate(() => 'cutout' in window.mvStudio.app.project.editor.getProject().clips)
  const startLabel = await undoLabel(page)

  // Onto its neighbor: the pill says Swap and the neighbor shows in its place; the drop is one undo step, with a toast.
  // The cutout moves with Singer close-up, so it keeps showing the same moment.
  await drag(66, 2, async () => {
    await expect(page.getByText('Swap', { exact: true })).toBeVisible()
    await expect.poll(() => at(68)).toEqual(span(66, 68))
  })
  expect(await at(66)).toEqual(span(68, 70))
  expect(await cutoutAt()).toBe(68)
  expect(await undoLabel(page)).toBe('Swap clips')
  await expect(toastWith('Swapped Singer close-up and Neon grid')).toBeVisible()
  await page.keyboard.press(`${mod}+z`)
  expect([await at(66), await at(68), await cutoutAt()]).toEqual([span(66, 68), span(68, 70), 66])
  expect(await undoLabel(page)).toBe(startLabel)
  await page.keyboard.press(`${mod}+Shift+z`)
  expect([await at(66), await at(68), await cutoutAt()]).toEqual([span(68, 70), span(66, 68), 68])
  await page.keyboard.press(`${mod}+z`)

  // Onto a clip of the same length further on: they swap, and Neon grid between them stays.
  await drag(66, 4)
  expect([await at(66), await at(68), await at(70)]).toEqual([span(70, 72), span(68, 70), span(66, 68)])
  await page.keyboard.press(`${mod}+z`)

  // Onto one a few hundredths of a second shorter: they trade lengths too, and the cutout is trimmed with its clip.
  await page.evaluate(
    (id) =>
      window.mvStudio.app.project.dispatch({ type: 'clip.trim', clipId: id, start: 70, duration: 1.96 }),
    ids[70],
  )
  await drag(66, 4)
  expect([await at(66), await at(70)]).toEqual([span(70, 71.96), span(66, 68)])
  expect(await placed(page, 'cutout')).toMatchObject({ start: 70, end: 71.96 })
  await page.keyboard.press(`${mod}+z`)
  expect(await placed(page, 'cutout')).toMatchObject({ start: 66, end: 68 })
  await page.keyboard.press(`${mod}+z`)
  expect(await at(70)).toEqual(span(70, 72))

  // Into the gap Singer close-up leaves, let go 0.8 s late, overlapping Neon grid: it fills the gap exactly. Its cutout
  // goes with it in the same undo step.
  await clip(66).click()
  await page.keyboard.press('Delete')
  expect(await hasCutout()).toBe(false)
  expect(await undoLabel(page)).toBe('Delete Singer close-up')
  await page.keyboard.press(`${mod}+z`)
  expect(await hasCutout()).toBe(true)
  await page.keyboard.press(`${mod}+Shift+z`)
  expect(await hasCutout()).toBe(false)
  await drag(70, -3.2, async () => {
    await expect.poll(() => at(70)).toEqual(span(66, 68))
    await expect(noRoom).toBeHidden()
  })
  expect(await at(70)).toEqual(span(66, 68))
  expect(await undoLabel(page)).toBe('Move Dancer')
  await page.keyboard.press(`${mod}+z`)

  // A few hundredths of a second too long for the gap: it is trimmed to fill it, and the toast says by how much, with
  // an Undo.
  await page.evaluate(
    (id) =>
      window.mvStudio.app.project.dispatch({ type: 'clip.trim', clipId: id, start: 64, duration: 2.04 }),
    ids[64],
  )
  const name = (await clip(70).getAttribute('aria-label'))!.split(',')[0]
  await drag(70, -3.2)
  expect(await at(70)).toEqual(span(66.04, 68))
  const trimmed = toastWith(`Trimmed 0.04 s off ${name} to fit the gap`)
  await expect(trimmed).toBeVisible()
  await trimmed.getByRole('button', { name: 'Undo' }).click()
  expect(await at(70)).toEqual(span(70, 72))

  // Neon grid half a second shorter: the clip two along can't swap with it, and the hint and the toast say why.
  await page.evaluate(
    (id) => window.mvStudio.app.project.dispatch({ type: 'clip.trim', clipId: id, start: 68, duration: 1.5 }),
    ids[68],
  )
  await drag(72, -4, async () => {
    await expect(noRoom).toBeVisible()
    await expect(page.getByText('Swaps only with a neighbor or a clip of the same length')).toBeVisible()
    await expect(page.getByText(/^Hold (Ctrl|⌘) while dragging to insert$/)).toBeVisible()
  })
  await expect(
    page.getByText('No room there. A clip swaps places only with its neighbor or a clip of the same length.'),
  ).toBeVisible()
  expect(await at(72)).toEqual(span(72, 74))

  // Its neighbor swaps with it whatever their lengths, in the space they share: the half-second gap stays between them.
  await drag(70, -2)
  expect([await at(70), await at(68)]).toEqual([span(68, 70), span(70.5, 72)])
  expect(await undoLabel(page)).toBe('Swap clips')
})

test('the reason a drop is refused stays inside the lanes when the clip is let go near their right edge', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await openEditor(page)
  await page.keyboard.press('n')
  // Neon grid (1:08) half a second shorter, so Tunnel lights two along can't swap with it: the longest reason.
  const ids: Record<number, string> = await page.evaluate(() => {
    const { editor, dispatch } = window.mvStudio.app.project
    const clips = (
      Object.values(editor.getProject().clips) as { id: string; trackId: string; start: number }[]
    ).filter(
      (c) => c.trackId === 't-video' && (Math.abs(c.start - 68) < 0.01 || Math.abs(c.start - 72) < 0.01),
    )
    dispatch({ type: 'clip.trim', clipId: clips.find((c) => c.start < 70)!.id, start: 68, duration: 1.5 })
    return Object.fromEntries(clips.map((c) => [Math.round(c.start), c.id]))
  })
  // Zoomed in and scrolled so Neon grid is three quarters of the way across the lanes.
  await page.evaluate(() => window.mvStudio.app.ui.set({ pxPerSec: 24 }))
  const scroller = page.locator('[data-timeline-scroller]')
  await scroller.evaluate((el) => {
    el.scrollLeft = 68 * 24 - 0.75 * (el.clientWidth - 148)
  })
  const tunnel = page.locator(`[data-clip-id="${ids[72]}"]`)
  await expect(tunnel).toBeInViewport()
  const from = await center(tunnel)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x - 4 * 24, from.y, { steps: 10 })
  const reason = page.getByText('Swaps only with a neighbor or a clip of the same length')
  await expect(reason).toBeVisible()
  const label = (await reason.locator('..').boundingBox())!
  const lanes = (await scroller.boundingBox())!
  expect(label.x).toBeGreaterThan(lanes.x + 148)
  expect(label.x + label.width).toBeLessThanOrEqual(lanes.x + lanes.width)
  await page.mouse.up()
})
