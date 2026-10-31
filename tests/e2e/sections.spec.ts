import { expect, openHarness, test, waitForPreview } from './fixtures.ts'

test('a section label guessed from the audio is muted and says "Probably the chorus" until the user renames it', async ({
  page,
}) => {
  await openHarness(page)
  await page.evaluate(() => {
    localStorage.setItem('mv-studio.guide-seen', '1')
    window.location.hash = '#/editor?t=73.6'
  })
  await waitForPreview(page)
  // Labels from the audio alone come with a low confidence.
  await page.evaluate(() => {
    const { editor } = window.mvStudio.app.project
    const project = editor.getProject()
    editor.dispatch(
      {
        type: 'analysis.updateSection',
        assetId: project.songAssetId,
        sectionId: 's-c1',
        patch: { confidence: 0.4 },
      },
      { history: 'skip' },
    )
  })
  const guessed = page.getByRole('button', { name: 'Section Chorus, 1:04 to 1:36' })
  await expect(guessed).toBeVisible()
  await expect(guessed).toHaveAttribute('title', 'Probably the chorus. Double-click to rename.')
  const muted = await guessed
    .getByText('Chorus', { exact: true })
    .evaluate((el) => getComputedStyle(el).color)
  // Selected, the Inspector's header says it is a guess too.
  await guessed.dispatchEvent('pointerdown')
  await expect(page.getByText(/^Probably the chorus · 1:04 – 1:36 · \d+ bars$/)).toBeVisible()

  // Escape leaves the name as it was; Enter keeps what the user typed, which is no longer a guess.
  await guessed.dblclick()
  await page.getByRole('textbox', { name: 'Rename section' }).fill('Drop')
  await page.keyboard.press('Escape')
  await expect(guessed).toBeVisible()
  await guessed.dblclick()
  await page.getByRole('textbox', { name: 'Rename section' }).fill('Hook')
  await page.keyboard.press('Enter')
  const named = page.getByRole('button', { name: 'Section Hook, 1:04 to 1:36' })
  await expect(named).toBeVisible()
  await expect(named).not.toHaveAttribute('title')
  expect(
    await named.getByText('Hook', { exact: true }).evaluate((el) => getComputedStyle(el).color),
  ).not.toBe(muted)
  await named.dispatchEvent('pointerdown')
  await expect(page.getByText(/^Named by you/)).toBeVisible()
  await expect(page.getByText(/^1:04 – 1:36 · \d+ bars$/)).toBeVisible()
})
