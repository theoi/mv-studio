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

/** Clicks Tap tempo `count` times, `seconds` apart, timed in the page so the taps are even. */
async function tapAlong(page: Page, count: number, seconds: number): Promise<void> {
  await page.evaluate(
    async ({ count, seconds }) => {
      const button = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Tap tempo')!
      for (let i = 0; i < count; i++) {
        button.click()
        await new Promise((r) => setTimeout(r, seconds * 1000))
      }
    },
    { count, seconds },
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

  // Tapping half the tempo halves the beat level at once.
  await tapAlong(page, 5, 120 / found.bpm)
  await expect(panel.getByText(/^Tapping · \d+ BPM$/)).toBeVisible()
  await shot(page, 'analysis-tapping')
  await expect(page.getByText(`Tempo set to ${Math.round(found.bpm / 2)} BPM`)).toBeVisible()
  const halved = await grid(page)
  expect(halved.undoLabel).toBe('Set tempo')
  expect(halved.bpm).toBeCloseTo(found.bpm / 2, 0)
  expect(halved.beats.length).toBeLessThan(found.beats.length * 0.6)
  await page.getByRole('button', { name: 'Undo' }).last().click()
  await expect.poll(async () => (await grid(page)).beats.length).toBe(found.beats.length)

  // A tempo the beats do not follow at any level tracks the beats again around it, as a job.
  await tapAlong(page, 6, 0.75)
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
