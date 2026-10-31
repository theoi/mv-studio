import type { Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

// The harness exposes untyped modules to page.evaluate callbacks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Untyped = any

/** The project's clips of a file (by name without extension) and their tracks; null once the file is gone. */
function clipsOf(page: Page, name: string) {
  return page.evaluate((name) => {
    const p = window.mvStudio.app.project.editor.getProject()
    const asset = (Object.values(p.assets) as Untyped[]).find((a) => a.name.replace(/\.[^.]+$/, '') === name)
    if (!asset) return null
    return (Object.values(p.clips) as Untyped[])
      .filter((c) => c.assetId === asset.id)
      .map((c) => c.trackId as string)
  }, name)
}

test('a Library card’s menu adds the file at the playhead, or removes it with its clips, with Undo', async ({
  page,
}, testInfo) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=20'
  })
  await waitForPreview(page)
  const name = 'Night city'
  const used = (await clipsOf(page, name))!.length
  expect(used).toBeGreaterThan(1)
  const card = page.getByLabel(`${name}, video`, { exact: true })
  const menuItem = (label: string) => page.getByRole('menuitem', { name: new RegExp(`^${label}`) })

  await card.click({ button: 'right' })
  await expect(menuItem('Add at playhead')).toContainText('At 0:20.0')
  await expect(menuItem('Remove from project')).toContainText(`Also removes ${used} clips from the timeline`)
  await page.screenshot({ path: testInfo.outputPath('media-menu.png') })
  await menuItem('Add at playhead').click()
  await expect.poll(async () => (await clipsOf(page, name))?.length).toBe(used + 1)
  await expect(
    page.getByRole('tabpanel', { name: 'Inspector' }).getByText(name, { exact: true }),
  ).toBeVisible()

  await card.click({ button: 'right' })
  await menuItem('Remove from project').click()
  const toast = page.getByRole('status').filter({ hasText: `Removed “${name}” and its ${used + 1} clips` })
  await expect(toast).toBeVisible()
  await expect(card).toHaveCount(0)
  expect(await clipsOf(page, name)).toBeNull()
  // The removed clip was selected, so the inspector shows the project again.
  await expect(
    page.getByRole('tabpanel', { name: 'Inspector' }).getByText(name, { exact: true }),
  ).toHaveCount(0)

  await toast.getByRole('button', { name: 'Undo' }).click()
  await expect(card).toBeVisible()
  expect(await clipsOf(page, name)).toHaveLength(used + 1)

  // With one of its clips on a locked track, the file can't be removed and the menu says why.
  await page.evaluate(
    (trackId) => {
      window.mvStudio.app.project.editor.dispatch({ type: 'track.update', trackId, patch: { locked: true } })
    },
    (await clipsOf(page, name))![0],
  )
  await card.click({ button: 'right' })
  await expect(menuItem('Remove from project')).toBeDisabled()
  await expect(menuItem('Remove from project')).toContainText('Some of its clips are on a locked track')
  await page.keyboard.press('Escape')
  expect(await clipsOf(page, name)).toHaveLength(used + 1)
})
