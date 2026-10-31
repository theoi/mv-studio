import path from 'node:path'
import type { Page } from '@playwright/test'
import { FIXTURE_DIR } from './global-setup.ts'
import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

async function shot(page: Page, name: string): Promise<void> {
  await test.info().attach(name, { body: await page.screenshot(), contentType: 'image/png' })
}

/** Mean bar height (percent) of a stem's waveform in Assist › Stems. */
async function waveHeight(page: Page, stem: string): Promise<number> {
  const bars = page
    .getByRole('tabpanel', { name: 'Assist' })
    .getByText(stem, { exact: true })
    .locator('xpath=..')
    .locator('i')
  const heights = await bars.evaluateAll((els) => els.map((e) => parseFloat((e as HTMLElement).style.height)))
  return heights.reduce((a, b) => a + b, 0) / Math.max(1, heights.length)
}

test('Assist › Stems separates the imported song on this device and shows its real stems', async ({
  page,
}) => {
  test.setTimeout(360_000)
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?project=empty&kind=blank'
  })
  await expect(page.getByText('Start with a song')).toBeVisible()
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Import a song' }).click()
  await (await chooser).setFiles(path.join(FIXTURE_DIR, 'song.mp3'))
  await expect(page.getByText(/0:08 · 1[12]\d BPM/)).toBeVisible({ timeout: 30_000 })
  const undoLabel = await page.evaluate(() => window.mvStudio.app.project.editor.undoLabel())

  await page.getByRole('tab', { name: 'Assist' }).click()
  await page.getByRole('button', { name: /^Stems/ }).click()
  const panel = page.getByRole('tabpanel', { name: 'Assist' })
  // The 8 s fixture and a model this fresh profile has not downloaded yet.
  await expect(panel.getByText('Under a minute on this device')).toBeVisible()
  await expect(panel.getByText('181 MB once, then offline')).toBeVisible()
  await expect(panel.getByText('Needs about 4 GB free')).toBeVisible()
  await shot(page, 'stems-idle')

  await panel.getByRole('button', { name: 'Separate stems' }).click()
  await expect(panel.getByRole('progressbar', { name: 'Stem separation progress' })).toBeVisible()
  await expect(panel.getByText('Download the model (181 MB, once)')).toBeVisible()
  await shot(page, 'stems-running')

  await expect(panel.getByText('Ready · shown under the song track')).toBeVisible({ timeout: 300_000 })
  await expect(page.getByText('Stems are ready: vocals, drums, bass and other')).toBeVisible()
  await shot(page, 'stems-ready')
  const r = await page.evaluate(() => {
    const editor = window.mvStudio.app.project.editor
    const project = editor.getProject()
    const stems: Record<string, string> = project.analysis.audio[project.songAssetId].stems
    return {
      names: Object.keys(stems).sort(),
      origins: Object.values(stems).map((id) => project.assets[id]?.origin?.type),
      undoLabel: editor.undoLabel(),
    }
  })
  expect(r.names).toEqual(['bass', 'drums', 'other', 'vocals'])
  expect(r.origins).toEqual(['stem', 'stem', 'stem', 'stem'])
  // Stems are an analysis result: no undo step of their own.
  expect(r.undoLabel).toBe(undoLabel)
  // The stems must line up with the song sample for sample: the same start and length at 48 kHz, and their sum must
  // match the song at lag 0 (an encoder priming delay or a container pre-skip shows up here).
  const alignment = await page.evaluate(async () => {
    const { app, media } = window.mvStudio
    const project = app.project.editor.getProject()
    const song = project.assets[project.songAssetId]
    const stems = Object.values(project.analysis.audio[song.id].stems as Record<string, string>).map(
      (id) => project.assets[id],
    )
    const decode = async (asset: object) =>
      new OfflineAudioContext(2, 1, 48_000).decodeAudioData(
        await (await media.mediaStore.getFile(asset)).arrayBuffer(),
      )
    const songBuffer = await decode(song)
    const stemBuffers = await Promise.all(stems.map(decode))
    const x = songBuffer.getChannelData(0)
    const from = 2 * 48_000
    const length = 3 * 48_000
    /** The shift of `y` against the song with the largest cross-correlation, within ±2048 samples. */
    const lagOf = (y: Float32Array) => {
      let bestLag = 0
      let best = -Infinity
      for (let lag = -2048; lag <= 2048; lag++) {
        let dot = 0
        for (let i = from; i < from + length; i += 2) dot += x[i] * (y[i + lag] ?? 0)
        if (dot > best) {
          best = dot
          bestLag = lag
        }
      }
      return bestLag
    }
    const rmsDb = (y: Float32Array) => {
      let ss = 0
      for (let i = from; i < from + length; i++) ss += y[i] ** 2
      return 10 * Math.log10(ss / length + 1e-20)
    }
    const sum = new Float32Array(x.length)
    for (const b of stemBuffers) {
      const data = b.getChannelData(0)
      for (let i = 0; i < Math.min(sum.length, data.length); i++) sum[i] += data[i]
    }
    return {
      mimeTypes: stems.map((s: { mimeType: string }) => s.mimeType),
      songSeconds: songBuffer.duration,
      stemSeconds: stemBuffers.map((b) => b.duration),
      lag: lagOf(sum),
      stems: Object.keys(project.analysis.audio[song.id].stems).map((name, k) => {
        const y = stemBuffers[k].getChannelData(0)
        return { name, lag: lagOf(y), rmsDb: rmsDb(y) }
      }),
    }
  })
  console.log('stem alignment', JSON.stringify(alignment))
  for (const seconds of alignment.stemSeconds)
    expect(Math.abs(seconds - alignment.songSeconds)).toBeLessThan(1e-3)
  expect(Math.abs(alignment.lag)).toBeLessThanOrEqual(1)
  // Each stem on its own lines up with the song too. The fixture has no voice, so its vocals stem is faint leakage
  // (about -70 dBFS) whose correlation peak means nothing; it is checked only if it carries real sound.
  expect(alignment.stems.map((s: { name: string }) => s.name).sort()).toEqual([
    'bass',
    'drums',
    'other',
    'vocals',
  ])
  for (const stem of alignment.stems)
    if (stem.name !== 'vocals' || stem.rmsDb > -66)
      expect(Math.abs(stem.lag), stem.name).toBeLessThanOrEqual(1)
  // The fixture is kicks over a pad with no voice, so the drums waveform stands well above the vocals.
  expect(await waveHeight(page, 'Drums')).toBeGreaterThan((await waveHeight(page, 'Vocals')) + 20)
  // A flat waveform says why: the fixture has no voice.
  const row = (stem: string) => panel.getByText(stem, { exact: true }).locator('xpath=..')
  await expect(row('Vocals')).toContainText('Almost silent')
  await expect(row('Drums')).not.toContainText('Almost silent')
  // The timeline lists the stems under the song; the media library does not list them as clips.
  await expect(page.getByText('Vocals', { exact: true })).toHaveCount(2)
  await expect(page.getByRole('tabpanel', { name: 'Media' }).getByText(/\(vocals\)/)).toHaveCount(0)
})

test('Assist › Stems shows progress, cancels, and explains an out-of-memory failure with a retry', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    const { app, shared } = window.mvStudio
    const w = window as unknown as { failStems?: () => void; starts: number; stemDeps?: unknown }
    w.starts = 0
    app.stems.setStemsServiceForTests({
      async estimate() {
        return { downloadBytes: 180_534_758, seconds: 230, memoryBytes: 4e9, device: 'wasm' }
      },
      separateSong(_songId: string, deps: unknown) {
        w.starts++
        w.stemDeps = deps
        return shared.jobs.run({
          kind: 'analysis.stems',
          title: 'Separating stems',
          run: (ctx: { progress: (p: object) => void; signal: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              ctx.progress({
                fraction: 0.4,
                stage: 'separate',
                message: 'Separating vocals, drums, bass and other',
              })
              ctx.signal.addEventListener('abort', () =>
                reject(new shared.JobError('cancelled', 'Cancelled')),
              )
              w.failStems = () =>
                reject(
                  new shared.JobError(
                    'out-of-memory',
                    'This computer ran out of memory while separating stems.',
                    {
                      retryable: true,
                    },
                  ),
                )
            }),
        })
      },
    })
    window.location.hash = '#/editor?tab=assist&assist=stems&t=73.6'
  })
  await waitForPreview(page)
  const panel = page.getByRole('tabpanel', { name: 'Assist' })
  await expect(panel.getByText('About 4 min on this device')).toBeVisible()
  await expect(panel.getByText('181 MB once, then offline')).toBeVisible()

  await panel.getByRole('button', { name: 'Separate stems' }).click()
  await expect(panel.getByRole('progressbar', { name: 'Stem separation progress' })).toBeVisible()
  // Said once, in the progress card; the subtitle names the song instead.
  await expect(panel.getByText('Separating vocals, drums, bass and other', { exact: true })).toHaveCount(1)
  await shot(page, 'stems-running')
  await panel.getByRole('button', { name: 'Cancel' }).click()
  await expect(panel.getByRole('button', { name: 'Separate stems' })).toBeVisible()

  await panel.getByRole('button', { name: 'Separate stems' }).click()
  await expect(panel.getByRole('progressbar', { name: 'Stem separation progress' })).toBeVisible()
  await page.evaluate(() => (window as unknown as { failStems: () => void }).failStems())
  const alert = panel.getByRole('alert')
  await expect(alert).toContainText('This computer ran out of memory while separating stems.')
  await expect(alert).toContainText('Your project is unchanged. Trying again starts from the beginning.')
  await expect(panel.getByText('Close other browser tabs that play video')).toBeVisible()
  await shot(page, 'stems-failed')
  expect(
    await page.evaluate(() => {
      const project = window.mvStudio.app.project.editor.getProject()
      return project.analysis.audio[project.songAssetId]?.stems ?? null
    }),
  ).toBeNull()

  await panel.getByRole('button', { name: 'Try again' }).click()
  await expect(panel.getByRole('progressbar', { name: 'Stem separation progress' })).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { starts: number }).starts)).toBe(3)

  // The sample song is generated, not stored in the browser; stems and lyrics timing must still read it.
  const songBytes = await page.evaluate(async () => {
    type Store = { getFile: (asset: unknown) => Promise<Blob> }
    const { app } = window.mvStudio
    const project = app.project.editor.getProject()
    const song = project.assets[project.songAssetId]
    const stemDeps = (window as unknown as { stemDeps: { store: Store } }).stemDeps
    const lyricsDeps: { store: Store } = await app.lyrics.lyricsDeps()
    return [(await stemDeps.store.getFile(song)).size, (await lyricsDeps.store.getFile(song)).size]
  })
  expect(songBytes[0]).toBeGreaterThan(100_000)
  expect(songBytes[1]).toBe(songBytes[0])
})
