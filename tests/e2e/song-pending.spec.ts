import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

/** While the song is analyzed, the editor says so instead of showing placeholder facts or a line past the song. */
test('Inspector › Song and the song lane are honest while the song is not analyzed yet', async ({ page }) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor'
  })
  await waitForPreview(page)
  const facts = page.getByTestId('song-facts')
  await expect(facts).toHaveText('120 BPM · 4/4 · 9 sections')

  // The song loses its analysis, and a song analysis job runs.
  await page.evaluate(() => {
    const { app, shared } = window.mvStudio
    const editor = app.project.editor
    editor.dispatch(
      { type: 'analysis.removeAudio', assetId: editor.getProject().songAssetId },
      { history: 'skip' },
    )
    const w = window as unknown as { finishAnalysis?: () => void }
    shared.jobs.run({
      kind: 'analysis.song',
      title: 'Analyzing the song',
      run: () => new Promise<void>((resolve) => (w.finishAnalysis = resolve)),
    })
  })
  await expect(facts).toHaveText('Analyzing the song…')

  // The flat line in the song lane stops where the song ends.
  await page.getByRole('button', { name: 'Fit', exact: true }).click()
  await page.waitForTimeout(300)
  const line = await page.evaluate(() => {
    const clip = document.querySelector<HTMLElement>('[class*="audioClip"]')
    const canvas = clip?.querySelector('canvas')
    const ctx = canvas?.getContext('2d')
    if (!clip || !canvas || !ctx) return null
    const c = canvas.getBoundingClientRect()
    const end = clip.getBoundingClientRect().right - c.left
    const scale = canvas.width / c.width
    const y = Math.floor(canvas.height / 2)
    const alpha = (x: number) => ctx.getImageData(Math.round(x * scale), y, 1, 1).data[3] ?? 0
    return { room: c.width - end, before: alpha(end - 10), after: alpha(end + 10) }
  })
  expect(line).not.toBeNull()
  expect(line!.room).toBeGreaterThan(15)
  expect(line!.before).toBeGreaterThan(0)
  expect(line!.after).toBe(0)

  await page.evaluate(() => (window as unknown as { finishAnalysis: () => void }).finishAnalysis())
  await expect(facts).toHaveText('Not analyzed yet')
})
