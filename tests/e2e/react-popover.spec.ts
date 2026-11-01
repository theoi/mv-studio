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

test('a reaction picked before stem separation moves to its stem once the stems arrive', async ({
  page,
}, testInfo) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=70.4'
  })
  await waitForPreview(page)
  const undoLabel = () => page.evaluate(() => window.mvStudio.app.project.editor.undoLabel())
  await page.getByRole('button', { name: 'React to music: Look intensity' }).click()
  const panel = page.getByRole('dialog', { name: 'React to music: Look intensity' })
  const picker = panel.getByRole('combobox', { name: 'Reaction' })
  await picker.click()
  // The full mix has no stand-in for the other instruments, so that reaction waits for the stems.
  await expect(page.getByRole('option', { name: /^Pulse with kick/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /^Follow instruments/ })).toHaveCount(0)
  await page.getByRole('option', { name: /^Pulse with kick/ }).click()
  await expect(
    panel.getByText(
      'Listens to: the low end (sub bass), where the kick sits. Separate stems in Assist › Stems to follow the instrument alone.',
    ),
  ).toBeVisible()
  const [mix] = (await lookModulation(page)) ?? []
  expect(mix).toMatchObject({ source: { kind: 'band' }, amount: 0.4 })
  expect(mix?.source).not.toHaveProperty('stem')

  // What the stems job writes, without its assets.
  await page.evaluate(() => {
    const editor = window.mvStudio.app.project.editor
    const project: Project = editor.getProject()
    const id = project.songAssetId!
    const features = project.analysis.audio[id]!.features!
    editor.dispatch(
      {
        type: 'analysis.setStems',
        assetId: id,
        stems: {},
        stemFeatures: { vocals: features, drums: features, bass: features, other: features },
      },
      { history: 'skip' },
    )
  })
  await expect(panel.getByText('Listens to: the drums stem.', { exact: true })).toBeVisible()
  expect(await lookModulation(page)).toMatchObject([{ source: { kind: 'band', stem: 'drums' }, amount: 0.4 }])
  expect(await undoLabel()).toBe('React to music: Pulse with kick')
  await page.screenshot({ path: testInfo.outputPath('react-panel-stems.png') })

  await picker.click()
  await expect(page.getByRole('option', { name: /^Follow instruments/ })).toContainText(
    'Rises and falls with the guitars, keys and synths. Listens to: the other instruments stem.',
  )
  await page.screenshot({ path: testInfo.outputPath('react-picker-stems.png') })
  await page.getByRole('option', { name: /^Follow instruments/ }).click()
  await expect(panel.getByText('Listens to: the other instruments stem.', { exact: true })).toBeVisible()
  expect(await lookModulation(page)).toMatchObject([
    { source: { kind: 'loudness', stem: 'other' }, amount: 0.4 },
  ])

  // A kick reaction still on the mix, as in a project saved before reactions followed the stems.
  await page.evaluate(() => {
    const { app, plugins } = window.mvStudio
    const editor = app.project.editor
    const project: Project = editor.getProject()
    const layer = Object.values(project.clips).find((c) => c.type === 'adjustment')!
    const unseparated: Project = structuredClone(project)
    delete unseparated.analysis.audio[project.songAssetId!]!.stemFeatures
    const target = { clipId: layer.id, property: 'opacity' as const }
    editor.dispatch(plugins.reactions.reactionCommands(unseparated, [target], 'kick', 0.4), {
      label: 'Older project',
    })
  })
  await expect(
    panel.getByText('Listens to: the low end (sub bass), where the kick sits.', { exact: true }),
  ).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('react-panel-upgrade.png') })
  const upgrade = panel.getByRole('button', { name: 'Listen to the drums stem' })
  await upgrade.click()
  await expect(upgrade).toBeHidden()
  await expect(panel.getByText('Listens to: the drums stem.', { exact: true })).toBeVisible()
  expect(await lookModulation(page)).toMatchObject([{ source: { kind: 'band', stem: 'drums' }, amount: 0.4 }])
  expect(await undoLabel()).toBe('React to music: Pulse with kick')

  // Follow instruments in a project whose song has no stems (another song swapped in, say) waits for them.
  await picker.click()
  await page.getByRole('option', { name: /^Follow instruments/ }).click()
  await page.evaluate(() => {
    const editor = window.mvStudio.app.project.editor
    const unseparated: Project = structuredClone(editor.getProject())
    delete unseparated.analysis.audio[unseparated.songAssetId!]!.stemFeatures
    editor.load(unseparated)
  })
  await expect(
    panel.getByText(
      'Listens to: the other instruments stem. It starts moving once stems are separated in Assist › Stems.',
      { exact: true },
    ),
  ).toBeVisible()
  await expect(picker).toHaveText('Follow instruments')
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
