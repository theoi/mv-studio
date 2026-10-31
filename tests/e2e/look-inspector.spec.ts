import type { Page } from '@playwright/test'
import type { Project } from '../../src/model/types.ts'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

/** The sample's look layer as the inspector edits it. */
function lookLayer(page: Page) {
  return page.evaluate(() => {
    const project: Project = window.mvStudio.app.project.editor.getProject()
    const clip = project.clips['c-look']
    if (clip?.type !== 'adjustment') return null
    return {
      opacity: clip.opacity.value,
      contrast: clip.adjustments?.contrast?.value ?? 0,
      temperature: clip.adjustments?.temperature?.value,
      effects: clip.effects.map((e) => e.effectId),
    }
  })
}

test('selecting the look layer shows the look: its intensity, color adjustments and effects', async ({
  page,
}, testInfo) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?sel=clip:c-look&t=70.4'
  })
  await waitForPreview(page)
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  const before = await lookLayer(page)
  expect(before?.effects).toEqual(['color-grade', 'glow'])

  await expect(inspector.getByText('Neon night', { exact: true })).toBeVisible()
  await expect(inspector.getByText('Look · On every clip')).toBeVisible()
  await expect(inspector.getByText('Settings for the whole video')).toHaveCount(0)
  await expect(
    inspector.getByText(`${Math.round(Number(before?.opacity) * 100)}%`, { exact: true }),
  ).toBeVisible()
  // Neon night cools the picture, so its Temperature shows next to the three adjustments every clip has.
  await expect(inspector.getByRole('slider', { name: 'Temperature' })).toHaveAttribute(
    'aria-valuenow',
    String(Math.round((Number(before?.temperature) + 1) * 50)),
  )
  await expect(inspector.getByText('Color grade', { exact: true })).toBeVisible()
  await expect(inspector.getByText('Glow', { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('look-inspector.png') })

  await inspector.getByRole('slider', { name: 'Contrast' }).focus()
  await page.keyboard.press('ArrowRight')
  expect((await lookLayer(page))?.contrast).toBeGreaterThan(Number(before?.contrast))
  await inspector.getByRole('slider', { name: 'Look intensity' }).focus()
  await page.keyboard.press('ArrowLeft')
  expect((await lookLayer(page))?.opacity).toBeLessThan(Number(before?.opacity))

  await inspector.getByRole('button', { name: 'Change look' }).click()
  await expect(page.getByRole('tab', { name: 'Effects', selected: true })).toBeVisible()
})
