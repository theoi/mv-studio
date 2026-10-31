import { expect, openHarness, test } from './fixtures.ts'

test('Inspector › Project › Background changes the canvas color as one undo step', async ({ page }) => {
  await openHarness(page)
  await page.evaluate(() => localStorage.setItem('mv-studio.guide-seen', '1'))
  await page.getByRole('button', { name: /^Blank project/ }).click()
  await expect(page.getByText('Start with a song')).toBeVisible()
  const color = page.getByLabel('Background color')
  await color.fill('#ff3366')
  const state = () =>
    page.evaluate(() => {
      const editor = window.mvStudio.app.project.editor
      return { color: editor.getProject().settings.backgroundColor, undo: editor.undoLabel() }
    })
  await expect.poll(state).toEqual({ color: '#ff3366', undo: 'Change background color' })
  await expect(page.getByText('#FF3366')).toBeVisible()
  // Without a song there is no preview yet; the empty stage shows the canvas in the picked color behind its card.
  await expect(page.locator('[class*="emptyFrame"]')).toHaveCSS('background-color', 'rgb(255, 51, 102)')
  await page.getByRole('button', { name: 'Undo' }).first().click()
  await expect.poll(async () => (await state()).color).not.toBe('#ff3366')
})
