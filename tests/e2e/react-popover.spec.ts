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

/** A color adjustment of the sample's first chorus clip. */
function adjustment(page: Page, key: string) {
  return page.evaluate((key) => {
    const project: Project = window.mvStudio.app.project.editor.getProject()
    const clip = project.clips['c-s-c1-1']
    const anim = clip && 'adjustments' in clip ? clip.adjustments?.[key as 'contrast'] : undefined
    return {
      value: anim?.value ?? 0,
      keyframes: anim?.keyframes?.length ?? 0,
      reactions: anim?.modulation?.length ?? 0,
    }
  }, key)
}

test('each color adjustment can be keyframed and react to the music', async ({ page }) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?sel=clip:c-s-c1-1&t=67.2'
  })
  await waitForPreview(page)
  await page.getByRole('button', { name: 'Color', exact: true }).click()

  await page.getByRole('button', { name: 'Add keyframe: Exposure' }).click()
  expect((await adjustment(page, 'exposure')).keyframes).toBe(1)
  await expect(page.getByRole('button', { name: 'Remove keyframe: Exposure' })).toBeVisible()

  await page.getByRole('button', { name: 'React to music: Contrast' }).click()
  const panel = page.getByRole('dialog', { name: 'React to music: Contrast' })
  await panel.getByRole('combobox', { name: 'Reaction' }).click()
  await page.getByRole('option', { name: /^Pulse with kick/ }).click()
  expect((await adjustment(page, 'contrast')).reactions).toBe(1)
  await page.keyboard.press('Escape')

  const before = (await adjustment(page, 'saturation')).value
  await page.getByRole('slider', { name: 'Saturation' }).focus()
  await page.keyboard.press('ArrowRight')
  expect((await adjustment(page, 'saturation')).value).toBeGreaterThan(before)
})

test('a downbeat swell picked before the bars are found follows every fourth beat and says so, then the bars', async ({
  page,
}, testInfo) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=70.4'
  })
  await waitForPreview(page)
  const setBars = (bars: 'found' | 'none') =>
    page.evaluate((bars) => {
      const editor = window.mvStudio.app.project.editor
      const project: Project = editor.getProject()
      const id = project.songAssetId!
      const beats = project.analysis.audio[id]!.beats!
      const downbeats = bars === 'found' ? beats.filter((_, i) => i % 4 === 0) : undefined
      editor.dispatch({ type: 'analysis.setGrid', assetId: id, grid: { downbeats } }, { history: 'skip' })
    }, bars)
  await setBars('none')

  await page.getByRole('button', { name: 'React to music: Look intensity' }).click()
  const panel = page.getByRole('dialog', { name: 'React to music: Look intensity' })
  await panel.getByRole('combobox', { name: 'Reaction' }).click()
  await page.getByRole('option', { name: /^Swell on downbeat/ }).click()
  await expect(panel.getByText('Listens to: every fourth beat (bars not found yet).')).toBeVisible()
  expect(await lookModulation(page)).toMatchObject([{ source: { kind: 'downbeat' } }])
  await page.screenshot({ path: testInfo.outputPath('react-panel-bars-guessed.png') })

  // Once the bars are found, the same mapping follows them: nothing is redone.
  await setBars('found')
  await expect(panel.getByText('Listens to: the song’s bar grid.')).toBeVisible()
  expect(await lookModulation(page)).toMatchObject([{ source: { kind: 'downbeat' } }])
  expect(await page.evaluate(() => window.mvStudio.app.project.editor.undoLabel())).toBe(
    'React to music: Swell on downbeat',
  )
})
