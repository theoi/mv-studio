import type { Locator, Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

/** Track headers through the UI: hide, lock, mute and solo, and reordering by dragging the grip, the menu and keys. */

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function openEditor(page: Page, hash: string) {
  await openHarness(page)
  await page.evaluate((h) => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = h
  }, hash)
  await waitForPreview(page)
  // The design review's screen list sits over the bottom of the timeline, where the Song track's header is.
  await page.evaluate(() => window.mvStudio.app.ui.set({ review: false }))
}

const trackNames = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    (window.mvStudio.app.project.editor.getProject().tracks as { name: string }[]).map((t) => t.name),
  )

const trackState = (page: Page, name: string) =>
  page.evaluate(
    (n) =>
      (
        window.mvStudio.app.project.editor.getProject().tracks as {
          name: string
          hidden: boolean
          locked: boolean
          muted: boolean
          solo: boolean
        }[]
      ).find((t) => t.name === n),
    name,
  )

/** The header row of a track: the element that holds its reorder grip. */
const header = (page: Page, name: string): Locator =>
  page.locator('div', { has: page.getByRole('button', { name: `Move the ${name} track` }) }).last()

test('the track header icons hide, lock, mute and solo, each one undo step', async ({ page }) => {
  await openEditor(page, '#/editor?t=67')
  const video = header(page, 'Video')
  await video.getByRole('button', { name: 'Hide track' }).click()
  await expect(video.getByRole('button', { name: 'Show track' })).toHaveAttribute('aria-pressed', 'true')
  expect((await trackState(page, 'Video'))?.hidden).toBe(true)
  await page.keyboard.press(`${mod}+z`)
  await expect(video.getByRole('button', { name: 'Hide track' })).toHaveAttribute('aria-pressed', 'false')

  await video.getByRole('button', { name: 'Lock track' }).click()
  await expect(video.getByRole('button', { name: 'Unlock track' })).toHaveAttribute('aria-pressed', 'true')
  const singer = page.getByRole('button', { name: 'Singer close-up, 1:06.0 to 1:08.0' })
  const box = (await singer.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 5 })
  await page.mouse.up()
  await expect(page.getByText('The Video track is locked. Unlock it to edit.')).toBeVisible()
  await expect(singer).toBeVisible()
  await page.keyboard.press('Delete')
  await expect(page.getByText('That track is locked. Unlock it to edit.')).toBeVisible()
  await expect(singer).toBeVisible()
  await video.getByRole('button', { name: 'Unlock track' }).click()
  expect((await trackState(page, 'Video'))?.locked).toBe(false)

  const song = header(page, 'Song')
  await song.getByRole('button', { name: 'Mute' }).click()
  await expect(song.getByRole('button', { name: 'Unmute' })).toHaveAttribute('aria-pressed', 'true')
  await song.getByRole('button', { name: 'Solo' }).click()
  await expect(song.getByRole('button', { name: 'Solo' })).toHaveAttribute('aria-pressed', 'true')
  expect(await trackState(page, 'Song')).toMatchObject({ muted: true, solo: true })
  await page.keyboard.press(`${mod}+z`)
  await page.keyboard.press(`${mod}+z`)
  expect(await trackState(page, 'Song')).toMatchObject({ muted: false, solo: false })
})

test('tracks reorder by dragging the header grip, from the header menu and with the arrow keys', async ({
  page,
}) => {
  await openEditor(page, '#/editor?t=67')
  const before = ['Lyrics', 'Look', 'Overlay', 'Video', 'Song']
  expect(await trackNames(page)).toEqual(before)

  // Drag the Overlay grip below the Video track.
  const overlay = header(page, 'Overlay')
  await overlay.hover()
  const grip = overlay.getByRole('button', { name: 'Move the Overlay track' })
  const g = (await grip.boundingBox())!
  const v = (await header(page, 'Video').boundingBox())!
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2)
  await page.mouse.down()
  await page.mouse.move(g.x + g.width / 2, v.y + v.height - 4, { steps: 10 })
  await page.mouse.up()
  expect(await trackNames(page)).toEqual(['Lyrics', 'Look', 'Video', 'Overlay', 'Song'])

  // Visual tracks stay above the song: dragging past it stops at the last visual place.
  const look = header(page, 'Look')
  await look.hover()
  const lg = (await look.getByRole('button', { name: 'Move the Look track' }).boundingBox())!
  const s = (await header(page, 'Song').boundingBox())!
  await page.mouse.move(lg.x + lg.width / 2, lg.y + lg.height / 2)
  await page.mouse.down()
  await page.mouse.move(lg.x + lg.width / 2, s.y + s.height - 2, { steps: 10 })
  await page.mouse.up()
  expect(await trackNames(page)).toEqual(['Lyrics', 'Video', 'Overlay', 'Look', 'Song'])
  // The look is below tracks it colored before, and a toast says so.
  await expect(page.getByText('The look no longer colors the tracks above it.')).toBeVisible()
  await page.keyboard.press(`${mod}+z`)
  await expect(page.getByText('Undid: Move track')).toBeVisible()

  // The header menu: Overlay back up; Video is then the lowest visual track and can't move down.
  await header(page, 'Overlay').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Move up' }).click()
  expect(await trackNames(page)).toEqual(before)
  await expect(header(page, 'Overlay').getByRole('button', { name: 'Move the Overlay track' })).toBeFocused()
  await header(page, 'Video').click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Move down' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await header(page, 'Song').click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Move up' })).toBeDisabled()
  await page.keyboard.press('Escape')

  // The keyboard: arrow keys on a focused grip move its track, not the playhead.
  const playhead = await page.evaluate(() => window.mvStudio.app.ui.get().playhead)
  await header(page, 'Lyrics').getByRole('button', { name: 'Move the Lyrics track' }).focus()
  // Scoped by name: the header's Mute tooltip can still be closing when this one opens.
  const tip = page.getByRole('tooltip', { name: /Drag to reorder/ })
  await expect(tip).toContainText('Drag to reorder')
  await expect(tip).toContainText('↑ ↓ when focused')
  await page.keyboard.press('ArrowDown')
  expect(await trackNames(page)).toEqual(['Look', 'Lyrics', 'Overlay', 'Video', 'Song'])
  expect(await page.evaluate(() => window.mvStudio.app.ui.get().playhead)).toBe(playhead)
  await expect(
    page.locator('.sr-only[aria-live="polite"]', { hasText: 'Moved the Lyrics track down, to 2 of 4.' }),
  ).toBeAttached()

  // Under the Overlay track, the lyrics are covered: a toast says so, and its Undo puts them back.
  await page.keyboard.press('ArrowDown')
  expect(await trackNames(page)).toEqual(['Look', 'Overlay', 'Lyrics', 'Video', 'Song'])
  const note = page
    .getByRole('status')
    .locator('div', { hasText: 'The lyrics are behind the Overlay track now, which covers them.' })
  await note.getByRole('button', { name: 'Undo' }).click()
  expect(await trackNames(page)).toEqual(['Look', 'Lyrics', 'Overlay', 'Video', 'Song'])
})
