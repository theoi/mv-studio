import path from 'node:path'
import { FIXTURE_DIR } from './global-setup.ts'
import { expect, openHarness, test } from './fixtures.ts'
import type { Page } from '@playwright/test'

/** A mono 16-bit WAV of digital silence. */
function silentWav(seconds: number, rate = 22050): Buffer {
  const bytes = seconds * rate * 2
  const b = Buffer.alloc(44 + bytes)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + bytes, 4)
  b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate * 2, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36)
  b.writeUInt32LE(bytes, 40)
  return b
}

async function openBlank(page: Page) {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?project=empty&kind=blank'
  })
  await expect(page.getByText('Start with a song')).toBeVisible()
}

async function importSong(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }) {
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Import a song' }).click()
  await (await chooser).setFiles(file)
}

test('a silent song says no beat was found, and the toolbar shows no tempo', async ({ page }) => {
  await openBlank(page)
  await importSong(page, { name: 'silence.wav', mimeType: 'audio/wav', buffer: silentWav(10) })
  await expect(page.getByText(/^No beat found\. The song has \d+ sections?\.$/)).toBeVisible({
    timeout: 30_000,
  })
  // Counted once while the toast shows, so a toast naming a tempo cannot pass by fading out first.
  expect(await page.getByText(/\d+ BPM/).count()).toBe(0)
  await expect(page.getByTestId('song-facts')).toHaveText('No beat found')
  await page.getByRole('tab', { name: 'Assist' }).click()
  const assist = page.getByRole('tabpanel', { name: 'Assist' })
  await expect(assist.getByText('Song analyzed')).toBeVisible()
  await assist.getByRole('button', { name: /^Song analyzed/ }).click()
  await expect(assist.getByText('No beat found', { exact: true })).toBeVisible()
  await expect(assist.getByRole('button', { name: /^(Half|Double) tempo/ })).toHaveCount(0)
})

test('a cancelled analysis says the song is not analyzed yet, with Analyze, everywhere', async ({ page }) => {
  await openBlank(page)
  await page.evaluate(() => {
    const { app, shared } = window.mvStudio
    const beats = Array.from({ length: 16 }, (_, i) => i * 0.5)
    app.songAnalysis.setSongAnalysisServiceForTests({
      analyze: () =>
        shared.jobs.run({
          kind: 'analysis.song',
          title: 'Analyzing the song',
          run: (ctx: { signal: AbortSignal }) =>
            new Promise((_resolve, reject) =>
              ctx.signal.addEventListener('abort', () =>
                reject(new shared.JobError('cancelled', 'Cancelled')),
              ),
            ),
        }),
      analyzeAgain: (songId: string) =>
        shared.jobs.run({
          kind: 'analysis.song',
          title: 'Analyzing the song',
          run: async () => ({
            assetId: songId,
            version: 'test',
            tempo: { bpm: 120, confidence: 0.9 },
            beats,
            sections: [{ id: 's1', start: 0, end: 8, label: 'verse', repeatGroup: 0 }],
          }),
        }),
    } as never)
  })
  await importSong(page, path.join(FIXTURE_DIR, 'song.mp3'))
  const card = page.locator('[class*="songRow"]')
  await expect(card.getByText('Finding beats and sections…')).toBeVisible()
  await page.getByRole('tab', { name: 'Assist' }).click()
  const assist = page.getByRole('tabpanel', { name: 'Assist' })
  await assist.getByRole('button', { name: /^Analyzing the song…/ }).click()
  await assist.getByRole('button', { name: 'Cancel' }).click()

  await expect(assist.getByText('Not analyzed yet')).toBeVisible()
  await expect(assist.getByText('Not found')).toHaveCount(0)
  await expect(card.getByText('Not analyzed yet')).toBeVisible()
  await expect(card.getByText('Finding beats and sections…')).toHaveCount(0)
  await page.getByRole('tab', { name: 'Inspector' }).click()
  await expect(page.getByTestId('song-facts')).toHaveText('Not analyzed yet')

  await card.getByRole('button', { name: 'Analyze' }).click()
  await expect(card.getByText(/0:08 · 120 BPM · 1 section/)).toBeVisible()
  await expect(page.getByTestId('song-facts')).toHaveText('120 BPM · 4/4 · 1 section')
  await page.getByRole('tab', { name: 'Assist' }).click()
  await expect(assist.getByText('120 BPM · 4/4')).toBeVisible()
})

test('the song map energy stops where a short song ends', async ({ page }) => {
  await openBlank(page)
  await importSong(page, path.join(FIXTURE_DIR, 'song.mp3'))
  await expect(page.getByText(/0:08 · 1[12]\d BPM/)).toBeVisible({ timeout: 30_000 })
  await page.evaluate(() => {
    const { model, app } = window.mvStudio
    const track = model.createTrack('visual', 'Words')
    const clip = model.createTextClip({ trackId: track.id, text: 'Long', start: 0, duration: 24 })
    app.project.editor.dispatch(
      [
        { type: 'track.add', track },
        { type: 'clip.add', clip },
      ],
      { label: 'Add text' },
    )
  })
  // Painted alpha left and right of the song's end, in the energy layer's canvas.
  const alpha = () =>
    page.evaluate(() => {
      const { app } = window.mvStudio
      const p = app.project.editor.getProject()
      const end = p.assets[p.songAssetId as string]?.duration ?? 0
      const canvas = document.querySelector<HTMLCanvasElement>('[class*="energyLayer"] canvas')
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) return null
      const dpr = canvas.width / canvas.getBoundingClientRect().width
      const x = Math.round(end * app.ui.get().pxPerSec * dpr)
      const sum = (a: number, b: number) => {
        const { data } = ctx.getImageData(a, 0, b - a, canvas.height)
        let s = 0
        for (let i = 3; i < data.length; i += 4) s += data[i] as number
        return s
      }
      return { inside: sum(0, x), after: sum(x + Math.ceil(2 * dpr), canvas.width), width: canvas.width, x }
    })
  await expect.poll(async () => (await alpha())?.inside ?? 0).toBeGreaterThan(0)
  const a = await alpha()
  expect(a!.x).toBeLessThan(a!.width / 2)
  expect(a!.after).toBe(0)
})
