import type { Page } from '@playwright/test'
import type { Project } from '../../src/model/types.ts'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

/** The modulation on the sample's look layer opacity (its Intensity). */
function lookModulation(page: Page) {
  return page.evaluate(() => {
    const project: Project = window.mvStudio.app.project.editor.getProject()
    const layer = Object.values(project.clips).find((c) => c.type === 'adjustment')
    return layer?.type === 'adjustment' ? (layer.opacity.modulation ?? []) : null
  })
}

test('the react button opens the music reactions: pick one, change its amount, stop it', async ({
  page,
}, testInfo) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=70.4'
  })
  await waitForPreview(page)
  expect(await lookModulation(page)).toEqual([])

  const react = page.getByRole('button', { name: 'React to music: Look intensity' })
  await react.click()
  const panel = page.getByRole('dialog', { name: 'React to music: Look intensity' })
  await expect(panel).toBeVisible()
  await panel.getByRole('combobox', { name: 'Reaction' }).click()
  await page.getByRole('option', { name: /^Follow loudness/ }).click()
  // Picking from the list keeps the panel open, now with the amount.
  const amount = panel.getByRole('slider', { name: 'Reaction amount' })
  await expect(amount).toBeVisible()
  await expect(panel.getByText('35%')).toBeVisible()
  expect(await lookModulation(page)).toMatchObject([{ source: { kind: 'loudness' }, amount: 0.35 }])
  await expect(react).toHaveAttribute('aria-pressed', 'true')
  await page.screenshot({ path: testInfo.outputPath('react-panel.png') })

  await amount.focus()
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
  await expect(panel.getByText('40%')).toBeVisible()
  expect((await lookModulation(page))?.[0]?.amount).toBeCloseTo(0.4, 5)

  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  await expect(react).toBeFocused()
  // Each arrow key press is one undo step, as on every slider.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect.poll(async () => (await lookModulation(page))?.[0]?.amount).toBeCloseTo(0.39, 5)

  await react.click()
  await panel.getByRole('combobox', { name: 'Reaction' }).click()
  await page.getByRole('option', { name: /^Not reacting/ }).click()
  await expect(amount).toBeHidden()
  expect(await lookModulation(page)).toEqual([])
  await expect(react).toHaveAttribute('aria-pressed', 'false')
})
