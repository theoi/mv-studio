import type { Page } from '@playwright/test'
import type { Project } from '../../src/model/types.ts'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

async function openVisualizer(page: Page) {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?sel=clip:o-spec1&t=70.4'
  })
  await waitForPreview(page)
  await expect(page.getByText('Visualizer · 1:04.00 – 1:36.00 · 32.0 s')).toBeVisible()
}

/** The sample's first spectrum clip as the inspector edits it. */
function spectrum(page: Page) {
  return page.evaluate(() => {
    const project: Project = window.mvStudio.app.project.editor.getProject()
    const clip = project.clips['o-spec1']
    if (clip?.type !== 'generator') return null
    return {
      audio: clip.audio?.stem ?? null,
      height: clip.params.height?.value,
      heightReacts: clip.params.height?.modulation?.length ?? 0,
      color: clip.params.color?.value,
      mirror: clip.params.mirror?.value,
    }
  })
}

test('a visualizer’s own settings come from the plugin and edit the clip', async ({ page }, testInfo) => {
  await openVisualizer(page)
  const before = await spectrum(page)
  await expect(page.getByRole('textbox', { name: 'Bars' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('visualizer.png') })

  const height = page.getByRole('slider', { name: 'Height' })
  await height.focus()
  await page.keyboard.press('ArrowRight')
  expect((await spectrum(page))?.height).toBeGreaterThan(Number(before?.height))
  await page.getByLabel('Color', { exact: true }).fill('#22d3ee')
  // The sample's bars are slightly see-through, and a picked color keeps that.
  expect((await spectrum(page))?.color).toBe('#22d3eed0')
  await page.getByRole('switch', { name: 'Mirror' }).click()
  expect((await spectrum(page))?.mirror).toBe(!before?.mirror)

  await page.getByRole('button', { name: 'React to music: Height' }).click()
  await page
    .getByRole('dialog', { name: 'React to music: Height' })
    .getByRole('combobox', { name: 'Reaction' })
    .click()
  await page.getByRole('option', { name: /^Pulse with kick/ }).click()
  expect((await spectrum(page))?.heightReacts).toBe(1)
})

test('a visualizer follows one stem once stems are separated, and says how to get them before', async ({
  page,
}) => {
  await openVisualizer(page)
  await page.getByRole('combobox', { name: 'Audio source' }).click()
  await expect(page.getByRole('option', { name: /^Drums stem/ })).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Separate stems' }).click()
  await expect(page.getByRole('tab', { name: 'Assist', selected: true })).toBeVisible()

  // Give the song drum features, as stem separation does.
  await page.evaluate(() => {
    const { editor } = window.mvStudio.app.project
    const project: Project = structuredClone(editor.getProject())
    const analysis = project.analysis.audio[project.songAssetId!]!
    analysis.stemFeatures = { drums: analysis.features! }
    editor.load(project)
  })
  await page.evaluate(() => {
    window.location.hash = '#/editor?sel=clip:o-spec1&t=70.4'
  })
  await page.getByRole('tab', { name: 'Inspector' }).click()
  await page.getByRole('combobox', { name: 'Audio source' }).click()
  await page.getByRole('option', { name: /^Drums stem/ }).click()
  expect((await spectrum(page))?.audio).toBe('drums')
  await expect(page.getByText('Stems not separated yet')).toHaveCount(0)
  // A focused select trigger keeps the shortcuts, as it takes typeahead.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect.poll(async () => (await spectrum(page))?.audio).toBeNull()
})

test('a visual that follows a stem says its reactions listen to that stem', async ({ page }) => {
  await openVisualizer(page)
  await page.evaluate(() => {
    const { editor } = window.mvStudio.app.project
    const project: Project = structuredClone(editor.getProject())
    const analysis = project.analysis.audio[project.songAssetId!]!
    analysis.stemFeatures = { drums: analysis.features! }
    const clip = project.clips['o-spec1']
    if (clip?.type === 'generator') clip.audio = { stem: 'drums' }
    editor.load(project)
    window.location.hash = '#/editor?sel=clip:o-spec1&t=70.4'
  })
  await page.getByRole('button', { name: 'React to music: Height' }).click()
  const panel = page.getByRole('dialog', { name: 'React to music: Height' })
  await panel.getByRole('combobox', { name: 'Reaction' }).click()
  const loudness = page.getByRole('option', { name: /^Follow loudness/ })
  await expect(loudness).toContainText('Listens to: the loudness of the drums stem.')
  await loudness.click()
  await expect(panel.getByText('Listens to: the loudness of the drums stem.')).toBeVisible()
})

test('values read as percentages and multipliers, an edit names its setting, and Circle spectrum’s artwork is a project image', async ({
  page,
}) => {
  await openVisualizer(page)
  const height = page.getByRole('slider', { name: 'Height' })
  const pct = Math.round(Number((await spectrum(page))?.height) * 100)
  await expect(height).toHaveAttribute('aria-valuetext', `${pct}%`)
  await height.focus()
  await page.keyboard.press('ArrowRight')
  expect(await page.evaluate(() => window.mvStudio.app.project.editor.undoLabel())).toBe('Change height')

  // A circle spectrum over the chorus, selected.
  const image = await page.evaluate(() => {
    const { app, plugins } = window.mvStudio
    const project: Project = app.project.editor.getProject()
    const track = project.tracks.find((t) => t.name === 'Overlay')!
    const clip = plugins.library.createGeneratorClip({
      trackId: track.id,
      generatorId: 'visualizer.circle',
      start: 100,
      duration: 4,
    })
    app.project.editor.dispatch({ type: 'clip.add', clip: { ...clip, id: 'e2e-circle' } })
    window.location.hash = '#/editor?sel=clip:e2e-circle&t=101'
    return Object.values(project.assets).find((a) => a.kind === 'image')!
  })
  await expect(page.getByRole('slider', { name: 'Radius' })).toHaveAttribute('aria-valuetext', '20%')
  const artwork = () =>
    page.evaluate(() => {
      const clip = window.mvStudio.app.project.editor.getProject().clips['e2e-circle']
      return clip?.type === 'generator' ? clip.params.artwork?.value : null
    })
  await page.getByRole('combobox', { name: 'Artwork' }).click()
  await page.getByRole('option', { name: image.name, exact: true }).click()
  expect(await artwork()).toBe(image.id)
  await page.getByRole('combobox', { name: 'Artwork' }).click()
  await page.getByRole('option', { name: 'None', exact: true }).click()
  expect(await artwork()).toBe('')
})
