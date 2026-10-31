import type { Page } from '@playwright/test'
import type { Project } from '../../src/model/types.ts'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

/** An effect on the clip it was added to, as the inspector edits it. */
function effect(page: Page, effectId: string) {
  return page.evaluate((effectId) => {
    const project: Project = window.mvStudio.app.project.editor.getProject()
    for (const clip of Object.values(project.clips)) {
      if (clip.type === 'audio') continue
      const fx = clip.effects.find((e) => e.effectId === effectId)
      if (fx)
        return {
          enabled: fx.enabled,
          amount: fx.params.amount?.value,
          reacts: !!fx.params.amount?.modulation?.length,
        }
    }
    return null
  }, effectId)
}

const undoLabel = (page: Page): Promise<string | null> =>
  page.evaluate(() => window.mvStudio.app.project.editor.undoLabel())

async function openWithEffects(page: Page, names: string[]) {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?lib=effects&t=66.9'
  })
  await waitForPreview(page)
  const library = page.getByRole('tabpanel', { name: 'Effects' })
  for (const name of names) {
    await library.getByRole('button', { name, exact: true }).click()
    await expect(page.getByRole('status').getByText(`“${name}” added to Singer close-up`)).toBeVisible()
  }
  await page
    .getByRole('tabpanel', { name: 'Inspector' })
    .getByRole('button', { name: /^Effects/ })
    .click()
}

test('a clip’s effects show their own settings named after the effect, turn off and on, and are removed', async ({
  page,
}, testInfo) => {
  await openWithEffects(page, ['RGB split', 'Glow'])

  // Each effect's settings say whose they are, so two effects' sliders are told apart.
  const amount = page.getByRole('slider', { name: 'RGB split amount' })
  await expect(amount).toBeVisible()
  await expect(page.getByRole('slider', { name: 'RGB split angle' })).toBeVisible()
  await expect(page.getByRole('slider', { name: 'Glow intensity' })).toBeVisible()
  // RGB split comes with a music reaction on Amount, which the react button shows.
  await expect(page.getByRole('button', { name: 'React to music: RGB split amount' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.screenshot({ path: testInfo.outputPath('effects-section.png') })
  const before = await effect(page, 'rgb-split')
  await amount.focus()
  await page.keyboard.press('ArrowRight')
  expect((await effect(page, 'rgb-split'))?.amount).toBeGreaterThan(Number(before?.amount))
  expect(await undoLabel(page)).toBe('Change RGB split amount')

  // Secondary settings wait under More.
  await expect(page.getByLabel('Glow tint')).toHaveCount(0)
  await page.getByRole('button', { name: 'More Glow settings' }).click()
  await expect(page.getByLabel('Glow tint')).toBeVisible()

  // Off, an effect keeps its settings, dimmed.
  await page.getByRole('switch', { name: 'RGB split on' }).click()
  expect((await effect(page, 'rgb-split'))?.enabled).toBe(false)
  await expect(amount.locator('xpath=ancestor::div[contains(@class, "effectOff")]')).toHaveCount(1)

  // Removing one moves focus to the next effect, and the last to Add effect.
  await page.getByRole('button', { name: 'Remove RGB split' }).focus()
  await page.keyboard.press('Enter')
  expect(await effect(page, 'rgb-split')).toBeNull()
  await expect(page.getByRole('switch', { name: 'Glow on' })).toBeFocused()
  await page.getByRole('button', { name: 'Remove Glow' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByText('No effects yet. Add one from Library › Effects.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add effect' })).toBeFocused()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect.poll(async () => (await effect(page, 'rgb-split'))?.enabled).toBe(false)
})

test('the 3D camera move is set in Motion only, and a LUT choice lists LUT files and the built-in one by name', async ({
  page,
}, testInfo) => {
  await openWithEffects(page, ['Color grade', 'Film grain'])
  await page.evaluate(() => {
    const { app, plugins } = window.mvStudio
    const editor = app.project.editor
    const project: Project = editor.getProject()
    const clip = Object.values(project.clips).find(
      (c) => c.type !== 'audio' && c.effects.some((e) => e.effectId === 'color-grade'),
    )!
    const index = clip.type === 'audio' ? -1 : clip.effects.findIndex((e) => e.effectId === 'color-grade')
    editor.dispatch([
      { type: 'effect.add', clipId: clip.id, effect: plugins.library.createEffectInstance('camera-3d') },
      {
        type: 'clip.set',
        clipId: clip.id,
        path: ['effects', index, 'params', 'lut', 'value'],
        value: 'bundled:luts/neutral.png',
      },
    ])
  })
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  await expect(inspector.getByRole('switch', { name: '3D camera move on' })).toBeVisible()
  await expect(inspector.getByRole('slider', { name: /^3D camera move/ })).toHaveCount(0)
  await expect(inspector.getByRole('combobox', { name: /^3D camera move/ })).toHaveCount(0)

  // A setting's name does not repeat the word it shares with its effect's, and a long grade name fits unclipped in
  // the narrow inspector of a small window.
  await page.setViewportSize({ width: 1280, height: 720 })
  await expect(inspector.getByRole('slider', { name: 'Film grain size' })).toBeVisible()
  const grade = inspector.getByRole('combobox', { name: 'Color grade', exact: true })
  await expect(grade).toHaveText('Teal and orange')
  await grade.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('grade-select.png') })
  expect(
    await grade
      .locator('span')
      .first()
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true)

  const lut = inspector.getByRole('combobox', { name: 'Color grade LUT' })
  await expect(lut).toHaveText('Neutral')
  await lut.click()
  const options = await page.getByRole('option').allInnerTexts()
  expect(options.map((o) => o.split('\n')[0])).toEqual(['None', 'Neutral', 'No LUT files yet'])
  await page.keyboard.press('Escape')
})
