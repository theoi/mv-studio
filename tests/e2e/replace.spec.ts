import type { Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

/*
 * Replace with…: a clip shows other footage from the library and keeps its place, length, effects, keyframes and
 * reactions, as one undo step. From the clip menu (the palette's list of media), a Library › Media card's menu, or a
 * card dropped on the clip with Alt held.
 */

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
/** Singer close-up at 1:06 to 1:08 in the first chorus, whose scale reacts to the beat. */
const CLOSE_UP = 'c-s-c1-1'

async function openEditor(page: Page) {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=67'
  })
  await waitForPreview(page)
  await page.evaluate(() => window.mvStudio.app.ui.set({ review: false }))
}

interface Shown {
  type: string
  assetId: string
  start: number
  duration: number
  effects: unknown
  transform: unknown
}

const shown = (page: Page): Promise<Shown> =>
  page.evaluate((id) => {
    const c = window.mvStudio.app.project.editor.getProject().clips[id] as Shown
    return {
      type: c.type,
      assetId: c.assetId,
      start: c.start,
      duration: c.duration,
      effects: c.effects,
      transform: c.transform,
    }
  }, CLOSE_UP)

const undoLabel = (page: Page): Promise<string | undefined> =>
  page.evaluate(() => window.mvStudio.app.project.editor.undoLabel())

test('Replace with… in the clip menu lists the library’s media, and the pick keeps the clip as it was, as one undo step', async ({
  page,
}) => {
  await openEditor(page)
  const before = await shown(page)
  const clip = page.locator(`[data-clip-id="${CLOSE_UP}"]`)
  await clip.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Replace with…' }).click()

  const dialog = page.getByRole('dialog', { name: 'Command palette' })
  await expect(dialog.getByText('Replace “Singer close-up” with')).toBeVisible()
  await expect(dialog.getByText(/Esc\s*to close/)).toBeVisible()
  // Each row shows a frame of its footage, the one the clip shows now checked. Photos are listed too; audio is not.
  await expect(dialog.getByRole('option', { name: /^Night city/ }).locator('img')).toBeVisible()
  await expect(
    dialog.getByRole('option', { name: /^Singer close-up/ }).locator('.lucide-check'),
  ).toBeVisible()
  await expect(dialog.getByRole('option', { name: /^Rooftop sunset/ })).toContainText('Image')
  await expect(dialog.getByRole('option', { name: /Neon skyline/ })).toHaveCount(0)
  await dialog.getByRole('combobox').fill('night')
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()

  // The same place, length, effects and reactions: only the footage changed.
  expect(await shown(page)).toEqual({ ...before, assetId: 'm-city' })
  await expect(page.getByRole('button', { name: 'Night city, 1:06.0 to 1:08.0' })).toBeVisible()
  expect(await undoLabel(page)).toBe('Replace Singer close-up with Night city')
  const toast = page
    .locator('[data-toast]')
    .filter({ hasText: 'Replaced “Singer close-up” with “Night city”' })
  await expect(toast).toBeVisible()
  await toast.getByRole('button', { name: 'Undo' }).click()
  expect(await shown(page)).toEqual(before)

  // Esc on the list it opened on closes the palette, with nothing replaced.
  await clip.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Replace with…' }).click()
  await expect(dialog.getByText('Replace “Singer close-up” with')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  expect(await shown(page)).toEqual(before)

  // The palette finds it by name.
  await page.keyboard.press(`${mod}+k`)
  await dialog.getByRole('combobox').fill('replace')
  await expect(dialog.locator('[cmdk-item][data-selected="true"]')).toHaveText(
    /^Replace with…\s*Singer close-up$/,
  )
  await page.keyboard.press('Escape')
})

test('a Library › Media card replaces the selected clip from its menu, or when dropped on a clip with Alt held', async ({
  page,
}) => {
  await openEditor(page)
  const before = await shown(page)
  const clip = page.locator(`[data-clip-id="${CLOSE_UP}"]`)
  await clip.click()
  const card = page.getByRole('tabpanel', { name: 'Media' }).getByLabel(/^Rooftop sunset, image/)

  await card.click({ button: 'right' })
  const item = page.getByRole('menuitem', { name: /^Replace the selected clip/ })
  await expect(item).toContainText('“Singer close-up” at 1:06.0')
  await item.click()
  expect(await shown(page)).toMatchObject({ type: 'image', assetId: 'm-sunset', start: before.start })
  expect(await undoLabel(page)).toBe('Replace Singer close-up with Rooftop sunset')
  await page.keyboard.press(`${mod}+z`)
  expect(await shown(page)).toEqual(before)

  // Dragged over the clip, the card goes in by insert and says Alt replaces it; with Alt the ghost is the clip, labelled
  // Replace.
  const city = page.getByRole('tabpanel', { name: 'Media' }).getByLabel(/^Night city, video/)
  const box = (await clip.boundingBox())!
  await city.hover()
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 })
  // The drag starts during the first move, so the pointer moves once more over the clip.
  await page.mouse.move(box.x + box.width / 2 - 1, box.y + box.height / 2)
  await expect(
    page.getByText(/^Insert at 1:06\.0 · later clips move 14\.2 s · Hold (Alt|⌥) to replace$/),
  ).toBeVisible()
  await expect(page.getByText('Replace', { exact: true })).toBeHidden()
  await page.keyboard.down('Alt')
  await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2, { steps: 2 })
  const label = page.getByText('Replace', { exact: true })
  await expect(label).toBeVisible()
  // The 2 s clip is narrower than the label, so it sits above the clip instead of over the next one.
  expect(box.width).toBeLessThan(64)
  const above = (await label.boundingBox())!
  expect(above.y + above.height).toBeLessThanOrEqual(box.y)
  await page.mouse.up()
  await page.keyboard.up('Alt')
  expect(await shown(page)).toEqual({ ...before, assetId: 'm-city' })
  expect(await undoLabel(page)).toBe('Replace Singer close-up with Night city')
})
