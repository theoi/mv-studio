import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, openHarness, test } from './fixtures.ts'

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../fixtures/.cache')

/** An empty project with the song and `clip4k.mp4` (6 s, 60 fps, one key frame) on the timeline from 0 s. */
async function openWith4kClip(page: Page) {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?project=empty&kind=blank'
  })
  await expect(page.getByText('Start with a song')).toBeVisible()
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Import a song' }).click()
  await (await chooser).setFiles(path.join(FIXTURE_DIR, 'song.mp3'))
  await page.getByLabel('Import media files').setInputFiles(path.join(FIXTURE_DIR, 'clip4k.mp4'))
  const card = page.getByRole('tabpanel', { name: 'Media' }).getByLabel('clip4k, video')
  await card.hover({ timeout: 30_000 })
  await card.getByRole('button', { name: 'Add at playhead' }).click()
  await expect(page.getByRole('button', { name: /^clip4k, 0:00/ })).toHaveCount(1)
}

/**
 * A paused frame far past a key frame of 4K footage takes a while to decode, and the frame before stays on screen
 * meanwhile: the stage says it's updating, and stops once the new frame shows.
 */
test('the stage says “Updating…” while a slow paused frame decodes, and stops once it shows', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await openWith4kClip(page)

  const stillPending = () => page.evaluate(() => window.mvStudio.app.stillPending() as boolean)
  const updating = page.getByRole('status').filter({ hasText: 'Updating…' })
  // Near the clip's key frame first, so its video is loaded and that frame shows.
  await page.evaluate(() => window.mvStudio.app.ui.set({ playhead: 0.2 }))
  await expect.poll(stillPending, { timeout: 30_000 }).toBe(false)
  await expect(updating).toHaveCount(0)

  // 5.5 s is 330 frames past the clip's only key frame.
  const seekAt = Date.now()
  await page.evaluate(() => window.mvStudio.app.ui.set({ playhead: 5.5 }))
  await expect(updating).toBeVisible({ timeout: 3_000 })
  const shownAfter = Date.now() - seekAt
  expect(await stillPending()).toBe(true)
  await expect(updating).toBeHidden({ timeout: 60_000 })
  console.log(`“Updating…” shown ${shownAfter} ms after the seek, gone after ${Date.now() - seekAt} ms`)
  expect(await stillPending()).toBe(false)
  const time = await page.evaluate(() => window.mvStudio.app.stagePreview()?.getSnapshot().time)
  expect(time).toBeCloseTo(5.5, 2)

  /** Shows 0.2 s, then 5.5 s again, and returns the note's box once it shows. */
  const slowSeek = async () => {
    await page.evaluate(() => window.mvStudio.app.ui.set({ playhead: 0.2 }))
    await expect.poll(stillPending, { timeout: 30_000 }).toBe(false)
    await expect(updating).toHaveCount(0, { timeout: 5_000 })
    await page.evaluate(() => window.mvStudio.app.ui.set({ playhead: 5.5 }))
    await expect(updating).toBeVisible({ timeout: 3_000 })
    const box = await updating.boundingBox()
    if (!box) throw new Error('The note has no box')
    return box
  }
  const canvas = page.getByRole('img', { name: 'Video preview' })

  // At 200% the frame is larger than the stage: the note is in the stage's visible bottom-right corner, not the
  // frame's, which is off screen.
  await page.evaluate(() => window.mvStudio.app.ui.set({ previewZoom: 2 }))
  const zoomed = await slowSeek()
  const stage = await canvas.locator('xpath=../..').boundingBox()
  const frame = await canvas.boundingBox()
  if (!stage || !frame) throw new Error('No stage')
  expect(frame.width).toBeGreaterThan(stage.width)
  expect(zoomed.x).toBeGreaterThanOrEqual(stage.x)
  expect(zoomed.y).toBeGreaterThanOrEqual(stage.y)
  // Within the stage, its scroll bars aside.
  expect(stage.x + stage.width - (zoomed.x + zoomed.width)).toBeGreaterThan(0)
  expect(stage.x + stage.width - (zoomed.x + zoomed.width)).toBeLessThan(40)
  expect(stage.y + stage.height - (zoomed.y + zoomed.height)).toBeGreaterThan(0)
  expect(stage.y + stage.height - (zoomed.y + zoomed.height)).toBeLessThan(40)
  await expect(updating).toBeHidden({ timeout: 60_000 })

  // In a narrow 9:16 frame the note is its spinner alone, still named for screen readers.
  await page.evaluate(() => window.mvStudio.app.ui.set({ previewZoom: 'fit' }))
  await page.getByRole('button', { name: '16:9', exact: true }).click()
  await page.getByRole('menuitem', { name: /^9:16/ }).click()
  await expect.poll(async () => (await canvas.boundingBox())?.width ?? 0).toBeLessThan(300)
  const narrow = await slowSeek()
  expect(narrow.width).toBeLessThan(30)
  expect(narrow.height).toBeCloseTo(zoomed.height, 0)
})

/**
 * Results written in the background, such as footage analysis, redraw the paused frame too. Only a still a user action
 * asked for makes the stage say it's updating: the same slow redraw does after the user's own edit, and a background
 * write during a slow seek leaves the note up.
 */
test('“Updating…” is for what the user asked for: a background write alone never shows it', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await openWith4kClip(page)
  const stillPending = () => page.evaluate(() => window.mvStudio.app.stillPending() as boolean)
  const updating = page.getByRole('status').filter({ hasText: 'Updating…' })
  const settle = async () => {
    await expect.poll(stillPending, { timeout: 60_000 }).toBe(false)
    await expect(updating).toHaveCount(0, { timeout: 5_000 })
  }
  // Counts the note's appearances, and times the stage's pending stills.
  await page.evaluate(() => {
    const cue = { shown: 0, stills: [] as number[] }
    Object.assign(window, { cue })
    let on = false
    new MutationObserver(() => {
      const now = [...document.querySelectorAll('[role=status]')].some((e) =>
        e.textContent?.includes('Updating…'),
      )
      if (now && !on) cue.shown++
      on = now
    }).observe(document.body, { subtree: true, childList: true, characterData: true })
    const preview = window.mvStudio.app.stagePreview()
    if (!preview) throw new Error('No stage preview')
    let since = 0
    preview.subscribe(() => {
      const { pending } = preview.getSnapshot()
      if (pending && !since) since = performance.now()
      if (!pending && since) {
        cue.stills.push(performance.now() - since)
        since = 0
      }
    })
  })
  const cue = () =>
    page.evaluate(() => (window as unknown as { cue: { shown: number; stills: number[] } }).cue)
  const clipId = await page.evaluate(() => {
    const clips = window.mvStudio.app.project.editor.getProject().clips as Record<
      string,
      { id: string; type: string }
    >
    const clip = Object.values(clips).find((c) => c.type === 'video')
    if (!clip) throw new Error('No clip')
    return clip.id
  })
  const move = (start: number, history: 'record' | 'skip') =>
    page.evaluate(
      ([id, s, h]) =>
        window.mvStudio.app.project.dispatch(
          { type: 'clip.move', moves: [{ clipId: id, start: s }] },
          { history: h },
        ),
      [clipId, start, history] as const,
    )

  // 5.5 s into the clip. Each move below makes the frame at the playhead decode from the clip's key frame again, as
  // slowly as a seek that shows the note.
  await page.evaluate(() => window.mvStudio.app.ui.set({ playhead: 5.5 }))
  await settle()

  // The user's own move, 4.5 s into the clip, says so.
  await move(1, 'record')
  await expect(updating).toBeVisible({ timeout: 3_000 })
  await settle()

  // A background write moving it, 3.1 s into the clip, doesn't. Past the song's end, it also changes the project's
  // length, which the preview reports before it asks for the still.
  const before = await cue()
  await move(2.4, 'skip')
  await settle()
  await page.waitForTimeout(400)
  const after = await cue()
  expect(after.stills.length).toBe(before.stills.length + 1)
  expect(after.stills.at(-1)).toBeGreaterThan(300)
  expect(after.shown).toBe(before.shown)

  // An edit of the user's while a background write's frame decodes (2.7 s into the clip) says so.
  await page.evaluate(
    ([id]) => {
      const { dispatch } = window.mvStudio.app.project
      dispatch({ type: 'clip.move', moves: [{ clipId: id, start: 2.8 }] }, { history: 'skip' })
      dispatch({ type: 'project.setExtension', key: 'e2e.user', value: 1 })
    },
    [clipId] as const,
  )
  await expect(updating).toBeVisible({ timeout: 3_000 })
  await settle()

  // A background write during a slow seek leaves the note up.
  await move(0, 'record')
  await page.evaluate(() => window.mvStudio.app.ui.set({ playhead: 0.2 }))
  await settle()
  await page.evaluate(() => {
    window.mvStudio.app.ui.set({ playhead: 4 })
    window.mvStudio.app.project.dispatch(
      { type: 'project.setExtension', key: 'e2e.background', value: 1 },
      { history: 'skip' },
    )
  })
  await expect(updating).toBeVisible({ timeout: 3_000 })
  await settle()

  // A background write during playback leaves the slow still after Pause saying so. The write moves the clip 1 s
  // later, so the decoder starts again from the key frame and is still on its way when Pause asks for the frame.
  const state = () => page.evaluate(() => window.mvStudio.app.stagePreview()?.getSnapshot().state as string)
  await page.evaluate(() => window.mvStudio.app.ui.set({ playhead: 4.4 }))
  await settle()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Space')
  await expect.poll(state).toBe('playing')
  await page.waitForTimeout(500)
  await move(1, 'skip')
  await page.waitForTimeout(300)
  await page.keyboard.press('Space')
  await expect(updating).toBeVisible({ timeout: 3_000 })
  expect(await state()).toBe('paused')
  await settle()
})
