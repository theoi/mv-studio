import path from 'node:path'
import type { Page } from '@playwright/test'
import { FIXTURE_DIR } from './global-setup.ts'
import { expect, openHarness, test } from './fixtures.ts'

async function shot(page: Page, name: string): Promise<void> {
  await test.info().attach(name, { body: await page.screenshot(), contentType: 'image/png' })
}

interface Grid {
  bpm: number
  confidence: number
  beats: number[]
  downbeats: number[]
  undoLabel: string | null
}

async function grid(page: Page): Promise<Grid> {
  return page.evaluate(() => {
    const editor = window.mvStudio.app.project.editor
    const project = editor.getProject()
    const a = project.analysis.audio[project.songAssetId]
    return {
      bpm: a.tempo.bpm,
      confidence: a.tempo.confidence,
      beats: a.beats,
      downbeats: a.downbeats,
      undoLabel: editor.undoLabel(),
    }
  })
}

/**
 * Taps Tap tempo `count` times, `seconds` apart, timed in the page so the taps are even: pointer presses, or Space
 * key presses on the focused button.
 */
async function tapAlong(page: Page, count: number, seconds: number, via: 'pointer' | 'space'): Promise<void> {
  await page.evaluate(
    async ({ count, seconds, via }) => {
      const button = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Tap tempo')!
      button.focus()
      for (let i = 0; i < count; i++) {
        if (via === 'pointer') button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
        else button.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
        await new Promise((r) => setTimeout(r, seconds * 1000))
      }
    },
    { count, seconds, via },
  )
}

test('Assist › Song analysis taps the tempo, sets the first beat and analyzes again, each as one undo step', async ({
  page,
}) => {
  test.setTimeout(240_000)
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?project=empty&kind=blank'
  })
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Import a song' }).click()
  await (await chooser).setFiles(path.join(FIXTURE_DIR, 'song.mp3'))
  await expect(page.getByText(/0:08 · 1[12]\d BPM/)).toBeVisible({ timeout: 30_000 })
  await page.getByRole('tab', { name: 'Assist' }).click()
  await page.getByRole('button', { name: /^Song analyzed/ }).click()
  const panel = page.getByRole('tabpanel', { name: 'Assist' })
  const found = await grid(page)
  await expect(panel.getByText(`${Math.round(found.bpm)} BPM · 4/4`)).toBeVisible()
  await shot(page, 'analysis-idle')

  // Two taps are not enough yet; the count says how many are needed.
  await tapAlong(page, 2, 0.5, 'pointer')
  await expect(panel.getByText('Tapping… 2 of 4')).toBeVisible()
  await expect(panel.getByText(`${Math.round(found.bpm)} BPM · 4/4`)).toBeVisible()

  // Tapping half the tempo with Space on the focused button halves the beat level at once, without playing.
  await tapAlong(page, 5, 120 / found.bpm, 'space')
  await expect(panel.getByText(/^Tapping · \d+ BPM$/)).toBeVisible()
  await shot(page, 'analysis-tapping')
  await expect(page.getByText(`Tempo set to ${Math.round(found.bpm / 2)} BPM`)).toBeVisible()
  const halved = await grid(page)
  expect(halved.undoLabel).toBe('Set tempo')
  expect(halved.bpm).toBeCloseTo(found.bpm / 2, 0)
  expect(halved.beats.length).toBeLessThan(found.beats.length * 0.6)
  expect(await page.evaluate(() => window.mvStudio.app.ui.get().playing)).toBe(false)
  await page.getByRole('button', { name: 'Undo' }).last().click()
  await expect.poll(async () => (await grid(page)).beats.length).toBe(found.beats.length)

  // A tempo the beats do not follow at any level tracks the beats again around it, as a job.
  await tapAlong(page, 6, 0.75, 'pointer')
  await expect(page.getByText(/^Tempo set to (7[6-9]|8[0-4]) BPM$/)).toBeVisible({ timeout: 30_000 })
  const tracked = await grid(page)
  expect(tracked.undoLabel).toBe('Set tempo')
  expect(tracked.confidence).toBe(1)
  expect(tracked.bpm).toBeGreaterThan(75)
  expect(tracked.bpm).toBeLessThan(85)

  // The beat nearest the playhead becomes a bar start.
  const third = tracked.beats[2]!
  await page.evaluate((t) => window.mvStudio.app.ui.set({ playhead: t + 0.02 }), third)
  await panel.getByRole('button', { name: 'Set first beat' }).click()
  await expect(page.getByText(/^Bars now start on the beat at /)).toBeVisible()
  const moved = await grid(page)
  expect(moved.undoLabel).toBe('Set first beat')
  expect(moved.downbeats).toContain(third)
  expect(moved.beats).toEqual(tracked.beats)

  // Analyzing again replaces the corrections as one step; undo brings them back.
  await panel.getByRole('button', { name: 'Analyze again' }).click()
  await expect(panel.getByRole('progressbar', { name: 'Song analysis progress' })).toBeVisible()
  await shot(page, 'analysis-running')
  await expect(page.getByText(/^Found 1[12]\d BPM and 1 section$/)).toBeVisible({ timeout: 180_000 })
  const again = await grid(page)
  expect(again.undoLabel).toBe('Analyze again')
  expect(Math.abs(again.bpm - found.bpm)).toBeLessThan(3)
  await page.getByRole('button', { name: 'Undo' }).last().click()
  await expect.poll(async () => (await grid(page)).downbeats).toEqual(moved.downbeats)
})

/**
 * The failed and cancelled states, with a stand-in for analysis on the real job runner: a run that fails on demand
 * and a tempo job that only ends when cancelled.
 */
test('Assist › Song analysis goes back from a failed run and cancels re-tracking a tapped tempo', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    const { app, shared } = window.mvStudio
    const pending = (kind: string, title: string, fail?: string) =>
      shared.jobs.run({
        kind,
        title,
        run: (ctx: { progress: (p: object) => void; signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            ctx.progress({ fraction: 0.3, stage: 'beats', message: title })
            if (fail) setTimeout(() => reject(new shared.JobError('decode', fail)), 300)
            ctx.signal.addEventListener('abort', () => reject(new shared.JobError('cancelled', 'Cancelled')))
          }),
      })
    app.songAnalysis.setSongAnalysisServiceForTests({
      analyzeAgain: () =>
        pending('analysis.song', 'Analyzing the song', 'This audio file could not be decoded'),
      trackAtTempo: () => pending('analysis.tempo', 'Following your tempo'),
    })
    window.location.hash = '#/editor?tab=assist&assist=analysis&t=73.6'
  })
  const panel = page.getByRole('tabpanel', { name: 'Assist' })
  await expect(panel.getByText('120 BPM · 4/4')).toBeVisible()

  await panel.getByRole('button', { name: 'Analyze again' }).click()
  await expect(panel.getByRole('alert')).toContainText('This audio file could not be decoded')
  await expect(panel.getByRole('alert')).toContainText('Your project is unchanged.')
  await shot(page, 'analysis-failed')
  await panel.getByRole('button', { name: 'Back' }).click()
  await expect(panel.getByText('120 BPM · 4/4')).toBeVisible()

  // 90 BPM is no beat level of the sample's 120 BPM, so the beats are tracked again; Cancel stops it.
  await tapAlong(page, 5, 60 / 90, 'pointer')
  await expect(panel.getByText('Following your tempo… 30%')).toBeVisible()
  await panel.getByRole('button', { name: 'Cancel' }).click()
  await expect(panel.getByText('120 BPM · 4/4')).toBeVisible()
  expect(await page.evaluate(() => window.mvStudio.app.project.editor.undoLabel())).not.toBe('Set tempo')
})

/**
 * Bars come from the refinement step, which runs in the background: with a stand-in for it on the real job runner,
 * the Bar starts row says it is finding them until they are found.
 */
test('Assist › Song analysis says “Finding bars…” until the bars are found', async ({ page }) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    localStorage.setItem('mv-studio.background-analysis', 'on')
    const { app, shared } = window.mvStudio
    const w = window as unknown as { finishBars?: () => void }
    app.songAnalysis.setSongAnalysisServiceForTests({
      refine: () =>
        shared.jobs.run({
          kind: 'analysis.downbeats',
          title: 'Finding bars and refining beats',
          run: (ctx: { progress: (p: object) => void }) =>
            new Promise((resolve) => {
              ctx.progress({ fraction: 0.2, stage: 'downbeats', message: 'Finding bars and refining beats' })
              w.finishBars = () => {
                const project = app.project.editor.getProject()
                const a = project.analysis.audio[project.songAssetId]
                resolve({
                  tempo: a.tempo,
                  beats: a.beats,
                  downbeats: a.beats.filter((_: number, i: number) => i % 4 === 0),
                })
              }
            }),
        }),
      release: async () => true,
    })
    window.location.hash = '#/editor?tab=assist&assist=analysis'
  })
  const panel = page.getByRole('tabpanel', { name: 'Assist' })
  const barsRow = panel.getByText('Bar starts', { exact: true }).locator('..')
  await expect(barsRow).toContainText(/\d+ found/)
  const beats = await page.evaluate(() => {
    const project = window.mvStudio.app.project.editor.getProject()
    return project.analysis.audio[project.songAssetId].beats.length as number
  })

  // The bars no longer fit the beats (as after a tapped tempo), so the background step looks for them again.
  await page.evaluate(() => {
    const editor = window.mvStudio.app.project.editor
    const project = editor.getProject()
    editor.dispatch(
      { type: 'analysis.setGrid', assetId: project.songAssetId, grid: { downbeats: undefined } },
      { history: 'skip' },
    )
  })
  await expect(barsRow).toContainText('Finding bars…')
  await shot(page, 'analysis-finding-bars')
  await page.evaluate(() => (window as unknown as { finishBars: () => void }).finishBars())
  await expect(barsRow).toContainText(`${Math.ceil(beats / 4)} found`)
})

/** When the refinement step fails, the Bar starts row says the bars are not found yet and how to look again. */
test('Assist › Song analysis says the bars are not found yet after the refinement step fails', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    localStorage.setItem('mv-studio.background-analysis', 'on')
    const { app, shared } = window.mvStudio
    app.songAnalysis.setSongAnalysisServiceForTests({
      refine: () =>
        shared.jobs.run({
          kind: 'analysis.downbeats',
          title: 'Finding bars and refining beats',
          run: () => Promise.reject(new shared.JobError('network', 'The model could not be downloaded.')),
        }),
      release: async () => true,
    })
    window.location.hash = '#/editor?tab=assist&assist=analysis'
  })
  const panel = page.getByRole('tabpanel', { name: 'Assist' })
  const barsRow = panel.getByText('Bar starts', { exact: true }).locator('..')
  await expect(barsRow).toContainText(/\d+ found/)
  await page.evaluate(() => {
    const editor = window.mvStudio.app.project.editor
    const project = editor.getProject()
    editor.dispatch(
      { type: 'analysis.setGrid', assetId: project.songAssetId, grid: { downbeats: undefined } },
      { history: 'skip' },
    )
  })
  await expect(barsRow).toContainText('Not found yet')
  await expect(panel.getByText('Bars not found yet. Analyze again to look for them.')).toBeVisible()
  await expect(page.getByText(/^Bars not found yet\. The model could not be downloaded\./)).toBeVisible()
  await shot(page, 'analysis-bars-not-found')
})
