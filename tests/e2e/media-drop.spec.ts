import type { Locator, Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

/*
 * A Library › Media card dropped on the sample's Video track: into the gap a deleted shot left, it fills the gap on
 * that track, trimmed to fit; on a shot, it goes on another track, and the drag and the toast say where.
 */

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

test('a media card dropped on a shot goes on another track, and the drag and the toast say where', async ({
  page,
}) => {
  await openEditor(page)
  const dancer = page.getByRole('tabpanel', { name: 'Media' }).getByLabel(/^Dancer, video/)
  // A shot in the second verse, where Overlay is free.
  const shot = page.locator('[data-clip-id="c-s-v2-1"]')
  await dragOver(page, dancer, shot)
  await expect(page.getByText(/^Goes on Overlay · Hold (Alt|⌥) to replace$/)).toBeVisible()
  await page.mouse.up()
  const at = await placed(page)
  expect(at).toMatchObject({ track: 'Overlay', duration: 9.5 })
  await expect(
    page
      .locator('[data-toast]')
      .filter({ hasText: /^Added “Dancer” on Overlay at 1:4\d\.\d: Video is full there/ }),
  ).toBeVisible()
})
