import type { Page } from '@playwright/test'
import type { Project } from '../../src/model/index.ts'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

async function openEditor(page: Page, hash = '#/editor?kind=lyric&t=73') {
  await openHarness(page)
  await page.evaluate((h) => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = h
  }, hash)
  await waitForPreview(page)
  await page.locator('body').click({ position: { x: 1, y: 1 } })
}

/** Selects the first clip of a type and returns its track's name. */
async function selectClip(page: Page, type: string): Promise<string> {
  return page.evaluate((type) => {
    const { app } = window.mvStudio
    const project: Project = app.project.editor.getProject()
    const clip = Object.values(project.clips).find((c) => c.type === type)!
    app.ui.select({ type: 'clip', id: clip.id })
    return project.tracks.find((t) => t.id === clip.trackId)!.name
  }, type)
}

function palette(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Command palette' })
  return {
    dialog,
    input: dialog.getByRole('combobox'),
    selected: dialog.locator('[cmdk-item][data-selected="true"]'),
    open: () => page.keyboard.press('ControlOrMeta+k'),
  }
}

test('the palette’s track, section and volume actions name what they act on, and say why when they can’t', async ({
  page,
}) => {
  await openEditor(page)
  const { dialog, input, selected, open } = palette(page)
  const bar = page.getByRole('banner')

  await open()
  await input.fill('hide track')
  await expect(selected).toHaveText(/^Hide track\s*Select a clip on the track first$/)
  await page.keyboard.press('Enter')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')

  const track = await selectClip(page, 'video')
  // Add an effect… names the clip it goes on: a video clip without a name of its own by its media's.
  const media = await page.evaluate(() => {
    const { app } = window.mvStudio
    const project: Project = app.project.editor.getProject()
    const clip = project.clips[app.ui.get().selection.id]!
    return clip.type === 'video' && !clip.name ? project.assets[clip.assetId]!.name : undefined
  })
  expect(media).toBeTruthy()
  await open()
  await input.fill('add an effect')
  await expect(selected).toHaveText(`Add an effect…${media}`)
  await page.keyboard.press('Escape')
  await open()
  await input.fill('hide track')
  await expect(selected).toHaveText(new RegExp(`^Hide track\\s*${track}$`))
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  await expect(bar.getByRole('button', { name: `Undo hide ${track}` })).toBeEnabled()
  await open()
  await input.fill('show track')
  await expect(selected).toHaveText(new RegExp(`^Show track\\s*${track}$`))
  await page.keyboard.press('Escape')

  // The section under the playhead (1:13) is named in the row, and its start is where the playhead goes.
  const section = await page.evaluate(() => {
    const { app } = window.mvStudio
    const t = app.ui.get().playhead
    return app.project.sectionAt(app.project.editor.getProject(), t)
  })
  await open()
  await input.fill('go to section start')
  await expect(selected).toContainText('Go to the start of the section')
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  expect(await page.evaluate(() => window.mvStudio.app.ui.get().playhead)).toBe(section.start)

  await open()
  await input.fill('volume')
  await expect(selected).toHaveText(/^Volume…\s*100%$/)
  await page.keyboard.press('Enter')
  await expect(input).toHaveAttribute('placeholder', 'Search volume levels')
  await dialog.getByRole('option', { name: '50%' }).click()
  await expect(dialog).toBeHidden()
  await open()
  await input.fill('volume')
  await expect(selected).toHaveText(/^Volume…\s*50%$/)
})

test('Add a keyframe… and React to music… list the selected clip’s properties, and a reaction is picked in a second list', async ({
  page,
}) => {
  await openEditor(page)
  const { dialog, input, selected, open } = palette(page)
  const bar = page.getByRole('banner')

  await open()
  await input.fill('add keyframe')
  await expect(selected).toHaveText(/^Add a keyframe…\s*Select a clip first$/)
  await page.keyboard.press('Escape')

  await selectClip(page, 'video')
  await open()
  await input.fill('add keyframe')
  await page.keyboard.press('Enter')
  await expect(input).toHaveAttribute('placeholder', 'Search properties')
  for (const name of ['Position', 'Scale', 'Rotation', 'Opacity', 'Exposure'])
    await expect(dialog.getByRole('option', { name, exact: true })).toBeVisible()
  // The list's search has focus, so typing narrows it.
  await page.keyboard.type('opacity')
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  await expect(page.getByText(/^Keyframe added at /)).toBeVisible()
  await expect(bar.getByRole('button', { name: 'Undo add keyframe' })).toBeEnabled()
  const keyframes = () =>
    page.evaluate(() => {
      const { app } = window.mvStudio
      const project: Project = app.project.editor.getProject()
      const clip = project.clips[app.ui.get().selection.id]!
      return clip.type === 'audio' ? [] : (clip.opacity.keyframes ?? [])
    })
  expect(await keyframes()).toHaveLength(1)
  // The same property again removes the keyframe at the playhead.
  await open()
  await input.fill('add keyframe')
  await page.keyboard.press('Enter')
  await expect(dialog.getByRole('option', { name: /^Opacity/ })).toContainText('Removes the keyframe here')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')

  await open()
  await input.fill('react to music')
  await page.keyboard.press('Enter')
  await input.fill('scale')
  await page.keyboard.press('Enter')
  await expect(input).toHaveAttribute('placeholder', 'Search reactions')
  await expect(dialog.getByText('What scale reacts to')).toBeVisible()
  // Backspace in the empty search goes back a list, and Esc too.
  await page.keyboard.press('Backspace')
  await expect(input).toHaveAttribute('placeholder', 'Search properties')
  await page.keyboard.type('scale')
  await page.keyboard.press('Enter')
  await dialog.getByRole('option', { name: /^Pulse with kick/ }).click()
  await expect(dialog).toBeHidden()
  await expect(bar.getByRole('button', { name: 'Undo React to music: Pulse with kick' })).toBeEnabled()
  await open()
  await input.fill('react to music')
  await page.keyboard.press('Enter')
  await expect(dialog.getByRole('option', { name: /^Scale/ })).toContainText('%')
  await page.keyboard.press('Escape')
  await expect(input).toHaveAttribute('placeholder', /^Search actions/)
})

test('picking the current reaction again, or a reaction on a locked track, adds no undo step', async ({
  page,
}) => {
  await openEditor(page)
  const { dialog, input, open } = palette(page)
  await selectClip(page, 'video')
  const undoSteps = () => page.evaluate(() => window.mvStudio.app.project.editor.history().undo)
  const clipState = () =>
    page.evaluate(() => {
      const { app } = window.mvStudio
      const project: Project = app.project.editor.getProject()
      return JSON.stringify(project.clips[app.ui.get().selection.id])
    })
  const pick = async (reaction: string) => {
    await open()
    await input.fill('react to music')
    await page.keyboard.press('Enter')
    await input.fill('scale')
    await page.keyboard.press('Enter')
    await dialog.getByRole('option', { name: new RegExp(`^${reaction}`) }).click()
    await expect(dialog).toBeHidden()
  }

  const before = await clipState()
  await pick('Pulse with kick')
  const pulse = await clipState()
  expect(pulse).not.toBe(before)
  const steps = await undoSteps()
  await pick('Pulse with kick')
  expect(await undoSteps()).toEqual(steps)

  await open()
  await input.fill('lock track')
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  const locked = await undoSteps()
  await pick('Flash on beat')
  await expect(page.getByText('That track is locked. Unlock it to edit.')).toBeVisible()
  await expect(page.getByText('Scale: Flash on beat')).toHaveCount(0)
  expect(await undoSteps()).toEqual(locked)
  expect(await clipState()).toBe(pulse)
})

test('the palette renames the project, switches the aspect ratio, drafts lyrics and opens Export with a loop for Canvas', async ({
  page,
}) => {
  await openEditor(page)
  const { dialog, input, selected, open } = palette(page)

  await open()
  await input.fill('rename project')
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  const name = page.getByRole('textbox', { name: 'Project name' })
  await expect(name).toBeFocused()
  await name.fill('Palette test')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Project: Palette test' })).toBeVisible()

  await open()
  await input.fill('landscape')
  await expect(selected).toHaveText(/^Switch to landscape 16:9\s*Current aspect ratio$/)
  await input.fill('square')
  await expect(selected).toHaveText(/^Switch to square 1:1\s*Changes the project to 1:1$/)
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  expect(await page.evaluate(() => window.mvStudio.app.project.editor.getProject().settings.aspect)).toBe(
    '1:1',
  )

  await open()
  await input.fill('draft lyrics from vocals')
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('radio', { name: 'Draft from vocals' })).toBeChecked()

  await open()
  await input.fill('spotify canvas')
  await page.keyboard.press('Enter')
  const exportDialog = page.getByRole('dialog', { name: 'Export' })
  await expect(exportDialog.getByLabel('Include Loop for Canvas')).toBeChecked()
})

test('the palette tells a vertical version from switching the project to vertical, and words its empty note by the number of words', async ({
  page,
}) => {
  await openEditor(page)
  const { dialog, input, selected, open } = palette(page)

  await open()
  await input.fill('tiktok')
  await expect(selected).toHaveText(/^Export a vertical version…\s*Keeps the project 16:9$/)
  await expect(dialog.getByRole('option', { name: /^Switch to vertical 9:16/ })).toHaveText(
    /Changes the project to 9:16$/,
  )

  await input.fill('zebra')
  await expect(dialog.getByText('No matching action. Try another word.')).toBeVisible()
  await input.fill('zebra stripes')
  await expect(dialog.getByText('No matching action. Try fewer words.')).toBeVisible()
})

test('Ask Assist shows the Enter key only while it is the highlighted row, since Enter runs the highlighted row', async ({
  page,
}) => {
  await openEditor(page)
  const { dialog, input, selected, open } = palette(page)
  const askKey = dialog.getByRole('option', { name: /^Ask Assist/ }).locator('kbd')

  await open()
  await input.fill('make a copy of this project')
  await expect(selected).toHaveText(/^Duplicate project/)
  await expect(askKey).toBeHidden()
  for (let i = 0; i < 10 && !/^Ask Assist/.test((await selected.textContent()) ?? ''); i++)
    await page.keyboard.press('ArrowDown')
  await expect(selected).toHaveText(/^Ask Assist/)
  await expect(askKey).toBeVisible()
})

test('Go to a section… finds a section by name: “go to the chorus” lists the choruses with their starts, and a pick moves the playhead there', async ({
  page,
}) => {
  await openEditor(page, '#/editor?t=73')
  const { dialog, input, selected, open } = palette(page)
  const playhead = () => page.evaluate(() => window.mvStudio.app.ui.get().playhead as number)

  await open()
  await input.fill('go to the chorus')
  await expect(selected).toHaveText(/^Go to a section…/)
  await page.keyboard.press('Enter')
  await expect(input).toHaveAttribute('placeholder', 'Search sections')
  await expect(input).toHaveValue('chorus')
  await expect(dialog.getByRole('option')).toHaveText([
    /^Chorus 1.*1:04$/,
    /^Chorus 2.*2:08$/,
    /^Chorus 3.*3:04$/,
    /^Pre-chorus.*0:48$/,
  ])
  await dialog.getByRole('option', { name: /^Chorus 2/ }).click()
  await expect(dialog).toBeHidden()
  expect(await playhead()).toBe(128)

  await open()
  await input.fill('jump to verse 2')
  await page.keyboard.press('Enter')
  await expect(input).toHaveValue('verse 2')
  await expect(selected).toHaveText(/^Verse 2.*1:36$/)
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  expect(await playhead()).toBe(96)
})
