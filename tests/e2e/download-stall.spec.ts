import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

const ALIGNER_LINE = /^Downloading the lyrics aligner \(95 MB, once\)/

test('a model download that gets no response shows its line at once and, after 30 s, says it is not arriving', async ({
  page,
  context,
}) => {
  test.setTimeout(150_000)
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?tab=assist&assist=lyrics&t=73.6'
  })
  await waitForPreview(page)
  // The song is its own vocals stem, so timing goes straight to the aligner, as with stems separated earlier.
  await page.evaluate(() => {
    const { editor } = window.mvStudio.app.project
    const songId = editor.getProject().songAssetId
    editor.dispatch(
      { type: 'analysis.setStems', assetId: songId, stems: { vocals: songId }, stemFeatures: {} },
      { history: 'skip' },
    )
  })
  // Requests to Hugging Face get no response at all, as behind a stalled proxy.
  await context.route('https://huggingface.co/**', () => undefined)

  const assist = page.getByRole('tabpanel', { name: 'Assist' })
  await assist.getByRole('textbox', { name: 'Lyrics' }).fill('Neon lights are calling')
  await assist.getByRole('button', { name: 'Time words to the vocals' }).click()
  await expect(assist.getByText(ALIGNER_LINE)).toBeVisible({ timeout: 15_000 })
  const shown = Date.now()

  const failure = assist.getByRole('alert')
  await expect(failure).toContainText(
    'The download of the lyrics aligner isn’t arriving. Check your connection and try again.',
    { timeout: 60_000 },
  )
  expect(Date.now() - shown).toBeGreaterThan(25_000)
  // The Cancel button that had focus is gone; Try again takes focus instead of the page.
  await expect(assist.getByRole('button', { name: 'Try again' })).toBeFocused()

  await assist.getByRole('button', { name: 'Try again' }).click()
  await expect(assist.getByText(ALIGNER_LINE)).toBeVisible({ timeout: 15_000 })
  await assist.getByRole('button', { name: 'Cancel' }).click()
  await expect(assist.getByRole('progressbar', { name: 'Lyrics progress' })).toHaveCount(0)
  await expect(assist.getByRole('textbox', { name: 'Lyrics' })).toHaveValue('Neon lights are calling')
})
