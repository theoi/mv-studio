import type { Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

/**
 * Song markers: M and the toolbar add one at the playhead, drawn on the ruler; clicking one goes to it, dragging moves
 * it, double-click renames it, and its menu and the Delete key remove it, one undo step each.
 */

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function openEditor(page: Page, hash: string) {
  await openHarness(page)
  await page.evaluate((h) => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = h
  }, hash)
  await waitForPreview(page)
  // The design review bar covers the bottom of the timeline.
  await page.evaluate(() => window.mvStudio.app.ui.set({ review: false }))
}

const markers = (page: Page): Promise<[string, number][]> =>
  page.evaluate(() =>
    (window.mvStudio.app.project.editor.getProject().markers as { label: string; time: number }[]).map(
      (m) => [m.label, Math.round(m.time * 100) / 100] as [string, number],
    ),
  )
const playhead = (page: Page): Promise<number> => page.evaluate(() => window.mvStudio.app.ui.get().playhead)
const setPlayhead = (page: Page, t: number) =>
  page.evaluate((t) => window.mvStudio.app.ui.set({ playhead: t }), t)

test('markers are added at the playhead, drawn on the ruler, and go to, move, rename and remove', async ({
  page,
}, testInfo) => {
  await openEditor(page, '#/editor?t=67')
  expect(await markers(page)).toEqual([])

  await page.keyboard.press('m')
  await expect(page.getByText('Added Marker 1 at 1:07.0')).toBeVisible()
  await setPlayhead(page, 75)
  await page.getByRole('button', { name: 'Add marker', exact: true }).click()
  expect(await markers(page)).toEqual([
    ['Marker 1', 67],
    ['Marker 2', 75],
  ])
  // M again at the same place points out the marker that is there.
  await page.keyboard.press('m')
  await expect(page.getByText('Marker 2 is already at 1:15.0')).toBeVisible()
  expect(await markers(page)).toHaveLength(2)

  const first = page.getByRole('button', { name: 'Marker 1, marker at 1:07.0' })
  await expect(first).toBeVisible()
  await expect(first).toContainText('Marker 1')
  await page.screenshot({ path: testInfo.outputPath('timeline-markers.png') })

  // A click goes to the marker.
  await first.click()
  expect(await playhead(page)).toBe(67)

  // A drag moves it, as one undo step.
  const pps: number = await page.evaluate(() => window.mvStudio.app.ui.get().pxPerSec)
  const box = (await first.boundingBox())!
  await page.mouse.move(box.x + 6, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 6 + 2 * pps, box.y + box.height / 2, { steps: 12 })
  await page.mouse.up()
  const [[, moved]] = await markers(page)
  expect(moved).toBeCloseTo(69, 0)
  expect(await playhead(page)).toBe(67)
  await page.keyboard.press(`${mod}+z`)
  await expect(page.getByText('Undid: Move marker')).toBeVisible()
  expect((await markers(page))[0]).toEqual(['Marker 1', 67])

  // Double-click renames it.
  await first.dblclick()
  const name = page.getByRole('textbox', { name: 'Rename marker' })
  await name.fill('Drop')
  await name.press('Enter')
  const drop = page.getByRole('button', { name: 'Drop, marker at 1:07.0' })
  await expect(drop).toBeVisible()

  // The arrows nudge a focused marker without moving the playhead; Delete removes it.
  await drop.focus()
  await page.keyboard.press('ArrowRight')
  expect((await markers(page))[0]).toEqual(['Drop', 67.1])
  expect(await playhead(page)).toBe(67)
  await page.keyboard.press('Delete')
  expect(await markers(page)).toEqual([['Marker 2', 75]])
  await page.keyboard.press(`${mod}+z`)
  expect(await markers(page)).toEqual([
    ['Drop', 67.1],
    ['Marker 2', 75],
  ])

  // The marker menu removes it too.
  const second = page.getByRole('button', { name: 'Marker 2, marker at 1:15.0' })
  await second.click({ button: 'right' })
  await page
    .getByRole('menu')
    .getByRole('menuitem', { name: /^Remove marker/ })
    .click()
  await expect(second).toBeHidden()
  expect(await markers(page)).toEqual([['Drop', 67.1]])
  expect(await playhead(page)).toBe(67)
})
