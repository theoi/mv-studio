import type { Page } from '@playwright/test'
import type { Project } from '../../src/model/types.ts'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

/** RGB split on the clip it was added to, as the inspector edits it. */
function split(page: Page) {
  return page.evaluate(() => {
    const project: Project = window.mvStudio.app.project.editor.getProject()
    for (const clip of Object.values(project.clips)) {
      if (clip.type === 'audio') continue
      const fx = clip.effects.find((e) => e.effectId === 'rgb-split')
      if (fx)
        return {
          enabled: fx.enabled,
          amount: fx.params.amount?.value,
          reacts: !!fx.params.amount?.modulation?.length,
        }
    }
    return null
  })
}

test('a clip’s effects show their own settings, turn off and on, and are removed', async ({
  page,
}, testInfo) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?lib=effects&t=66.9'
  })
  await waitForPreview(page)
  await page
    .getByRole('tabpanel', { name: 'Effects' })
    .getByRole('button', { name: 'RGB split', exact: true })
    .click()
  await expect(page.getByText(/^“RGB split” added to /)).toBeVisible()
  await page
    .getByRole('tabpanel', { name: 'Inspector' })
    .getByRole('button', { name: /^Effects/ })
    .click()

  const amount = page.getByRole('slider', { name: 'Amount' })
  await expect(amount).toBeVisible()
  await expect(page.getByRole('slider', { name: 'Angle' })).toBeVisible()
  // RGB split comes with a music reaction on Amount, which the react button shows.
  await expect(page.getByRole('button', { name: 'React to music: Amount' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.screenshot({ path: testInfo.outputPath('effects-section.png') })
  const before = await split(page)
  await amount.focus()
  await page.keyboard.press('ArrowRight')
  expect((await split(page))?.amount).toBeGreaterThan(Number(before?.amount))

  await page.getByRole('switch', { name: 'RGB split on' }).click()
  expect((await split(page))?.enabled).toBe(false)
  await page.getByRole('button', { name: 'Remove RGB split' }).click()
  expect(await split(page)).toBeNull()
  await expect(page.getByText('No effects yet. Add one from Library › Effects.')).toBeVisible()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect.poll(async () => (await split(page))?.enabled).toBe(false)
})
