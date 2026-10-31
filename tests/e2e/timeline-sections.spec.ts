import type { Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

/**
 * The song map and beat grid on the timeline: snapping, the meter and the bar readout follow the detected beats and
 * downbeats; section edges drag (with the touching neighbor) and nudge; the section inspector sets color, start and
 * end; the section menu selects its clips.
 */

// Trace recording snapshots the DOM on every pointer move, which the drag measurements would count as the app's work.
test.use({ trace: 'off' })

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function openEditor(page: Page, hash: string) {
  await openHarness(page)
  await page.evaluate((h) => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = h
  }, hash)
  await waitForPreview(page)
}

interface Span {
  id: string
  start: number
  end: number
  color?: string
}

const sections = (page: Page): Promise<Span[]> =>
  page.evaluate(() => {
    const p = window.mvStudio.app.project.editor.getProject()
    return (p.analysis.audio[p.songAssetId].sections as Span[]).map(({ id, start, end, color }) => ({
      id,
      start,
      end,
      ...(color ? { color } : {}),
    }))
  })

const span = async (page: Page, id: string) => (await sections(page)).find((s) => s.id === id)

const clipStart = (page: Page, id: string): Promise<number> =>
  page.evaluate((clipId) => window.mvStudio.app.project.editor.getProject().clips[clipId].start, id)

/** Waits until the main thread has no long tasks: the sample media (scene videos, the song) are made on first use. */
async function settle(page: Page) {
  for (let i = 0; i < 40; i++) {
    const quiet = await page.evaluate(async () => {
      const sample = window.mvStudio.testing.bench.sampleMainThread()
      await new Promise((resolve) => setTimeout(resolve, 500))
      return sample.stop().longTasks === 0
    })
    if (quiet) return
  }
}

async function measured<T>(page: Page, action: () => Promise<T>) {
  await page.evaluate(() => {
    window.mvStudio.mainSample = window.mvStudio.testing.bench.sampleMainThread()
  })
  await action()
  return page.evaluate(() => window.mvStudio.mainSample.stop())
}

/** Sets the snap menu's checkboxes, then closes the menu. */
async function snapTo(page: Page, on: Record<string, boolean>) {
  await page.getByRole('button', { name: 'Snapping options' }).click()
  for (const [name, checked] of Object.entries(on)) {
    const item = page.getByRole('menuitemcheckbox', { name })
    if ((await item.getAttribute('aria-checked')) !== String(checked)) await item.click()
    await expect(item).toHaveAttribute('aria-checked', String(checked))
  }
  await page.keyboard.press('Escape')
}

test('snapping, the meter and the bar readout follow the detected beats and downbeats', async ({ page }) => {
  await openEditor(page, '#/editor?t=67')
  // Beats without bars: nothing snaps to or counts bars, and the snap menu and the readout say why.
  await page.evaluate(() => {
    const { editor } = window.mvStudio.app.project
    const beats = Array.from({ length: 400 }, (_, i) => 0.25 + i * 0.5)
    editor.dispatch(
      {
        type: 'analysis.setGrid',
        assetId: editor.getProject().songAssetId,
        grid: { tempo: { bpm: 120, confidence: 1 }, beats, downbeats: [] },
      },
      { history: 'skip' },
    )
  })
  // The readout shows the section only: no bar guessed from the tempo, and no beat count.
  await expect(page.getByText('Chorus', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/^(Bar|Beat) \d+$/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /· \d\/4$/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Snapping options' }).click()
  // Off while it can't snap (the choice is kept), with the short reason; the long hint is in the tempo tooltip.
  const barStarts = page.getByRole('menuitemcheckbox', { name: /^Bar starts/ })
  await expect(barStarts).toBeDisabled()
  await expect(barStarts).toHaveAttribute('aria-checked', 'false')
  await expect(barStarts).toContainText('Bars not found yet')
  await expect(barStarts).not.toContainText('Analyze again')
  expect(await page.evaluate(() => window.mvStudio.app.ui.get().barSnap)).toBe(true)
  await page.keyboard.press('Escape')

  // A waltz whose beats start at 0.25 s: bar starts every 1.5 s, at 0.25, 1.75, ..., 66.25, 67.75.
  await page.evaluate(() => {
    const { editor } = window.mvStudio.app.project
    const beats = Array.from({ length: 400 }, (_, i) => 0.25 + i * 0.5)
    editor.dispatch(
      {
        type: 'analysis.setGrid',
        assetId: editor.getProject().songAssetId,
        grid: { tempo: { bpm: 120, confidence: 1 }, beats, downbeats: beats.filter((_, i) => i % 3 === 0) },
      },
      { history: 'skip' },
    )
  })
  await expect(page.getByRole('button', { name: /· 3\/4$/ })).toBeVisible()
  // 67 s is in the 45th bar (66.25-67.75), not the 34th as at 4 beats from 0 s.
  await expect(page.getByText('Bar 45', { exact: true })).toBeVisible()

  const pps: number = await page.evaluate(() => window.mvStudio.app.ui.get().pxPerSec)
  const spectrum = page.getByRole('button', { name: 'Spectrum bars, 1:04.0 to 1:36.0' })
  const id: string = await page.evaluate(
    () =>
      (
        Object.values(window.mvStudio.app.project.editor.getProject().clips) as { id: string; name: string }[]
      ).find((c) => c.name === 'Spectrum bars')!.id,
  )
  const box = (await spectrum.boundingBox())!
  /** By 3.3 s, the clip lands 0.05 s from the beat at 67.25 and 0.45 s from the bar start at 67.75. */
  const drag = async (seconds = 3.3) => {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + seconds * pps, box.y + box.height / 2, { steps: 20 })
    await page.mouse.up()
  }

  await snapTo(page, {
    Beats: false,
    'Bar starts': true,
    Sections: false,
    'Clip edges': false,
    Playhead: false,
  })
  await drag()
  expect(await clipStart(page, id)).toBeCloseTo(67.75, 3)
  await page.keyboard.press(`${mod}+z`)
  expect(await clipStart(page, id)).toBe(64)

  await snapTo(page, { Beats: true, 'Bar starts': false })
  await drag()
  expect(await clipStart(page, id)).toBeCloseTo(67.25, 3)
  await page.keyboard.press(`${mod}+z`)

  await page.keyboard.press('n')
  await drag(3.6)
  expect(await clipStart(page, id)).toBeCloseTo(67.6, 1)
})

test('a section edge drags with its neighbor, snaps to the beat, nudges with the arrows and undoes in one step', async ({
  page,
}) => {
  await openEditor(page, '#/editor?t=67')
  const pps: number = await page.evaluate(() => window.mvStudio.app.ui.get().pxPerSec)
  const edge = page.getByRole('slider', { name: 'Edge between Pre-chorus and Chorus' })
  await expect(edge).toHaveAttribute('aria-valuenow', '64')
  const box = (await edge.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await settle(page)

  // 2.1 s to the right snaps to the beat (and bar start) at 66 s, showing the time beside the edge.
  const drag = await measured(page, async () => {
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 2.1 * pps, y, { steps: 40 })
  })
  await expect(page.getByText('1:06.0', { exact: true })).toBeVisible()
  await page.mouse.up()
  await expect(page.getByText('1:06.0', { exact: true })).toBeHidden()
  expect(await span(page, 's-pre')).toMatchObject({ start: 48, end: 66 })
  expect(await span(page, 's-c1')).toMatchObject({ start: 66, end: 96 })
  await expect(page.getByRole('button', { name: 'Section Chorus, 1:06 to 1:36' })).toBeVisible()
  await expect(page.getByText(/^Section: Chorus/)).toBeVisible()
  await page.keyboard.press(`${mod}+z`)
  await expect(page.getByText('Undid: Move section edge')).toBeVisible()
  expect(await span(page, 's-pre')).toMatchObject({ end: 64 })
  expect(await span(page, 's-c1')).toMatchObject({ start: 64 })

  // It cannot leave the pre-chorus shorter than a second.
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x - 20 * pps, y, { steps: 10 })
  await page.mouse.up()
  expect(await span(page, 's-pre')).toMatchObject({ start: 48, end: 49 })
  await page.keyboard.press(`${mod}+z`)

  // Arrows: to the next beat, then with Shift to the next bar start.
  await edge.focus()
  await page.keyboard.press('ArrowRight')
  expect(await span(page, 's-c1')).toMatchObject({ start: 64.5 })
  await page.keyboard.press('Shift+ArrowRight')
  expect(await span(page, 's-c1')).toMatchObject({ start: 66 })
  expect(await span(page, 's-pre')).toMatchObject({ end: 66 })
  expect(await page.evaluate(() => window.mvStudio.app.ui.get().playhead)).toBe(67)
  // The two nudges are one undo step (the edge, a slider, keeps its keys while focused).
  await edge.blur()
  await page.keyboard.press(`${mod}+z`)
  expect(await span(page, 's-c1')).toMatchObject({ start: 64 })

  console.log('section edge drag main thread', JSON.stringify(drag))
  expect(drag.inputDelayP95Ms).toBeLessThan(100)
  expect(drag.longTaskMaxMs).toBeLessThan(200)
})

test('the section inspector sets color, start and end; the section menu selects its clips, goes to its start and exports a teaser of it', async ({
  page,
}) => {
  await openEditor(page, '#/editor?t=67')
  const chorus = page.getByRole('button', { name: 'Section Chorus, 1:04 to 1:36' })
  // A mouse pointerdown: one without a pointer type counts as touch, whose long press opens the section menu.
  await chorus.dispatchEvent('pointerdown', { pointerType: 'mouse', button: 0, isPrimary: true })
  await expect(page.getByText(/^Section: Chorus/)).toBeVisible()
  await expect(page.getByText('1:04 – 1:36 · 16 bars')).toBeVisible()

  await page.getByRole('radio', { name: 'Bridge' }).click()
  expect(await span(page, 's-c1')).toMatchObject({ color: 'bridge' })
  await expect(chorus).toHaveAttribute('style', /--sec: var\(--section-bridge\)/)
  await page.getByRole('radio', { name: /^Auto/ }).click()
  expect(await span(page, 's-c1')).not.toHaveProperty('color')
  await expect(chorus).toHaveAttribute('style', /--sec: var\(--section-chorus\)/)

  const start = page.getByRole('textbox', { name: 'Section start' })
  await start.fill('62')
  await start.press('Enter')
  expect(await span(page, 's-pre')).toMatchObject({ end: 62 })
  expect(await span(page, 's-c1')).toMatchObject({ start: 62, end: 96 })
  await expect(page.getByText('1:02 – 1:36 · 17 bars')).toBeVisible()
  const end = page.getByRole('textbox', { name: 'Section end' })
  await end.fill('200')
  await end.press('Enter')
  // Verse 2 (96-128) gives way, down to its 1 s minimum.
  expect(await span(page, 's-c1')).toMatchObject({ end: 127 })
  expect(await span(page, 's-v2')).toMatchObject({ start: 127, end: 128 })

  const moved = page.getByRole('button', { name: 'Section Chorus, 1:02 to 2:07' })
  await moved.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Select its clips' }).click()
  const expected: string[] = await page.evaluate(() =>
    (
      Object.values(window.mvStudio.app.project.editor.getProject().clips) as {
        id: string
        type: string
        lyricLineId?: string
        start: number
        duration: number
      }[]
    )
      .filter((c) => c.type !== 'audio' && !c.lyricLineId && c.start < 127 && c.start + c.duration > 62)
      // The look runs the whole song, so it is not this section's.
      .filter((c) => c.type !== 'adjustment' || (c.start >= 62 && c.start + c.duration <= 127))
      .map((c) => c.id),
  )
  expect(expected.length).toBeGreaterThan(3)
  const look: string = await page.evaluate(
    () =>
      (
        Object.values(window.mvStudio.app.project.editor.getProject().clips) as { id: string; type: string }[]
      ).find((c) => c.type === 'adjustment')!.id,
  )
  const selected: string[] = await page.evaluate(() => {
    const { ui } = window.mvStudio.app
    return ui.selectedClipIds(ui.get().selection)
  })
  expect(new Set(selected)).toEqual(new Set(expected))
  expect(selected).not.toContain(look)
  await expect(page.getByText(`${expected.length} clips`, { exact: true })).toBeVisible()

  await moved.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Go to its start' }).click()
  expect(await page.evaluate(() => window.mvStudio.app.ui.get().playhead)).toBe(62)

  // Cut clips to it opens Auto-cut set to this section.
  await page.evaluate(() => window.mvStudio.app.ui.set({ playhead: 10 }))
  await moved.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Cut clips to it…' }).click()
  expect(
    await page.evaluate(() => {
      const { autocut, ui } = window.mvStudio.app
      return { range: autocut.useAutoCut.getState().choices.range, selection: ui.get().selection }
    }),
  ).toEqual({ range: 'section', selection: { type: 'section', id: 's-c1' } })

  await moved.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Export as a teaser…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Export' })
  await expect(dialog.getByLabel('Include Teaser')).toBeChecked()
  await expect(dialog.getByText(/^1:02 – .* · starts on Chorus$/)).toBeVisible()
})
