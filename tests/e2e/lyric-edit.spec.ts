import type { Locator, Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

interface Word {
  text: string
  start: number
  end: number
}

interface LineState {
  id: string
  start?: number
  end?: number
  words: Word[]
  clip: { start: number; end: number }
  undoLabel: string | null
}

async function shot(page: Page, name: string): Promise<void> {
  await test.info().attach(name, { body: await page.screenshot(), contentType: 'image/png' })
}

/** The selected lyric line, the span of its clip and the undo label. */
async function selected(page: Page): Promise<LineState> {
  return page.evaluate(() => {
    const id = new URLSearchParams(location.hash.split('?')[1]).get('sel')?.split(':')[1] ?? ''
    const editor = window.mvStudio.app.project.editor
    const project = editor.getProject()
    const line = project.lyrics.lines.find((l: { id: string }) => l.id === id)
    const clip = Object.values(
      project.clips as Record<string, { lyricLineId?: string; start: number; duration: number }>,
    ).find((c) => c.lyricLineId === id)
    return {
      ...line,
      clip: { start: clip?.start ?? NaN, end: (clip?.start ?? NaN) + (clip?.duration ?? NaN) },
      undoLabel: editor.undoLabel(),
    }
  })
}

/** Drags from (x, y) by dx pixels with the mouse. */
async function drag(page: Page, x: number, y: number, dx: number): Promise<void> {
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y, { steps: 6 })
  await page.mouse.up()
}

/** A lyric chip fully inside the visible timeline and wide enough to grab its edges and words. */
async function visibleChip(page: Page): Promise<Locator> {
  const scroller = (await page.locator('[data-timeline-scroller]').boundingBox())!
  const chips = page.getByRole('button', { name: /^Lyric: / })
  const count = await chips.count()
  for (let i = 0; i < count; i++) {
    const box = await chips.nth(i).boundingBox()
    if (
      box &&
      box.x > scroller.x + 170 &&
      box.x + box.width < scroller.x + scroller.width - 30 &&
      box.width > 160
    )
      return chips.nth(i)
  }
  throw new Error('No lyric chip in view')
}

const PPS = 80

test('Lyrics track: a line moves and its edges and words re-time by dragging, each as one undo step', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=73.6'
  })
  await waitForPreview(page)
  // Zoomed in, every word of a line shows at its sung time.
  await page.evaluate((pps) => {
    window.mvStudio.app.ui.set({ pxPerSec: pps })
    const scroller = document.querySelector<HTMLElement>('[data-timeline-scroller]')!
    scroller.scrollLeft = 73.6 * pps - 300
  }, PPS)
  const chip = await visibleChip(page)
  await chip.click()
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  await expect(inspector.getByText('Lyric line')).toBeVisible()
  const before = await selected(page)
  const n = before.words.length
  expect(n).toBeGreaterThan(2)
  // A click selects without changing anything.
  expect(before.undoLabel).not.toBe('Move lyric line')

  // The end edge: the line now ends 0.3 s earlier, its last word with it; the other words stay.
  let box = (await chip.boundingBox())!
  await drag(page, box.x + box.width - 2, box.y + box.height / 2, -24)
  let now = await selected(page)
  expect(now.undoLabel).toBe('Adjust lyric timing')
  expect(now.clip.end - before.clip.end).toBeCloseTo(-0.3, 1)
  expect(now.words[n - 1]!.end - before.words[n - 1]!.end).toBeCloseTo(now.clip.end - before.clip.end, 6)
  expect(now.words[0]).toEqual(before.words[0])
  expect(now.clip.start).toBe(before.clip.start)

  // The start edge moves the first word and the clip start together.
  const afterEnd = now
  box = (await chip.boundingBox())!
  await drag(page, box.x + 2, box.y + box.height / 2, 16)
  now = await selected(page)
  expect(now.clip.start - afterEnd.clip.start).toBeCloseTo(0.2, 1)
  expect(now.words[0]!.start - afterEnd.words[0]!.start).toBeCloseTo(now.clip.start - afterEnd.clip.start, 6)
  expect(now.words[0]!.end).toBe(afterEnd.words[0]!.end)
  expect(now.clip.end).toBeCloseTo(afterEnd.clip.end, 6)

  // A word's end edge re-times that word only (the next word starts after a gap).
  const afterStart = now
  const word = page.getByText(afterStart.words[1]!.text, { exact: true }).and(chip.locator('span'))
  box = (await word.first().boundingBox())!
  await drag(page, box.x + box.width - 2, box.y + box.height / 2, -16)
  now = await selected(page)
  expect(now.undoLabel).toBe('Adjust lyric timing')
  expect(now.words[1]!.end - afterStart.words[1]!.end).toBeCloseTo(-0.2, 1)
  expect(now.words[1]!.start).toBe(afterStart.words[1]!.start)
  expect(now.words[2]).toEqual(afterStart.words[2])
  expect(now.clip).toEqual(afterStart.clip)
  await shot(page, 'lyric-drag')

  // The body moves the whole line: every word and the clip by the same amount.
  const afterWord = now
  box = (await chip.boundingBox())!
  await drag(page, box.x + box.width * 0.5, box.y + 4, 16)
  now = await selected(page)
  expect(now.undoLabel).toBe('Move lyric line')
  const moved = now.clip.start - afterWord.clip.start
  expect(moved).toBeCloseTo(0.2, 1)
  now.words.forEach((w, i) => {
    expect(w.start - afterWord.words[i]!.start).toBeCloseTo(moved, 6)
    expect(w.end - afterWord.words[i]!.end).toBeCloseTo(moved, 6)
  })

  // Nudging by frame: the inspector buttons and Alt ← / Alt →, one frame of the 30 fps project each.
  const afterMove = now
  await inspector.getByRole('button', { name: 'Nudge one frame later' }).click()
  now = await selected(page)
  expect(now.undoLabel).toBe('Nudge lyric line')
  expect(now.words[0]!.start - afterMove.words[0]!.start).toBeCloseTo(1 / 30, 6)
  expect(now.clip.start - afterMove.clip.start).toBeCloseTo(1 / 30, 6)
  await chip.click()
  await page.keyboard.press('Alt+ArrowRight')
  await page.keyboard.press('Alt+ArrowRight')
  await page.keyboard.press('Alt+ArrowLeft')
  await expect
    .poll(async () => (await selected(page)).words[0]!.start - afterMove.words[0]!.start)
    .toBeCloseTo(2 / 30, 6)

  // The inspector's Start moves the first word and the clip start the same way as the start edge.
  const afterNudge = await selected(page)
  const startField = inspector.getByRole('textbox', { name: 'Start time' })
  await startField.fill(((afterNudge.start ?? 0) - 0.1).toFixed(2))
  await startField.press('Enter')
  now = await selected(page)
  expect(now.undoLabel).toBe('Adjust lyric timing')
  const shift = (now.start ?? 0) - (afterNudge.start ?? 0)
  expect(shift).toBeCloseTo(-0.1, 1)
  expect(now.words[0]!.start - afterNudge.words[0]!.start).toBeCloseTo(shift, 6)
  expect(now.clip.start - afterNudge.clip.start).toBeCloseTo(shift, 6)
  expect(now.words[1]).toEqual(afterNudge.words[1])

  // Each edit was one undo step: undoing them all brings the line back exactly.
  await page.evaluate(() => {
    const editor = window.mvStudio.app.project.editor
    while (['Adjust lyric timing', 'Move lyric line', 'Nudge lyric line'].includes(editor.undoLabel() ?? ''))
      editor.undo()
  })
  now = await selected(page)
  expect(now.words).toEqual(before.words)
  expect(now.clip).toEqual(before.clip)
})

test('Untimed lyric lines suggest timing them, and Karaoke highlight opens any timed line', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=10'
  })
  await waitForPreview(page)

  // Lyrics with lines of their own (not the sample's): pasted, then timed by an earlier run.
  await page.evaluate(() => {
    const { app } = window.mvStudio
    const editor = app.project.editor
    const p = editor.getProject()
    const lines = p.lyrics.lines.map((l: { id: string }, i: number) => ({ ...l, id: `line-${i}` }))
    editor.dispatch(app.lyrics.lyricsCommands(p, { ...p.lyrics, lines }))
  })
  const assist = page.getByRole('tabpanel', { name: 'Assist' })
  await page.evaluate(() => (window.location.hash = '#/editor?tab=assist&assist=lyrics&t=10'))
  await assist.getByRole('button', { name: 'Karaoke highlight' }).click()
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  await expect(inspector.getByText('Lyric line')).toBeVisible()
  const opened = await page.evaluate(() => {
    const id = new URLSearchParams(location.hash.split('?')[1]).get('sel')?.split(':')[1] ?? ''
    const p = window.mvStudio.app.project.editor.getProject()
    const line = p.lyrics.lines.find((l: { id: string }) => l.id === id)
    const analysis = p.analysis.audio[p.songAssetId]
    const section = analysis.sections.find(
      (s: { start: number; end: number }) => line.start >= s.start && line.start < s.end,
    )
    return { id, label: section?.label }
  })
  expect(opened.id).toMatch(/^line-/)
  expect(opened.label?.toLowerCase()).toBe('chorus')

  // Two new lines without timing yet: the Lyrics track suggests timing them.
  await page.evaluate(() => {
    const editor = window.mvStudio.app.project.editor
    const p = editor.getProject()
    const lines = [...p.lyrics.lines, { id: 'new-1', text: 'One more time', words: [] }]
    lines.push({ id: 'new-2', text: 'Into the night', words: [] })
    editor.dispatch({ type: 'lyrics.set', lyrics: { ...p.lyrics, lines } })
  })
  const suggestion = page.getByRole('note').filter({ hasText: '2 lines not timed yet' })
  await expect(suggestion).toBeVisible()
  await shot(page, 'lyrics-untimed')
  await suggestion.getByRole('button', { name: 'Time words to the vocals' }).click()
  await expect(assist.getByRole('textbox', { name: 'Lyrics' })).toHaveValue(/One more time\nInto the night$/)
  await expect(assist.getByRole('button', { name: 'Time words to the vocals' })).toBeVisible()

  // Every line timed: no suggestion.
  await page.evaluate(() => {
    const editor = window.mvStudio.app.project.editor
    const p = editor.getProject()
    const lines = p.lyrics.lines.filter((l: { id: string }) => !l.id.startsWith('new-'))
    editor.dispatch({ type: 'lyrics.set', lyrics: { ...p.lyrics, lines } })
  })
  await expect(page.getByRole('note').filter({ hasText: 'not timed yet' })).toHaveCount(0)
})
