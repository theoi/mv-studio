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

  // Analyzing again replaces the corrections as one step but keeps the section the user named; undo brings the
  // corrections back.
  const labels = () =>
    page.evaluate(() => {
      const project = window.mvStudio.app.project.editor.getProject()
      return (project.analysis.audio[project.songAssetId ?? '']?.sections ?? []).map(
        (s: { label: string }) => s.label,
      )
    })
  // Named on the song map, as a user would: renaming is what marks a section as the user's.
  await page.getByRole('button', { name: /^Section .*, 0:00 to / }).dblclick()
  await page.getByRole('textbox', { name: 'Rename section' }).fill('Hook')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: /^Section Hook, 0:00 to / })).toBeVisible()
  expect(await labels()).toEqual(['Hook'])
  // Selecting the section opened the Inspector.
  await page.getByRole('tab', { name: 'Assist' }).click()
  await panel.getByRole('button', { name: 'Analyze again' }).click()
  await expect(panel.getByRole('progressbar', { name: 'Song analysis progress' })).toBeVisible()
  await shot(page, 'analysis-running')
  await expect(page.getByText(/^Found 1[12]\d BPM and 1 section\. Kept 1 section you named\.$/)).toBeVisible({
    timeout: 180_000,
  })
  const again = await grid(page)
  expect(again.undoLabel).toBe('Analyze again')
  expect(Math.abs(again.bpm - found.bpm)).toBeLessThan(3)
  expect(await labels()).toEqual(['Hook'])
  await page.getByRole('button', { name: 'Undo' }).last().click()
  await expect.poll(async () => (await grid(page)).downbeats).toEqual(moved.downbeats)
})

/**
 * Half and Double next to the tempo change the beat level in one click, each as one undo step. Found bars stay bars of
 * four: doubling adds a bar start halfway through each bar, Half right after Double brings back the bars found before,
 * and halving otherwise leaves none until the user sets the first beat, which the toast says.
 */
test('Assist › Song analysis halves and doubles the tempo, keeping bars of four', async ({ page }) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?tab=assist&assist=analysis'
  })
  const panel = page.getByRole('tabpanel', { name: 'Assist' })
  const barsRow = panel.getByText('Bar starts', { exact: true }).locator('..')
  await expect(panel.getByText('120 BPM · 4/4')).toBeVisible()
  const found = await grid(page)
  expect(found.downbeats.length).toBeGreaterThan(4)
  const half = panel.getByRole('button', { name: 'Half tempo, 60 BPM' })
  const double = panel.getByRole('button', { name: 'Double tempo, 240 BPM' })
  await double.hover()
  await expect(page.getByRole('tooltip')).toContainText(
    'For a beat felt twice as fast: adds a beat between every two beats (240 BPM)',
  )
  await shot(page, 'analysis-tempo-level')

  await double.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByText('Tempo set to 240 BPM')).toBeVisible()
  await expect(panel.getByText('240 BPM · 4/4')).toBeVisible()
  const doubled = await grid(page)
  expect(doubled.undoLabel).toBe('Double tempo')
  expect(doubled.confidence).toBe(1)
  expect(doubled.beats.length).toBe(found.beats.length * 2 - 1)
  // Every found bar start is still one, and one more starts halfway through each bar.
  for (const d of found.downbeats) expect(doubled.downbeats).toContain(d)
  const index = new Map(doubled.beats.map((t, i) => [t, i]))
  const gaps = doubled.downbeats.slice(1).map((d, i) => index.get(d)! - index.get(doubled.downbeats[i]!)!)
  expect(new Set(gaps)).toEqual(new Set([4]))
  await expect(barsRow).toContainText(`${doubled.downbeats.length} found`)
  // 480 BPM is no beat a listener could tap. The pressed button keeps keyboard focus, and its tooltip says why it is off.
  const tooFast = panel.getByRole('button', { name: 'Double tempo, 480 BPM' })
  await expect(tooFast).toBeDisabled()
  await expect(tooFast).toBeFocused()
  await page.mouse.move(0, 0)
  await tooFast.hover()
  await expect(
    page
      .getByRole('tooltip')
      .filter({ hasText: '480 BPM is too fast to be the beat. Tempos go up to 300 BPM.' }),
  ).toBeVisible()
  await shot(page, 'analysis-double-off-tooltip')
  await page.getByRole('button', { name: 'Undo' }).last().click()
  await expect(panel.getByText('120 BPM · 4/4')).toBeVisible()
  expect((await grid(page)).downbeats).toEqual(found.downbeats)

  // Half instead of Undo after Double gives back the same beats, and the bars found before.
  await double.click()
  await panel.getByRole('button', { name: 'Half tempo, 120 BPM' }).click()
  await expect(page.getByText('Tempo set to 120 BPM', { exact: true })).toBeVisible()
  await expect(panel.getByText('120 BPM · 4/4')).toBeVisible()
  const back = await grid(page)
  expect(back.undoLabel).toBe('Half tempo')
  expect(back.beats).toEqual(found.beats)
  expect(back.downbeats).toEqual(found.downbeats)

  await half.click()
  await expect(
    page.getByText('Tempo set to 60 BPM. Bars cleared: use Set first beat to start them again.', {
      exact: true,
    }),
  ).toBeVisible()
  const halved = await grid(page)
  expect(halved.undoLabel).toBe('Half tempo')
  expect(halved.beats.length).toBeLessThan(found.beats.length * 0.6)
  expect(halved.downbeats ?? []).toEqual([])
  await expect(barsRow).toContainText('Not found yet')
  await expect(
    panel.getByText(
      'Bars not found yet at this tempo. Set first beat to start them on the beat at the playhead.',
    ),
  ).toBeVisible()
  await shot(page, 'analysis-half-tempo')
  await panel.getByRole('button', { name: 'Set first beat' }).click()
  await expect(barsRow).toContainText(/\d+ found/)
  await page.getByRole('button', { name: 'Undo' }).last().click()
  await page.getByRole('button', { name: 'Undo' }).last().click()
  await expect(panel.getByText('120 BPM · 4/4')).toBeVisible()
  expect((await grid(page)).downbeats).toEqual(found.downbeats)

  // In the narrowest panel (1280×720) the value stays on one line, and Half and Double move under it if need be.
  await page.setViewportSize({ width: 1280, height: 720 })
  const value = await panel.getByText('120 BPM · 4/4', { exact: true }).boundingBox()
  const label = await panel.getByText('Tempo', { exact: true }).boundingBox()
  expect(value!.height).toBeLessThan(label!.height * 1.5)
  const edge = await panel.boundingBox()
  const right = await double.boundingBox()
  expect(right!.x + right!.width).toBeLessThanOrEqual(edge!.x + edge!.width)
  await shot(page, 'analysis-tempo-level-1280')
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
 * A section whose name came from the analysis but whose color the user picked is theirs too: with a stand-in for
 * analysis on the real job runner, Analyze again cuts the new sections around it and says it kept a section you
 * edited.
 */
test('Analyze again keeps a section whose color the user picked', async ({ page }) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    const { app, shared } = window.mvStudio
    const beats = Array.from({ length: 16 }, (_, i) => i * 0.5)
    const found = (assetId: string, sections: object[]) =>
      shared.jobs.run({
        kind: 'analysis.song',
        title: 'Analyzing the song',
        run: async () => ({
          assetId,
          version: 'test',
          tempo: { bpm: 120, confidence: 0.9 },
          beats,
          sections,
        }),
      })
    app.songAnalysis.setSongAnalysisServiceForTests({
      analyze: (songId: string) =>
        found(songId, [
          { id: 'a', start: 0, end: 4, label: 'verse', repeatGroup: 0, confidence: 0.4 },
          { id: 'b', start: 4, end: 8, label: 'chorus', repeatGroup: 1, confidence: 0.4 },
        ]),
      analyzeAgain: (songId: string) =>
        found(songId, [{ id: 'n', start: 0, end: 8, label: 'verse', repeatGroup: 0, confidence: 0.4 }]),
      refine: () =>
        shared.jobs.run({
          kind: 'analysis.downbeats',
          title: 'Finding bars and refining beats',
          run: () => Promise.reject(new shared.JobError('cancelled', 'Cancelled')),
        }),
      release: async () => true,
    } as never)
    window.location.hash = '#/editor?project=empty&kind=blank'
  })
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Import a song' }).click()
  await (await chooser).setFiles(path.join(FIXTURE_DIR, 'song.mp3'))
  const chorus = page.getByRole('button', { name: /^Section chorus, 0:04 to 0:08/i })
  await expect(chorus).toBeVisible({ timeout: 30_000 })
  const sections = () =>
    page.evaluate(() => {
      const project = window.mvStudio.app.project.editor.getProject()
      return (project.analysis.audio[project.songAssetId].sections as { id: string; color?: string }[]).map(
        ({ id, color }) => [id, color ?? null],
      )
    })

  // A mouse pointerdown: one without a pointer type counts as touch, whose long press opens the section menu.
  await chorus.dispatchEvent('pointerdown', { pointerType: 'mouse', button: 0, isPrimary: true })
  await page.getByRole('radio', { name: 'Bridge color' }).click()
  await expect(chorus).toHaveAttribute('style', /--sec: var\(--section-bridge\)/)

  await page.getByRole('tab', { name: 'Assist' }).click()
  const panel = page.getByRole('tabpanel', { name: 'Assist' })
  await panel.getByRole('button', { name: /^Song analyzed/ }).click()
  await panel.getByRole('button', { name: 'Analyze again' }).click()
  await expect(page.getByText('Found 120 BPM and 2 sections. Kept 1 section you edited.')).toBeVisible()
  expect(await sections()).toEqual([
    ['n', null],
    ['b', 'bridge'],
  ])
  await expect(chorus).toHaveAttribute('style', /--sec: var\(--section-bridge\)/)
  await shot(page, 'analysis-kept-edited-section')
})

/**
 * While the song is analyzed, Song analysis says it is finding each fact instead of "None found", and offers only
 * Cancel: Tap tempo, Set first beat, Analyze again and Half/Double come back with the result. With a stand-in for
 * analysis on the real job runner that stays at 0% until the test finishes it.
 */
test('Assist › Song analysis shows a running state with only Cancel while the song is analyzed', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    const { app, shared } = window.mvStudio
    const w = window as unknown as { finishAnalysis?: () => void }
    const beats = Array.from({ length: 16 }, (_, i) => i * 0.5)
    const pending = (assetId: string) =>
      shared.jobs.run({
        kind: 'analysis.song',
        title: 'Analyzing the song',
        run: (ctx: { signal: AbortSignal }) =>
          new Promise((resolve, reject) => {
            w.finishAnalysis = () =>
              resolve({
                assetId,
                version: 'test',
                tempo: { bpm: 120, confidence: 0.9 },
                beats,
                downbeats: beats.filter((_, i) => i % 4 === 0),
                sections: [{ id: 's1', start: 0, end: 8, label: 'verse', repeatGroup: 0, confidence: 0.4 }],
              })
            ctx.signal.addEventListener('abort', () => reject(new shared.JobError('cancelled', 'Cancelled')))
          }),
      })
    app.songAnalysis.setSongAnalysisServiceForTests({
      analyze: pending,
      analyzeAgain: pending,
      refine: () =>
        shared.jobs.run({
          kind: 'analysis.downbeats',
          title: 'Finding bars and refining beats',
          run: () => Promise.reject(new shared.JobError('cancelled', 'Cancelled')),
        }),
      release: async () => true,
    } as never)
    window.location.hash = '#/editor?project=empty&kind=blank'
  })
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Import a song' }).click()
  await (await chooser).setFiles(path.join(FIXTURE_DIR, 'song.mp3'))
  await page.getByRole('tab', { name: 'Assist' }).click()
  const panel = page.getByRole('tabpanel', { name: 'Assist' })
  await panel.getByRole('button', { name: /^Analyzing the song…/ }).click()
  const row = (label: string) => panel.getByText(label, { exact: true }).locator('..')
  const actions = [
    panel.getByRole('button', { name: 'Tap tempo' }),
    panel.getByRole('button', { name: 'Set first beat' }),
    panel.getByRole('button', { name: 'Analyze again' }),
  ]
  const levels = panel.getByRole('button', { name: /^(Half|Double) tempo/ })

  await expect(panel.getByRole('progressbar', { name: 'Song analysis progress' })).toBeVisible()
  for (const label of ['Tempo', 'Beats', 'Bar starts', 'Sections', 'Energy curve'])
    await expect(row(label)).toHaveText(`${label}Finding…`)
  await expect(panel.getByText('None found')).toHaveCount(0)
  for (const action of actions) await expect(action).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Cancel' })).toBeVisible()
  await shot(page, 'analysis-first-run')

  await page.evaluate(() => (window as unknown as { finishAnalysis: () => void }).finishAnalysis())
  await expect(row('Tempo')).toContainText('120 BPM · 4/4')
  await expect(row('Beats')).toHaveText('Beats16 found')
  await expect(row('Bar starts')).toHaveText('Bar starts4 found')
  await expect(row('Sections')).toHaveText('Sections1')
  for (const action of actions) await expect(action).toBeEnabled()
  await expect(levels).toHaveCount(2)
  await expect(panel.getByRole('button', { name: 'Cancel' })).toHaveCount(0)
  // The actions in the row look alike: Tap tempo is no outlined button among borderless ones.
  const look = (i: number) =>
    actions[i]!.evaluate((el) => {
      const s = getComputedStyle(el)
      return [s.borderTopColor, s.backgroundColor]
    })
  expect(await look(0)).toEqual(await look(2))
  await shot(page, 'analysis-found')

  // Analyzing again keeps the facts found so far until the new ones arrive, with only Cancel.
  await actions[2]!.click()
  await expect(panel.getByRole('progressbar', { name: 'Song analysis progress' })).toBeVisible()
  await expect(row('Beats')).toHaveText('Beats16 found')
  for (const action of actions) await expect(action).toHaveCount(0)
  await expect(levels).toHaveCount(0)
  await shot(page, 'analysis-running-again')
  await panel.getByRole('button', { name: 'Cancel' }).click()
  await expect(row('Tempo')).toContainText('120 BPM · 4/4')
  for (const action of actions) await expect(action).toBeEnabled()
  await expect(levels).toHaveCount(2)
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

/**
 * The preview's position readout counts bars only from bars that were found: while they are being found it shows the
 * section alone and says why, then counts from the found bars (here starting on the second beat).
 */
test('the preview’s position readout counts bars only once they are found', async ({ page }) => {
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
          run: () =>
            new Promise((resolve) => {
              w.finishBars = () => {
                const project = app.project.editor.getProject()
                const a = project.analysis.audio[project.songAssetId]
                resolve({
                  tempo: a.tempo,
                  beats: a.beats,
                  downbeats: a.beats.filter((_: number, i: number) => i % 4 === 1),
                })
              }
            }),
        }),
      release: async () => true,
    })
    window.location.hash = '#/editor?t=73.6'
  })
  const readout = page.locator('span[class*="posSection"]').locator('..')
  const tooltip = async () => {
    await page.mouse.move(0, 0)
    await readout.hover()
    return page.getByRole('tooltip')
  }
  await expect(readout).toContainText(/Bar \d+/)
  const beats = await page.evaluate(() => {
    const project = window.mvStudio.app.project.editor.getProject()
    return project.analysis.audio[project.songAssetId].beats as number[]
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
  await expect(readout).not.toContainText('Bar')
  await expect(await tooltip()).toContainText('Finding bars…')
  await shot(page, 'position-finding-bars')

  await page.evaluate(() => (window as unknown as { finishBars: () => void }).finishBars())
  const k = beats.filter((b) => b <= 73.6).length - 2
  await expect(readout).toContainText(`Bar ${Math.floor(k / 4) + 1}`)
  await expect(await tooltip()).toContainText(`Bar ${Math.floor(k / 4) + 1}, beat ${(k % 4) + 1}`)
  await shot(page, 'position-bars-found')
})
