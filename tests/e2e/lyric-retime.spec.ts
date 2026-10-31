import type { Page } from '@playwright/test'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

interface Line {
  id: string
  text: string
  start?: number
  end?: number
  words: { text: string; start: number; end: number }[]
}

async function shot(page: Page, name: string): Promise<void> {
  await test.info().attach(name, { body: await page.screenshot(), contentType: 'image/png' })
}

/** The selected lyric line and the start of its clip on the timeline. */
async function selected(page: Page): Promise<{ line: Line; clipStart: number; undoLabel: string | null }> {
  return page.evaluate(() => {
    const id = new URLSearchParams(location.hash.split('?')[1]).get('sel')?.split(':')[1] ?? ''
    const editor = window.mvStudio.app.project.editor
    const project = editor.getProject()
    const line = project.lyrics.lines.find((l: Line) => l.id === id)
    const clip = Object.values(project.clips as Record<string, { lyricLineId?: string; start: number }>).find(
      (c) => c.lyricLineId === id,
    )
    return { line, clipStart: clip?.start ?? NaN, undoLabel: editor.undoLabel() }
  })
}

/**
 * Inspector › Lyric line › Re-time line with a stand-in for the aligner (listening to the vocals needs about 280 MB of
 * models and a sung song). The stand-in reports progress on the real job runner and fits the line's current text into
 * the time after where the line starts, the way the real aligner returns a re-timed copy of the lyrics.
 */
test('Re-time line listens to the vocals once, then re-times the line as one undo step', async ({ page }) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    const { app, shared } = window.mvStudio
    const w = window as unknown as {
      listened: boolean
      listens: number
      finishListening?: (fail?: string) => void
    }
    w.listened = false
    w.listens = 0
    app.lyrics.setLyricsServiceForTests({
      async estimate() {
        return {
          separatesStems: true,
          downloads: [
            { name: 'HTDemucs stem separator', bytes: 180_534_758 },
            { name: 'wav2vec2 lyrics aligner', bytes: 95_286_404 },
          ],
          downloadBytes: 275_821_162,
          seconds: 230,
        }
      },
      canRealign: () => w.listened,
      prepareRealign() {
        w.listens++
        return shared.jobs.run({
          kind: 'analysis.realign',
          title: 'Listening to the vocals',
          run: (ctx: { progress: (p: object) => void; signal: AbortSignal }) =>
            new Promise((resolve, reject) => {
              ctx.progress({ fraction: 0.3, stage: 'separate', message: 'Separating the vocals' })
              ctx.signal.addEventListener('abort', () =>
                reject(new shared.JobError('cancelled', 'Cancelled')),
              )
              w.finishListening = (fail?: string) => {
                if (fail) {
                  reject(new shared.JobError('model-load', fail))
                  return
                }
                w.listened = true
                resolve(undefined)
              }
            }),
        })
      },
      realignLine(doc: { lines: Line[] }, index: number) {
        const lines = doc.lines.map((l, i) => {
          if (i !== index) return l
          const start = (l.start ?? 0) + 0.5
          const words = l.text
            .split(/\s+/)
            .filter(Boolean)
            .map((text, k) => ({ text, start: start + k * 0.25, end: start + (k + 1) * 0.25 }))
          return { ...l, start, end: words.at(-1)?.end, words }
        })
        return { ...doc, lines }
      },
    })
    window.location.hash = '#/editor?t=73.6'
  })
  await waitForPreview(page)
  await page
    .getByRole('button', { name: /^Lyric: / })
    .first()
    .dispatchEvent('pointerdown')
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  await expect(inspector.getByText('Lyric line')).toBeVisible()
  const before = await selected(page)
  await expect(inspector.getByText(`${before.line.words.length} words timed to vocals`)).toBeVisible()
  // Nothing has listened to the vocals in this session, so the first re-time says what it costs.
  await expect(
    inspector.getByText(
      'Re-timing separates the vocals first · 276 MB download, once · about 4 min on this device',
    ),
  ).toBeVisible()
  await shot(page, 'retime-idle')

  // A corrected line no longer matches its timed words.
  const text = `${before.line.text} tonight`
  await inspector.getByRole('textbox', { name: 'Lyric text' }).fill(text)
  await inspector.getByRole('textbox', { name: 'Lyric text' }).blur()
  await expect(inspector.getByText('Text changed since timing')).toBeVisible()

  // Listening can be cancelled; the lyrics stay as they were.
  await inspector.getByRole('button', { name: 'Re-time line' }).click()
  await expect(inspector.getByText('Listening to the vocals… 30%')).toBeVisible()
  await shot(page, 'retime-listening')
  await inspector.getByRole('button', { name: 'Cancel' }).click()
  await expect(inspector.getByRole('button', { name: 'Re-time line' })).toBeVisible()
  expect((await selected(page)).line.start).toBe(before.line.start)

  // A failed listen says why and changes nothing.
  await inspector.getByRole('button', { name: 'Re-time line' }).click()
  await expect(inspector.getByText('Listening to the vocals… 30%')).toBeVisible()
  await page.evaluate(() =>
    (window as unknown as { finishListening: (fail: string) => void }).finishListening(
      'The timing model could not be downloaded',
    ),
  )
  await expect(inspector.getByRole('alert')).toContainText('The timing model could not be downloaded')
  await expect(inspector.getByRole('alert')).toContainText('Your lyrics are unchanged.')
  await shot(page, 'retime-failed')
  expect((await selected(page)).line.start).toBe(before.line.start)

  // Listening then re-times the line: lyrics and its clip move together, as one undo step.
  await inspector.getByRole('button', { name: 'Re-time line' }).click()
  await expect(inspector.getByText('Listening to the vocals… 30%')).toBeVisible()
  await page.evaluate(() => (window as unknown as { finishListening: () => void }).finishListening())
  await expect(page.getByText('Line re-timed to the vocals')).toBeVisible()
  const after = await selected(page)
  expect(after.undoLabel).toBe('Re-time line')
  expect(after.line.text).toBe(text)
  expect(after.line.words.map((w) => w.text).join(' ')).toBe(text)
  expect(after.line.start).toBeCloseTo((before.line.start ?? 0) + 0.5, 6)
  expect(after.clipStart - before.clipStart).toBeCloseTo(0.5, 2)
  const count = text.split(' ').length
  await expect(inspector.getByText(`${count} words timed to vocals`)).toBeVisible()
  await expect(inspector.getByText(/^Re-timing /)).toHaveCount(0)
  await shot(page, 'retime-done')

  // Once listened, the next re-time runs at once, without another job.
  await inspector.getByRole('button', { name: 'Re-time line' }).click()
  await expect
    .poll(async () => (await selected(page)).line.start)
    .toBeCloseTo((before.line.start ?? 0) + 1, 6)
  expect(await page.evaluate(() => (window as unknown as { listens: number }).listens)).toBe(3)

  // Undo from the toast puts the previous timing back.
  await page.getByRole('button', { name: 'Undo' }).last().click()
  await expect
    .poll(async () => (await selected(page)).line.start)
    .toBeCloseTo((before.line.start ?? 0) + 0.5, 6)
})
