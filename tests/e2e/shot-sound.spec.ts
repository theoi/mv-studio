import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, openHarness, test } from './fixtures.ts'

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../fixtures/.cache')

/** An empty project with the 8 s song analyzed. */
async function songProject(page: Page) {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?project=empty&kind=blank'
  })
  await expect(page.getByText('Start with a song')).toBeVisible()
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Import a song' }).click()
  await (await chooser).setFiles(path.join(FIXTURE_DIR, 'song.mp3'))
  await expect(page.getByRole('tabpanel', { name: 'Media' }).getByText(/^0:08 · /)).toBeVisible({
    timeout: 30_000,
  })
  await page.getByLabel('Import media files').setInputFiles(path.join(FIXTURE_DIR, 'clip.mp4'))
}

/** clip.mp4 (4 s, with a 440 Hz tone) added by hand at `at` s, as Add at playhead does; returns its clip id. */
async function addShot(page: Page, at: number): Promise<string> {
  await page.evaluate((t) => window.mvStudio.app.ui.set({ playhead: t }), at)
  const card = page.getByRole('tabpanel', { name: 'Media' }).getByLabel('clip, video')
  await card.hover()
  await card.getByRole('button', { name: 'Add at playhead' }).click()
  const block = page.getByRole('button', { name: new RegExp(`^clip, 0:0${at}`) })
  await expect(block).toHaveCount(1)
  return block.getAttribute('data-clip-id') as Promise<string>
}

/**
 * The level (RMS) of the shot's own sound in the mix the export renders (renderMix), over its first 3 s: the song is
 * muted in a copy of the project, so only the shot is measured.
 */
function shotLevel(page: Page, id: string): Promise<number> {
  return page.evaluate(async (id) => {
    const { audio } = window.mvStudio.engine
    const project = structuredClone(window.mvStudio.app.project.editor.getProject())
    for (const clip of Object.values(project.clips) as { type: string; muted: boolean }[])
      if (clip.type === 'audio') clip.muted = true
    const { start } = project.clips[id] as { start: number }
    const cache = audio.audioBufferCache(window.mvStudio.media.mediaStore)
    const mix: AudioBuffer = await audio.renderMix(
      project,
      cache,
      { start: start + 0.5, end: start + 3.5 },
      48_000,
    )
    const data = mix.getChannelData(0)
    let sum = 0
    for (const v of data) sum += v * v
    return Math.sqrt(sum / data.length)
  }, id)
}

const undoLabel = (page: Page) =>
  page.evaluate(() => window.mvStudio.app.project.editor.undoLabel() as string | undefined)

function palette(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Command palette' })
  return {
    input: dialog.getByRole('combobox'),
    selected: dialog.locator('[cmdk-item][data-selected="true"]'),
    open: () => page.keyboard.press('ControlOrMeta+k'),
  }
}

test('a shot added by hand starts muted, its add toast says so and turns it on, and Inspector › Sound and the palette set its sound, which the export mix follows', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await songProject(page)
  const id = await addShot(page, 2)
  const added = page.locator('[data-toast]').filter({ hasText: 'Added “clip” at 0:02.0. Its sound is off.' })
  await expect(added.getByRole('button', { name: 'Undo' })).toBeVisible()
  const turnOn = added.getByRole('button', { name: 'Turn sound on' })
  await expect(turnOn).toBeVisible()
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  const block = page.locator(`[data-clip-id="${id}"]`)
  const sound = inspector.getByRole('switch', { name: 'Play the shot’s own sound' })

  // Muted: only the song plays, the timeline shows no speaker, and the export mix has nothing of the shot.
  await expect(sound).not.toBeChecked()
  await expect(inspector.getByText('Off: only the song plays during this shot.')).toBeVisible()
  await expect(inspector.getByRole('slider', { name: 'Volume' })).toHaveCount(0)
  await expect(block).toHaveAttribute('aria-label', /^clip, 0:02\.0 to 0:06\.0$/)
  await expect(block.locator('svg')).toHaveCount(0)
  expect(await shotLevel(page, id)).toBeLessThan(0.001)

  // The add toast's Turn sound on, one undo step; then the switch.
  await turnOn.click()
  await expect(sound).toBeChecked()
  expect(await undoLabel(page)).toBe('Unmute shot sound')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(sound).not.toBeChecked()
  await sound.click()
  await expect(sound).toBeChecked()
  expect(await undoLabel(page)).toBe('Unmute shot sound')
  await expect(block).toHaveAttribute('aria-label', /^clip, 0:02\.0 to 0:06\.0, with its sound$/)
  await expect(block.locator('svg')).toHaveCount(1)
  const full = await shotLevel(page, id)
  expect(full).toBeGreaterThan(0.05)

  // The Volume slider, three steps of 10% down from 100%.
  const volume = inspector.getByRole('slider', { name: 'Volume' })
  await volume.focus()
  for (let i = 0; i < 3; i++) await page.keyboard.press('PageDown')
  await expect(inspector.getByText('70%', { exact: true })).toBeVisible()
  expect((await shotLevel(page, id)) / full).toBeCloseTo(0.7, 2)

  // The palette's Shot volume… page.
  const { input, selected, open } = palette(page)
  await open()
  await input.fill('shot volume')
  await expect(selected).toContainText('Shot volume…')
  await expect(selected).toContainText('clip · 70%')
  await page.keyboard.press('Enter')
  await input.fill('25%')
  await page.keyboard.press('Enter')
  await expect(inspector.getByText('25%', { exact: true })).toBeVisible()
  expect(await undoLabel(page)).toBe('Change shot volume')
  expect((await shotLevel(page, id)) / full).toBeCloseTo(0.25, 2)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(inspector.getByText('70%', { exact: true })).toBeVisible()

  // Mute shot sound, from the palette.
  await open()
  await input.fill('mute shot')
  await expect(selected).toContainText('Mute shot sound')
  await page.keyboard.press('Enter')
  await expect(sound).not.toBeChecked()
  expect(await undoLabel(page)).toBe('Mute shot sound')
  await expect(block.locator('svg')).toHaveCount(0)
  expect(await shotLevel(page, id)).toBeLessThan(0.001)
})

test('several selected shots turn their sound on together, their volume shows Mixed when it differs, and a shot with Volume keyframes is keyed at the playhead', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await songProject(page)
  const a = await addShot(page, 1)
  const b = await addShot(page, 5)
  await page.evaluate((ids) => window.mvStudio.app.ui.selectClips(ids), [a, b])
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  await expect(inspector.getByText('2 clips')).toBeVisible()
  const sound = inspector.getByRole('switch', { name: 'Play the shots’ own sound' })
  await expect(sound).not.toBeChecked()
  await expect(inspector.getByText('Off: only the song plays during these shots.')).toBeVisible()

  await sound.click()
  await expect(sound).toBeChecked()
  expect(await undoLabel(page)).toBe('Unmute shot sound')
  const muted = () =>
    page.evaluate(
      (ids) => ids.map((id) => window.mvStudio.app.project.editor.getProject().clips[id].muted as boolean),
      [a, b],
    )
  expect(await muted()).toEqual([false, false])
  // One step undoes both.
  await page.keyboard.press('ControlOrMeta+z')
  expect(await muted()).toEqual([true, true])
  await page.keyboard.press('ControlOrMeta+Shift+z')
  expect(await muted()).toEqual([false, false])

  await page.evaluate(
    (id) =>
      window.mvStudio.app.project.editor.dispatch({
        type: 'clip.set',
        clipId: id,
        path: ['volume', 'value'],
        value: 0.5,
      }),
    a,
  )
  await expect(inspector.getByText('Mixed', { exact: true })).toBeVisible()

  // Shot a gets Volume keyframes. With the playhead over b only, the slider sets b, and a keeps its volume.
  await page.evaluate((id) => {
    window.mvStudio.app.project.editor.dispatch([
      {
        type: 'keyframe.set',
        clipId: id,
        path: ['volume'],
        keyframe: { time: 0, value: 1, easing: 'linear' },
      },
      {
        type: 'keyframe.set',
        clipId: id,
        path: ['volume'],
        keyframe: { time: 2, value: 0.2, easing: 'linear' },
      },
    ])
    window.mvStudio.app.ui.set({ playhead: 6 })
  }, a)
  const note = inspector.getByText(
    '1 shot has Volume keyframes away from the playhead, so its volume stays. Move the playhead over it to set a keyframe there.',
  )
  await expect(note).toBeVisible()
  const volume = inspector.getByRole('slider', { name: 'Volume' })
  await expect(volume).toHaveAttribute('aria-valuenow', '100')
  const levels = () =>
    page.evaluate(
      (ids) =>
        ids.map((id) => {
          const { volume } = window.mvStudio.app.project.editor.getProject().clips[id] as {
            volume: { value: number; keyframes?: { time: number; value: number }[] }
          }
          return volume.keyframes?.map((k) => [k.time, k.value]) ?? volume.value
        }),
      [a, b],
    )
  await volume.focus()
  await page.keyboard.press('PageDown')
  await expect(inspector.getByText('90%', { exact: true })).toBeVisible()
  expect(await levels()).toEqual([
    [
      [0, 1],
      [2, 0.2],
    ],
    0.9,
  ])

  // Over a, 1 s in, its level there (60%) counts, and a change becomes its keyframe at the playhead.
  await page.evaluate(() => window.mvStudio.app.ui.set({ playhead: 2 }))
  await expect(note).toHaveCount(0)
  await expect(inspector.getByText('Mixed', { exact: true })).toBeVisible()
  await volume.focus()
  await page.keyboard.press('PageDown')
  await expect(inspector.getByText('65%', { exact: true })).toBeVisible()
  expect(await levels()).toEqual([
    [
      [0, 1],
      [1, 0.65],
      [2, 0.2],
    ],
    0.65,
  ])
})
