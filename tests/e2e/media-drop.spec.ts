import type { Locator, Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

/*
 * A Library › Media card dropped on the sample's Video track: into the gap a deleted shot left, it fills the gap on
 * that track, trimmed to fit; on a shot, it goes in at the nearer cut and the later shots move right, as it does
 * anywhere with Ctrl held, and from the palette's and the clip menu's Insert media.
 */

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function openEditor(page: Page) {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=67'
  })
  await waitForPreview(page)
  await page.evaluate(() => window.mvStudio.app.ui.set({ review: false }))
}

/** Drags a card over the middle of `onto` and holds it there, `dx` pixels right of the middle. */
async function dragOver(page: Page, card: Locator, onto: Locator, dx = 0) {
  const box = (await onto.boundingBox())!
  await card.hover()
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 8 })
  // The drag starts during the first move, so the pointer moves once more.
  await page.mouse.move(box.x + box.width / 2 + dx - 1, box.y + box.height / 2)
}

const placed = (page: Page) =>
  page.evaluate(() => {
    const { app } = window.mvStudio
    const selection = app.ui.get().selection
    const clip = selection.type === 'clip' ? app.project.editor.getProject().clips[selection.id] : undefined
    const track = app.project.editor.getProject().tracks.find((t: { id: string }) => t.id === clip?.trackId)
    return clip && { track: track?.name, start: clip.start, duration: clip.duration }
  })

test('a media card dropped in the gap a deleted shot left fills it on the Video track, trimmed to fit', async ({
  page,
}) => {
  await openEditor(page)
  await page.locator('[data-clip-id="c-s-c1-1"]').click()
  await page.keyboard.press('Delete')
  const gap = page.locator('[data-clip-id="c-s-c1-0"]')
  const dancer = page.getByRole('tabpanel', { name: 'Media' }).getByLabel(/^Dancer, video/)
  // Over the empty stretch right after Concert crowd (1:04 to 1:06).
  const box = (await gap.boundingBox())!
  await dragOver(page, dancer, gap, box.width)
  const label = page.getByText('Trimmed to fit', { exact: true })
  await expect(label).toBeVisible()
  // The 2 s gap is narrower than the label, so it sits above the track instead of over the shots beside the gap.
  const above = (await label.boundingBox())!
  expect(above.y + above.height).toBeLessThanOrEqual(box.y)
  await page.mouse.up()
  expect(await placed(page)).toEqual({ track: 'Video', start: 66, duration: 2 })
  await expect(page.getByRole('button', { name: 'Dancer, 1:06.0 to 1:08.0' })).toBeVisible()
  const toast = page
    .locator('[data-toast]')
    .filter({ hasText: 'Added “Dancer” at 1:06.0, trimmed to fill the 2.0 s gap' })
  await expect(toast).toBeVisible()
  await toast.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByRole('button', { name: 'Dancer, 1:06.0 to 1:08.0' })).toHaveCount(0)
})

const startOf = (page: Page, id: string) =>
  page.evaluate((clipId) => window.mvStudio.app.project.editor.getProject().clips[clipId]?.start, id)

test('a media card dropped on a cut goes in there by insert: the drag shows where and how far the later shots move, the toast says the video now runs past the song, and Undo puts it back', async ({
  page,
}) => {
  await openEditor(page)
  const dancer = page.getByRole('tabpanel', { name: 'Media' }).getByLabel(/^Dancer, video/)
  // Concert crowd (1:04 to 1:06), let go just before its end: the cut with Singer close-up at 1:06.
  const shot = page.locator('[data-clip-id="c-s-c1-0"]')
  const box = (await shot.boundingBox())!
  await dragOver(page, dancer, shot, box.width / 2 - 4)
  await expect(
    page.getByText(/^Insert at 1:06\.0 · later clips move 9\.5 s · Hold (Alt|⌥) to replace$/),
  ).toBeVisible()
  await expect(page.getByText(/^Goes on /)).toHaveCount(0)
  const bar = (await page.locator('[data-drop-insert]').boundingBox())!
  expect(Math.abs(bar.x + bar.width / 2 - (box.x + box.width))).toBeLessThan(2)
  await page.mouse.up()
  await expect(page.locator('[data-drop-insert]')).toHaveCount(0)

  expect(await placed(page)).toEqual({ track: 'Video', start: 66, duration: 9.5 })
  expect(await startOf(page, 'c-s-c1-0')).toBe(64)
  expect(await startOf(page, 'c-s-c1-1')).toBe(75.5)
  // The Spectrum bars on Overlay stay where they were.
  expect(await startOf(page, 'o-spec1')).toBe(64)
  const toast = page.locator('[data-toast]').filter({
    hasText:
      /^Inserted “Dancer” at 1:06\.0\. The \d+ clips after it moved 9\.5 s later\. The video now ends 9\.5 s after the song\./,
  })
  await expect(toast).toBeVisible()
  await toast.getByRole('button', { name: 'Undo' }).click()
  expect(await startOf(page, 'c-s-c1-1')).toBe(66)
  const inserted = await page.evaluate(() => {
    const clips = window.mvStudio.app.project.editor.getProject().clips as Record<
      string,
      { start: number; duration: number }
    >
    return Object.values(clips).filter((c) => c.start === 66 && c.duration === 9.5).length
  })
  expect(inserted).toBe(0)
})

test('the drag says when an insert is trimmed to whole bars to stay on the beat, lands past the song’s end, or meets a hidden track', async ({
  page,
}) => {
  await openEditor(page)
  const dancer = page.getByRole('tabpanel', { name: 'Media' }).getByLabel(/^Dancer, video/)
  const videoShots = () =>
    page.evaluate(() =>
      (
        Object.values(window.mvStudio.app.project.editor.getProject().clips) as {
          id: string
          trackId: string
          start: number
        }[]
      )
        .filter((c) => c.trackId === 't-video')
        .sort((a, b) => a.start - b.start)
        .map((c) => c.id),
    )
  // The Video track's shots as an auto-cut tags them; the sample's bars are 2 s at 120 BPM.
  for (const id of await videoShots())
    await page.evaluate(
      (clipId) =>
        window.mvStudio.app.project.editor.dispatch({
          type: 'clip.set',
          clipId,
          path: ['meta'],
          value: { autocut: { v: 1, run: 'e2e', fp: '00000000' } },
        }),
      id,
    )
  const shot = page.locator('[data-clip-id="c-s-c1-0"]')
  const box = (await shot.boundingBox())!
  await dragOver(page, dancer, shot, box.width / 2 - 4)
  await expect(
    page.getByText(
      /^Insert at 1:06\.0 · trimmed to 4 bars to stay on the beat · later clips move 8\.0 s · Hold (Alt|⌥) to replace$/,
    ),
  ).toBeVisible()
  await page.mouse.up()
  expect(await placed(page)).toEqual({ track: 'Video', start: 66, duration: 8 })
  expect(await startOf(page, 'c-s-c1-1')).toBe(74)
  const toast = page.locator('[data-toast]').filter({
    hasText:
      /^Inserted “Dancer” at 1:06\.0, trimmed to 4 bars to stay on the beat\. The \d+ clips after it moved 8\.0 s later\./,
  })
  await expect(toast).toBeVisible()
  await toast.getByRole('button', { name: 'Undo' }).click()
  expect(await startOf(page, 'c-s-c1-1')).toBe(66)

  // After the last shot nothing moves, so it keeps its length, and the whole clip lands after the song.
  await page.keyboard.press('Shift+Z')
  const last = page.locator(`[data-clip-id="${(await videoShots()).at(-1)}"]`)
  const lastBox = (await last.boundingBox())!
  await dragOver(page, dancer, last, lastBox.width / 2 - 2)
  await expect(
    page.getByText(/^Insert at 3:24\.0 · the video ends 9\.5 s after the song · Hold (Alt|⌥) to replace$/),
  ).toBeVisible()
  await page.mouse.up()
  expect(await placed(page)).toEqual({ track: 'Video', start: 204, duration: 9.5 })

  // A hidden track takes no insert: the shots it would push are out of sight.
  await page.evaluate(() =>
    window.mvStudio.app.project.editor.dispatch({
      type: 'track.update',
      trackId: 't-video',
      patch: { hidden: true },
    }),
  )
  const shots = await videoShots()
  await dragOver(page, dancer, shot)
  const hiddenNote = page.getByText('Track is hidden: show it to insert', { exact: true })
  await expect(hiddenNote).toBeVisible()
  // The track's clips are dimmed, the note isn't.
  const opacity = (el: Element) => {
    let o = 1
    for (let n: Element | null = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity)
    return o
  }
  expect(await hiddenNote.evaluate(opacity)).toBe(1)
  expect(await shot.evaluate(opacity)).toBeLessThan(0.5)
  await page.mouse.up()
  expect(await videoShots()).toEqual(shots)
})

test('at 1280 and Fit, a drop note that would run past the lanes’ right edge ends just before its insert line instead', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await openEditor(page)
  await page.keyboard.press('Shift+Z')
  const dancer = page.getByRole('tabpanel', { name: 'Media' }).getByLabel(/^Dancer, video/)
  const shots = await page.evaluate(() =>
    (
      Object.values(window.mvStudio.app.project.editor.getProject().clips) as {
        id: string
        trackId: string
        start: number
      }[]
    )
      .filter((c) => c.trackId === 't-video')
      .sort((a, b) => a.start - b.start)
      .map((c) => c.id),
  )
  /** Where a drop note sits: its edges, the lanes in view (Fit leaves the view unscrolled), and the insert line. */
  const placement = (note: Locator) =>
    note.evaluate((el) => {
      const box = el.getBoundingClientRect()
      const scroller = el.closest<HTMLElement>('[data-timeline-scroller]')!
      const line = document.querySelector('[data-drop-insert]')!.getBoundingClientRect()
      return {
        left: box.left,
        right: box.right,
        lanesLeft: el.parentElement!.getBoundingClientRect().left,
        lanesRight: scroller.getBoundingClientRect().left + scroller.clientWidth,
        line: line.left + line.width / 2,
      }
    })
  const dropAndUndo = async () => {
    await page.mouse.up()
    await page
      .locator('[data-toast]')
      .filter({ hasText: /^Inserted “Dancer”/ })
      .last()
      .getByRole('button', { name: 'Undo' })
      .click()
  }

  // In the middle of the timeline, the note starts just past the insert line.
  const middle = page.locator('[data-clip-id="c-s-c1-0"]')
  await dragOver(page, dancer, middle, (await middle.boundingBox())!.width / 2 - 1)
  const mid = await placement(page.getByText(/^Insert at 1:06\.0 · later clips move/))
  expect(mid.left).toBeGreaterThan(mid.line)
  await dropAndUndo()

  // On one of the last shots and after the last one, near the right edge, it ends before the line, inside the lanes.
  for (const [id, note] of [
    [shots.at(-3)!, /^Insert at 3:\d\d\.\d · later clips move 9\.5 s · Hold (Alt|⌥) to replace$/],
    [shots.at(-1)!, /^Insert at 3:24\.0 · the video ends 9\.5 s after the song · Hold (Alt|⌥) to replace$/],
  ] as const) {
    const shot = page.locator(`[data-clip-id="${id}"]`)
    await dragOver(page, dancer, shot, (await shot.boundingBox())!.width / 2 - 1)
    const at = await placement(page.getByText(note))
    expect(at.right).toBeLessThanOrEqual(at.line)
    expect(at.right).toBeLessThanOrEqual(at.lanesRight)
    expect(at.left).toBeGreaterThanOrEqual(at.lanesLeft)
    await dropAndUndo()
  }
})

test('with Ctrl held, a media card goes in by insert where it is let go, even in a gap it would fill', async ({
  page,
}) => {
  await openEditor(page)
  await page.locator('[data-clip-id="c-s-c1-1"]').click()
  await page.keyboard.press('Delete')
  const gap = page.locator('[data-clip-id="c-s-c1-0"]')
  const dancer = page.getByRole('tabpanel', { name: 'Media' }).getByLabel(/^Dancer, video/)
  const box = (await gap.boundingBox())!
  await page.keyboard.down(mod)
  // Over the middle of the empty stretch after Concert crowd (1:06 to 1:08).
  await dragOver(page, dancer, gap, box.width)
  await expect(page.getByText(/^Insert at 1:0[67]\.\d · later clips move 9\.5 s$/)).toBeVisible()
  await expect(page.getByText('Trimmed to fit', { exact: true })).toHaveCount(0)
  await page.mouse.up()
  await page.keyboard.up(mod)
  const at = (await placed(page))!
  expect(at).toMatchObject({ track: 'Video', duration: 9.5 })
  expect(at.start).toBeGreaterThan(66)
  expect(at.start).toBeLessThan(68)
  // Neon grid, which started the next shot at 1:08, moved right by the whole card.
  expect(await startOf(page, 'c-s-c1-2')).toBe(77.5)
})

test('the palette’s Insert media at the playhead… and the clip menu’s Insert media… put a video or image in at the cut', async ({
  page,
}) => {
  await openEditor(page)
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  // The playhead is at 1:07, in Singer close-up (1:06 to 1:08), as near its start as its end.
  await page.keyboard.press(`${mod}+k`)
  await palette.getByRole('combobox').fill('insert')
  const action = palette.getByRole('option', { name: /^Insert media at the playhead…/ })
  await expect(action).toContainText('At the cut at 1:06.0')
  await action.click()
  await expect(palette.getByText('Insert at the cut at 1:06.0', { exact: true })).toBeVisible()
  await palette.getByRole('option', { name: /^Dancer/ }).click()
  await expect(palette).toBeHidden()
  expect(await placed(page)).toEqual({ track: 'Video', start: 66, duration: 9.5 })
  expect(await startOf(page, 'c-s-c1-1')).toBe(75.5)
  await expect(
    page
      .locator('[data-toast]')
      .filter({ hasText: /^Inserted “Dancer” at 1:06\.0\. The \d+ clips after it moved 9\.5 s/ }),
  ).toBeVisible()

  // Right-clicked near the end of a later shot, the menu inserts at the cut after it.
  const shot = page.locator('[data-clip-id="c-s-c1-3"]')
  const box = (await shot.boundingBox())!
  await shot.click({ button: 'right', position: { x: box.width - 4, y: box.height / 2 } })
  const item = page.getByRole('menuitem', { name: /^Insert media…/ })
  await expect(item).toContainText('At the cut at 1:21.5 · the later clips move right')
  await item.click()
  await expect(palette.getByText('Insert at the cut at 1:21.5', { exact: true })).toBeVisible()
  await palette.getByRole('option', { name: /^Rooftop sunset/ }).click()
  await expect(palette).toBeHidden()
  // A photo is 2 bars, 4 s at 120 BPM.
  expect(await placed(page)).toEqual({ track: 'Video', start: 81.5, duration: 4 })
  expect(await startOf(page, 'c-s-c1-4')).toBe(85.5)
})
