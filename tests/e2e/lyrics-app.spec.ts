import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

/**
 * Assist › Lyrics with a stand-in for the models (stem separation and the aligner download about 280 MB): the
 * stand-in reports progress on the shared job runner and returns timed lines like the real service.
 */
test('lyrics are timed as one job and land on the Lyrics track as one undo step', async ({ page }) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    const { app, shared } = window.mvStudio
    const w = window as unknown as { finishLyrics?: (fail?: string) => void }
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
      run(songId: string, request: { text: string }) {
        return shared.jobs.run({
          kind: 'analysis.lyrics',
          title: 'Timing lyrics',
          run: (ctx: { progress: (p: object) => void }) =>
            new Promise((resolve, reject) => {
              ctx.progress({ fraction: 0.4, stage: 'align', message: 'Timing words' })
              w.finishLyrics = (fail?: string) => {
                if (fail) {
                  reject(new shared.JobError('model-load', fail))
                  return
                }
                const lines = request.text.split('\n').map((text: string, i: number) => ({
                  id: `timed-${i}`,
                  text,
                  start: 64 + i * 4,
                  end: 67 + i * 4,
                  words: [],
                }))
                resolve({ doc: { audioAssetId: songId, source: 'pasted', lines }, chorus: null })
              }
            }),
        })
      },
    })
    window.location.hash = '#/editor?tab=assist&assist=lyrics&t=73.6'
  })
  await waitForPreview(page)

  // One line says what pressing the button will do.
  await expect(
    page.getByText('Separates the vocals first · 276 MB download, once · about 4 min on this device'),
  ).toBeVisible()
  await page
    .getByRole('textbox', { name: 'Lyrics' })
    .fill('Neon lights are calling\nWe run until the morning')
  await page.getByRole('button', { name: 'Time words to the vocals' }).click()
  await expect(page.getByRole('progressbar', { name: 'Lyrics progress' })).toBeVisible()
  await page.evaluate(() => (window as unknown as { finishLyrics: () => void }).finishLyrics())

  await expect(page.getByText('Timed 2 lines to the vocals')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Lyric: Neon lights are calling' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Lyric: We run until the morning' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Lyric: Under the neon skyline/ })).toHaveCount(0)
  expect(await page.evaluate(() => window.mvStudio.app.project.editor.undoLabel())).toBe('Time lyrics')

  // A failed run leaves the lyrics as they were and offers to try again.
  await page.getByRole('button', { name: 'Time words to the vocals' }).click()
  // finishLyrics belongs to the latest run only once that run has started.
  await expect(page.getByRole('progressbar', { name: 'Lyrics progress' })).toBeVisible()
  await page.evaluate(() =>
    (window as unknown as { finishLyrics: (fail: string) => void }).finishLyrics(
      'The timing model could not be downloaded',
    ),
  )
  await expect(page.getByRole('alert')).toContainText('The timing model could not be downloaded')
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Lyric: Neon lights are calling' })).toBeVisible()

  // Going back keeps what was pasted.
  await page.getByRole('button', { name: 'Edit lyrics' }).click()
  await expect(page.getByRole('textbox', { name: 'Lyrics' })).toHaveValue(
    'Neon lights are calling\nWe run until the morning',
  )
})

test('timing waits while stems are being separated, so two separations never run at once', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    const { app, shared } = window.mvStudio
    const w = window as unknown as { finishStems?: () => void }
    app.lyrics.setLyricsServiceForTests({
      async estimate() {
        return { separatesStems: true, downloads: [], downloadBytes: 0, seconds: 230 }
      },
      run() {
        throw new Error('unused')
      },
    })
    shared.jobs.run({
      kind: 'analysis.stems',
      title: 'Separating stems',
      run: () =>
        new Promise<void>((resolve) => {
          w.finishStems = resolve
        }),
    })
    window.location.hash = '#/editor?tab=assist&assist=lyrics&t=73.6'
  })
  await waitForPreview(page)
  await page.getByRole('textbox', { name: 'Lyrics' }).fill('Neon lights are calling')
  const time = page.getByRole('button', { name: 'Time words to the vocals' })
  await expect(time).toBeDisabled()
  await expect(page.getByText('Waiting for the stems to finish…')).toBeVisible()

  await page.evaluate(() => (window as unknown as { finishStems: () => void }).finishStems())
  await expect(time).toBeEnabled()
  await expect(page.getByText('Separates the vocals first · about 4 min on this device')).toBeVisible()
})
